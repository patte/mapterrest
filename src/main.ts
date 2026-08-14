import { MapLibreMap, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BASEMAPS, BASEMAP_KEYS, defaultBasemap, isDark, type BasemapKey } from './basemaps';
import {
  DEFAULT_SHADING,
  SHADINGS,
  SHADING_KEYS,
  SHADING_LAYER,
  shadingLayer,
  type ShadingKey,
} from './shading';
import { enableCameraAnchor } from './cameraAnchor';
import { choosePivot, projectPoint } from './pivot';
import { enablePerfDebug } from './perfDebug';
import { enablePivotDebug } from './pivotDebug';
import { enableShiftDragCamera } from './shiftDragCamera';
import { onSchemeChange, prefersDark } from './theme';
import {
  DEFAULT_DETAIL,
  DEFAULT_EXAGGERATION,
  DEM_SOURCE,
  DETAIL_LEVELS,
  demSource,
  MAX_EXAGGERATION,
  MAX_ZOOM_LEVELS_ON_SCREEN,
  TILE_COUNT_MAX_MIN_RATIO,
  usesLodParams,
  type Detail,
} from './terrain';
import { has, MAP_HASH_KEY, readBoolean, readNumber, readString, write } from './urlState';

const BACKDROP_LAYER = 'terrain-backdrop';

/** Only until the basemap is chosen by hand — after that the choice is the user's. */
let followsScheme = !has('basemap');

let basemapKey = readString<BasemapKey>('basemap', defaultBasemap(prefersDark()), BASEMAP_KEYS);
let basemapVisible = readBoolean('basemapVisible', true);
let shadingKey = readString<ShadingKey>('shading', DEFAULT_SHADING, SHADING_KEYS);
let shadingVisible = readBoolean('shadingVisible', true);
let exaggeration = readNumber('exaggeration', DEFAULT_EXAGGERATION, 0, MAX_EXAGGERATION);
const detail = readString<Detail>('detail', DEFAULT_DETAIL, DETAIL_LEVELS);
/**
 * `#pivot=0` hands the camera back to MapLibre entirely — its own ground pin, no anchor,
 * no shift+drag orbit — so anything the map does can be told apart from what this stack
 * does to it. Load-time, because the pin is a construction option.
 */
const pivotEnabled = readBoolean('pivot', true);

const map = new MapLibreMap({
  container: 'map',
  style: BASEMAPS[basemapKey].url,
  // Down the Zermatt valley with the Matterhorn's north face ahead — the sharpest
  // relief Mapterhorn carries, since Switzerland reaches z17 on swissALTI3D.
  center: [7.7, 46.005],
  zoom: 12.6,
  pitch: 78,
  bearing: 225,
  // MapLibre allows up to 180; 90 is the camera lying flat on the horizon.
  maxPitch: 90,
  // The pin re-clamps the centre's elevation to the DEM every frame and every terrain
  // tile, moving the camera by the difference — measured as kilometre teleports mid-wheel
  // and on release at high pitch. cameraAnchor.ts anchors instead, so it is off with it.
  centerClampedToGround: !pivotEnabled,
  // Named so the camera occupies one hash param and leaves room for the controls.
  hash: MAP_HASH_KEY,
});

if (import.meta.env.DEV) Object.assign(window, { map, choosePivot, projectPoint });

// Independent of the pivot: what a frame costs is a question about the map itself.
if (readBoolean('debugPerf', false)) enablePerfDebug(map);

if (pivotEnabled) {
  const anchor = enableCameraAnchor(map);
  // `#debugPivot=1` draws the pivot and the grid behind it, whether or not a gesture is
  // running, so the choice can be inspected before committing to a drag.
  const pivotDebug = readBoolean('debugPivot', false) ? enablePivotDebug(map) : null;
  enableShiftDragCamera(map, anchor, (pivot) => pivotDebug?.hold(pivot));
}
map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');

/**
 * setStyle() replaces sources, layers, terrain and sky wholesale, so everything the
 * terrain contributes is re-attached here. `style.load` fires on the initial load and
 * on every subsequent style change.
 */
map.on('style.load', () => {
  const basemap = BASEMAPS[basemapKey];

  map.addSource(DEM_SOURCE, demSource(detail));
  if (usesLodParams(detail)) {
    map.setSourceTileLodParams(MAX_ZOOM_LEVELS_ON_SCREEN, TILE_COUNT_MAX_MIN_RATIO, DEM_SOURCE);
  }
  map.setTerrain({ source: DEM_SOURCE, exaggeration });
  map.setSky(basemap.sky);

  // Above the style's own background, so it covers it once the basemap goes.
  map.addLayer(
    { id: BACKDROP_LAYER, type: 'background', paint: { 'background-color': basemap.backdrop } },
    map.getStyle().layers[1]?.id,
  );

  applyShading();
  applyBasemapVisibility();
});

/* Basemap ------------------------------------------------------------------ */

const picker = document.getElementById('basemap') as HTMLSelectElement;
for (const key of BASEMAP_KEYS) {
  picker.add(new Option(BASEMAPS[key].label, key, false, key === basemapKey));
}

function setBasemap(key: BasemapKey): void {
  basemapKey = key;
  picker.value = key;
  document.body.dataset.theme = isDark(key) ? 'dark' : 'light';
  map.setStyle(BASEMAPS[key].url);
}

picker.addEventListener('change', () => {
  followsScheme = false;
  setBasemap(picker.value as BasemapKey);
  write('basemap', basemapKey);
});

onSchemeChange((dark) => {
  if (followsScheme) setBasemap(defaultBasemap(dark));
});

/**
 * Background layers stay on: MapLibre hangs vertical skirts off every terrain tile
 * edge to cover LOD seams, and over a see-through drape those skirts smear the edge
 * pixels into grey curtains between tiles. The backdrop then replaces the style's
 * near-black or paper-white ground with a mid tone the relief reads against.
 */
function applyBasemapVisibility(): void {
  for (const layer of map.getStyle().layers) {
    if (layer.id === SHADING_LAYER || layer.type === 'background') continue;
    map.setLayoutProperty(layer.id, 'visibility', basemapVisible ? 'visible' : 'none');
  }
  map.setLayoutProperty(BACKDROP_LAYER, 'visibility', basemapVisible ? 'none' : 'visible');
}

const basemapBox = document.getElementById('basemap-visible') as HTMLInputElement;
basemapBox.checked = basemapVisible;
basemapBox.addEventListener('change', () => {
  basemapVisible = basemapBox.checked;
  applyBasemapVisibility();
  write('basemapVisible', basemapVisible);
});

/* Shading ------------------------------------------------------------------ */

/** Relief belongs under the basemap's symbols, or place names sit behind the ramp. */
function applyShading(): void {
  if (map.getLayer(SHADING_LAYER)) map.removeLayer(SHADING_LAYER);
  if (!shadingVisible) return;
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol');
  map.addLayer(shadingLayer(shadingKey, DEM_SOURCE, BASEMAPS[basemapKey]), firstSymbol?.id);
}

const shadingPicker = document.getElementById('shading') as HTMLSelectElement;
for (const key of SHADING_KEYS) {
  shadingPicker.add(new Option(SHADINGS[key], key, false, key === shadingKey));
}
shadingPicker.addEventListener('change', () => {
  shadingKey = shadingPicker.value as ShadingKey;
  applyShading();
  write('shading', shadingKey);
});

const shadingBox = document.getElementById('shading-visible') as HTMLInputElement;
shadingBox.checked = shadingVisible;
shadingBox.addEventListener('change', () => {
  shadingVisible = shadingBox.checked;
  applyShading();
  write('shadingVisible', shadingVisible);
});

/* Exaggeration ------------------------------------------------------------- */

const slider = document.getElementById('exaggeration') as HTMLInputElement;
const sliderValue = document.getElementById('exaggeration-value')!;
slider.max = String(MAX_EXAGGERATION);
slider.value = String(exaggeration);
sliderValue.textContent = exaggeration.toFixed(1) + '×';

slider.addEventListener('input', () => {
  exaggeration = Number(slider.value);
  sliderValue.textContent = exaggeration.toFixed(1) + '×';
  if (map.getTerrain()) map.setTerrain({ source: DEM_SOURCE, exaggeration });
  write('exaggeration', exaggeration);
});

/* Panel ---------------------------------------------------------------------*/

const toggle = document.getElementById('panel-toggle') as HTMLButtonElement;
toggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  toggle.setAttribute('aria-expanded', String(open));
});

document.body.dataset.theme = isDark(basemapKey) ? 'dark' : 'light';
