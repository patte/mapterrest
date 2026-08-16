import { MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre resolves its worker next to its own import.meta.url, which after
// bundling points at our chunk rather than the package. Let vite emit it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { BASEMAPS, BASEMAP_KEYS, defaultBasemap, isDark, type BasemapKey } from './basemaps';
import {
  DEFAULT_SHADING,
  isRamp,
  rampColor,
  SHADINGS,
  SHADING_KEYS,
  SHADING_LAYER,
  shadingLayer,
  type ShadingKey,
} from './shading';
import { enableCameraAnchor } from './cameraAnchor';
import { trackExposure, visibleRange, type Range } from './exposure';
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

setWorkerUrl(maplibreWorkerUrl);

const BACKDROP_LAYER = 'terrain-backdrop';

/** Only until the basemap is chosen by hand — after that the choice is the user's. */
let followsScheme = !has('basemap');

let basemapKey = readString<BasemapKey>('basemap', defaultBasemap(prefersDark()), BASEMAP_KEYS);
let basemapVisible = readBoolean('basemapVisible', true);
let shadingKey = readString<ShadingKey>('shading', DEFAULT_SHADING, SHADING_KEYS);
let shadingVisible = readBoolean('shadingVisible', true);
let autoExposure = readBoolean('autoExposure', true);
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

if (import.meta.env.DEV) Object.assign(window, { map, choosePivot, projectPoint, visibleRange });

// Independent of the pivot: what a frame costs is a question about the map itself.
let perfDebug: (() => void) | null = null;
function setPerfDebug(on: boolean): void {
  if (on && !perfDebug) perfDebug = enablePerfDebug(map);
  else if (!on && perfDebug) {
    perfDebug();
    perfDebug = null;
  }
}
setPerfDebug(readBoolean('debugPerf', false));

/**
 * `#debugPivot=1` draws the pivot and the grid behind it, whether or not a gesture is
 * running, so the choice can be inspected before committing to a drag.
 */
let pivotDebug: ReturnType<typeof enablePivotDebug> | null = null;
function setPivotDebug(on: boolean): void {
  if (!pivotEnabled) return;
  if (on && !pivotDebug) pivotDebug = enablePivotDebug(map);
  else if (!on && pivotDebug) {
    pivotDebug.disable();
    pivotDebug = null;
  }
}
if (pivotEnabled) {
  const anchor = enableCameraAnchor(map);
  enableShiftDragCamera(map, anchor, (pivot) => pivotDebug?.hold(pivot));
  setPivotDebug(readBoolean('debugPivot', false));
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

  // Exposure first, so the ramp is built pinned to the view rather than repainted after.
  applyExposure();
  applyShading();
  applyBasemapVisibility();
});

/* Basemap ------------------------------------------------------------------ */

const picker = document.getElementById('basemap') as HTMLSelectElement;
for (const key of BASEMAP_KEYS) {
  picker.add(new Option(BASEMAPS[key].label, key, false, key === basemapKey));
}

/** Most basemaps fix the panel's chrome; the ones that read either way defer to the browser. */
function applyChrome(): void {
  document.body.dataset.theme = isDark(basemapKey, prefersDark()) ? 'dark' : 'light';
}

function setBasemap(key: BasemapKey): void {
  if (key === basemapKey) return;
  basemapKey = key;
  picker.value = key;
  applyChrome();
  map.setStyle(BASEMAPS[key].url);
}

picker.addEventListener('change', () => {
  followsScheme = false;
  setBasemap(picker.value as BasemapKey);
  write('basemap', basemapKey);
});

onSchemeChange((dark) => {
  if (followsScheme) setBasemap(defaultBasemap(dark));
  // A hand-picked basemap keeps its style, but its chrome may still track the scheme.
  else applyChrome();
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
  map.addLayer(
    shadingLayer(shadingKey, DEM_SOURCE, BASEMAPS[basemapKey], exposure),
    firstSymbol?.id,
  );
}

const shadingPicker = document.getElementById('shading') as HTMLSelectElement;
for (const key of SHADING_KEYS) {
  shadingPicker.add(new Option(SHADINGS[key], key, false, key === shadingKey));
}
function setShading(key: ShadingKey): void {
  if (key === shadingKey) return;
  shadingKey = key;
  shadingPicker.value = key;
  applyExposure();
  applyShading();
}

shadingPicker.addEventListener('change', () => {
  setShading(shadingPicker.value as ShadingKey);
  write('shading', shadingKey);
});

const shadingBox = document.getElementById('shading-visible') as HTMLInputElement;
shadingBox.checked = shadingVisible;

function setShadingVisible(on: boolean): void {
  if (on === shadingVisible) return;
  shadingVisible = on;
  shadingBox.checked = on;
  applyExposure();
  applyShading();
}

shadingBox.addEventListener('change', () => {
  setShadingVisible(shadingBox.checked);
  write('shadingVisible', shadingVisible);
});

/* Auto-exposure ------------------------------------------------------------- */

const exposureBox = document.getElementById('auto-exposure') as HTMLInputElement;
const exposureRange = document.getElementById('exposure-range')!;

/** The range the ramp is currently pinned to, or null while it spans its own metres. */
let exposure: Range | null = null;
let stopTracking: (() => void) | null = null;

/**
 * Only the ramps have an exposure to set. Hillshade lights the DEM's gradient and never
 * reads an absolute height, so there is nothing for the endpoints to do to it.
 */
function applyExposure(): void {
  const wanted = autoExposure && shadingVisible && isRamp(shadingKey);
  exposureBox.disabled = !isRamp(shadingKey);
  exposureBox.title = isRamp(shadingKey)
    ? 'spread the ramp over the elevations in view'
    : 'hillshade reads slope, not height';

  if (wanted && !stopTracking) {
    stopTracking = trackExposure(map, DEM_SOURCE, (range) => {
      exposure = range;
      exposureRange.textContent = `${Math.round(range.lo)}–${Math.round(range.hi)} m`;
      // Repainting the ramp is ~0.5 ms and leaves the layer in place; re-adding it would
      // drop the tiles already drawn. The layer's own type has to be the test, not the
      // mode it belongs to: tracking starts before the layer is swapped, and asking a
      // hillshade layer for a colour ramp throws.
      if (map.getLayer(SHADING_LAYER)?.type === 'color-relief' && isRamp(shadingKey)) {
        map.setPaintProperty(SHADING_LAYER, 'color-relief-color', rampColor(shadingKey, range));
      }
    });
  } else if (!wanted && stopTracking) {
    stopTracking();
    stopTracking = null;
    exposure = null;
    exposureRange.textContent = '';
  }
}

function setAutoExposure(on: boolean): void {
  if (on === autoExposure) return;
  autoExposure = on;
  exposureBox.checked = on;
  applyExposure();
  applyShading();
}

exposureBox.checked = autoExposure;
exposureBox.addEventListener('change', () => {
  setAutoExposure(exposureBox.checked);
  write('autoExposure', autoExposure);
});

/* Exaggeration ------------------------------------------------------------- */

const slider = document.getElementById('exaggeration') as HTMLInputElement;
const sliderValue = document.getElementById('exaggeration-value')!;
slider.max = String(MAX_EXAGGERATION);
slider.value = String(exaggeration);
sliderValue.textContent = exaggeration.toFixed(1) + '×';

let terrainFrame = 0;
function setExaggeration(value: number): void {
  if (value === exaggeration) return;
  exaggeration = value;
  slider.value = String(value);
  sliderValue.textContent = value.toFixed(1) + '×';
  // setTerrain tears down and rebuilds the terrain and its render-to-texture cache, and
  // the camera anchor re-settles on the 'terrain' event it fires — at most one per frame.
  terrainFrame ||= requestAnimationFrame(() => {
    terrainFrame = 0;
    if (map.getTerrain()) map.setTerrain({ source: DEM_SOURCE, exaggeration });
  });
}

let writeTimer: number | undefined;
slider.addEventListener('input', () => {
  setExaggeration(Number(slider.value));
  // MapLibre throttles its own hash writer to 300 ms; Safari refuses more than 100
  // replaceState calls per 30 s, which an unthrottled drag exceeds. Only the hash
  // trails — the terrain above is already current.
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => write('exaggeration', exaggeration), 300);
});

/* Hash edits ---------------------------------------------------------------- */

/**
 * Editing the hash by hand is a same-document navigation: nothing reloads, the browser
 * fires `hashchange`, and MapLibre reads only its own `map` param out of it. This
 * applies the rest. Programmatic writes never land here — both hash writers use
 * replaceState, which fires no event — and every setter above no-ops on an unchanged
 * value, so a running map is only touched where the hash actually differs.
 */
function applyHash(): void {
  // Construction-time choices: tileSize only counts on a source declared at style.load,
  // and the ground pin is a Map option. A reload is the only honest apply.
  if (
    readString('detail', DEFAULT_DETAIL, DETAIL_LEVELS) !== detail ||
    readBoolean('pivot', true) !== pivotEnabled
  ) {
    location.reload();
    return;
  }
  followsScheme = !has('basemap');
  setBasemap(readString('basemap', defaultBasemap(prefersDark()), BASEMAP_KEYS));
  setShading(readString('shading', DEFAULT_SHADING, SHADING_KEYS));
  setShadingVisible(readBoolean('shadingVisible', true));
  setAutoExposure(readBoolean('autoExposure', true));
  setExaggeration(readNumber('exaggeration', DEFAULT_EXAGGERATION, 0, MAX_EXAGGERATION));
  setPerfDebug(readBoolean('debugPerf', false));
  setPivotDebug(readBoolean('debugPivot', false));
}
window.addEventListener('hashchange', applyHash);

/* Panel ---------------------------------------------------------------------*/

const toggle = document.getElementById('panel-toggle') as HTMLButtonElement;
toggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  toggle.setAttribute('aria-expanded', String(open));
});

applyChrome();
