import { MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre resolves its worker next to its own import.meta.url, which after
// bundling points at our chunk rather than the package. Let vite emit it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { BASEMAPS, BASEMAP_KEYS, defaultBasemap, isDark, type BasemapKey } from './basemaps';
import { DEFAULT_SHADING, isRamp, SHADING_KEYS, type ShadingKey } from './shading';
import { attachScene, type SceneSpec } from './scene';
import { createThumbnailer, type ThumbVariant } from './thumbnails';
import { createTray, tileId } from './tray';
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
  MAX_EXAGGERATION,
  type Detail,
} from './terrain';
import { has, MAP_HASH_KEY, readBoolean, readNumber, readString, write } from './urlState';

setWorkerUrl(maplibreWorkerUrl);

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

const scene = attachScene(
  map,
  { basemap: basemapKey, basemapVisible, shading: shadingKey, shadingVisible, exposure: null, exaggeration },
  detail,
);

if (import.meta.env.DEV) Object.assign(window, { map, choosePivot, projectPoint, visibleRange });

/* Debug overlays ------------------------------------------------------------ */

const perfBox = document.getElementById('debug-perf') as HTMLInputElement;
const pivotBox = document.getElementById('debug-pivot') as HTMLInputElement;

// Independent of the pivot: what a frame costs is a question about the map itself.
let perfDebug: (() => void) | null = null;
function setPerfDebug(on: boolean): void {
  perfBox.checked = on;
  if (on && !perfDebug) perfDebug = enablePerfDebug(map);
  else if (!on && perfDebug) {
    perfDebug();
    perfDebug = null;
  }
}
setPerfDebug(readBoolean('debugPerf', false));
perfBox.addEventListener('change', () => {
  setPerfDebug(perfBox.checked);
  write('debugPerf', perfBox.checked);
});

/**
 * `#debugPivot=1` draws the pivot and the grid behind it, whether or not a gesture is
 * running, so the choice can be inspected before committing to a drag.
 */
let pivotDebug: ReturnType<typeof enablePivotDebug> | null = null;
function setPivotDebug(on: boolean): void {
  if (!pivotEnabled) return;
  pivotBox.checked = on;
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
  pivotBox.addEventListener('change', () => {
    setPivotDebug(pivotBox.checked);
    write('debugPivot', pivotBox.checked);
  });
} else {
  pivotBox.disabled = true;
  pivotBox.title = '#pivot=0 hands the camera to MapLibre — there is no pivot to draw';
}
map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');

/* Basemap & shading tiles ---------------------------------------------------- */

const tray = createTray(readBoolean('collapsed', false), {
  onBasemap(key) {
    if (key === null) {
      if (basemapVisible) {
        setBasemapVisible(false);
        write('basemapVisible', false);
      }
      return;
    }
    followsScheme = false;
    if (!basemapVisible) {
      setBasemapVisible(true);
      write('basemapVisible', true);
    }
    setBasemap(key);
    write('basemap', key);
  },
  onShading(key) {
    if (key === null) {
      if (shadingVisible) {
        setShadingVisible(false);
        write('shadingVisible', false);
      }
      return;
    }
    if (!shadingVisible) {
      setShadingVisible(true);
      write('shadingVisible', true);
    }
    setShading(key);
    write('shading', key);
  },
});

function syncTray(): void {
  tray.select({ basemap: basemapKey, basemapVisible, shading: shadingKey, shadingVisible });
}
syncTray();

/** Most basemaps fix the panel's chrome; the ones that read either way defer to the browser. */
function applyChrome(): void {
  document.body.dataset.theme = isDark(basemapKey, prefersDark()) ? 'dark' : 'light';
}

function setBasemap(key: BasemapKey): void {
  if (key === basemapKey) return;
  basemapKey = key;
  applyChrome();
  scene.set({ basemap: key });
  syncTray();
}

function setBasemapVisible(on: boolean): void {
  if (on === basemapVisible) return;
  basemapVisible = on;
  scene.set({ basemapVisible: on });
  syncTray();
}

onSchemeChange((dark) => {
  if (followsScheme) setBasemap(defaultBasemap(dark));
  // A hand-picked basemap keeps its style, but its chrome may still track the scheme.
  else applyChrome();
});

function setShading(key: ShadingKey): void {
  if (key === shadingKey) return;
  shadingKey = key;
  applyExposure();
  scene.set({ shading: key, exposure });
  syncTray();
}

function setShadingVisible(on: boolean): void {
  if (on === shadingVisible) return;
  shadingVisible = on;
  applyExposure();
  scene.set({ shadingVisible: on, exposure });
  syncTray();
}

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
      scene.set({ exposure: range });
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
  scene.set({ exposure });
}

exposureBox.checked = autoExposure;
exposureBox.addEventListener('change', () => {
  setAutoExposure(exposureBox.checked);
  write('autoExposure', autoExposure);
});

// Before the first style lands, so the initial shading layer is built already pinned to
// the view rather than repainted after.
applyExposure();

/* Exaggeration ------------------------------------------------------------- */

const slider = document.getElementById('exaggeration') as HTMLInputElement;
const sliderValue = document.getElementById('exaggeration-value')!;
slider.max = String(MAX_EXAGGERATION);
slider.value = String(exaggeration);
sliderValue.textContent = exaggeration.toFixed(1) + '×';

function setExaggeration(value: number): void {
  if (value === exaggeration) return;
  exaggeration = value;
  slider.value = String(value);
  sliderValue.textContent = value.toFixed(1) + '×';
  scene.set({ exaggeration: value });
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

/* Thumbnails ----------------------------------------------------------------- */

const thumbs = createThumbnailer(map, {
  onImage: (id, url) => tray.setImage(id, url),
  visible: () => tray.visible() && !document.hidden,
});

/**
 * Every tile as a SceneSpec against the current selection: the shading row over the
 * current basemap, the basemap row under the current shading. Identical specs — the
 * selected pair sits in both rows — render once and land on every tile sharing them.
 * Ramp previews freeze the exposure the main view would give them, measured once here
 * rather than tracked while the walk runs.
 */
function thumbVariants(): ThumbVariant[] {
  const current = scene.spec();
  const frozen = autoExposure ? (exposure ?? visibleRange(map, DEM_SOURCE)) : null;
  const forRamp = (key: ShadingKey): Range | null => (isRamp(key) ? frozen : null);
  const variants = new Map<string, ThumbVariant>();
  const add = (id: string, spec: SceneSpec): void => {
    const key = JSON.stringify(spec);
    const seen = variants.get(key);
    if (seen) seen.ids.push(id);
    else variants.set(key, { ids: [id], spec });
  };
  // The shading row first: it shares the mini map's current style, so the whole row is
  // layer swaps before the basemap row starts paying a setStyle per tile.
  add(tileId('s', null), { ...current, shadingVisible: false, exposure: null });
  for (const key of SHADING_KEYS) {
    add(tileId('s', key), { ...current, shading: key, shadingVisible: true, exposure: forRamp(key) });
  }
  const shownRamp = current.shadingVisible ? forRamp(current.shading) : null;
  add(tileId('b', null), { ...current, basemapVisible: false, exposure: shownRamp });
  for (const key of BASEMAP_KEYS) {
    add(tileId('b', key), { ...current, basemap: key, basemapVisible: true, exposure: shownRamp });
  }
  return [...variants.values()];
}

let thumbTimer: number | undefined;
function scheduleThumbs(): void {
  window.clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    if (!tray.visible() || document.hidden) return;
    thumbs.refresh(thumbVariants());
  }, 200);
}
// 'idle' covers every trigger there is: a camera that settles, a control that changed
// the scene, an exposure ease that finished — each dirties the map and idles after.
map.on('idle', scheduleThumbs);
tray.onVisibleChange(scheduleThumbs);
document.addEventListener('visibilitychange', scheduleThumbs);

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
  setBasemapVisible(readBoolean('basemapVisible', true));
  setShading(readString('shading', DEFAULT_SHADING, SHADING_KEYS));
  setShadingVisible(readBoolean('shadingVisible', true));
  setAutoExposure(readBoolean('autoExposure', true));
  setExaggeration(readNumber('exaggeration', DEFAULT_EXAGGERATION, 0, MAX_EXAGGERATION));
  setPerfDebug(readBoolean('debugPerf', false));
  setPivotDebug(readBoolean('debugPivot', false));
  tray.setForceCollapsed(readBoolean('collapsed', false));
}
window.addEventListener('hashchange', applyHash);

applyChrome();
