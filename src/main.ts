import { MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import { setupAbout } from './about';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre resolves its worker next to its own import.meta.url, which after
// bundling points at our chunk rather than the package. Let vite emit it.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { BASEMAPS, BASEMAP_KEYS, defaultBasemap, isDark, isMapTiler, type BasemapKey } from './basemaps';
import { DEFAULT_SHADING, defaultExposed, isRamp, SHADING_KEYS, type ShadingKey } from './shading';
import { attachScene, type SceneSpec } from './scene';
import { createThumbnailer, type ThumbVariant } from './thumbnails';
import { createTray, CURRENT_TILE, tileId } from './tray';
import { enableCameraAnchor, type CameraAnchor } from './cameraAnchor';
import { setupLogos } from './logos';
import { setupScreenshot } from './screenshot';
import { trackExposure, visibleRange, type Range } from './exposure';
import { choosePivot, projectPoint } from './pivot';
import { enablePerfDebug } from './perfDebug';
import { enablePivotDebug } from './pivotDebug';
import { enableShiftDragCamera } from './shiftDragCamera';
import { setupGeosearch } from './geosearch';
import { maptilerSuffix, showNotice } from './notice';
import { onSchemeChange, prefersDark } from './theme';
import {
  DEFAULT_DETAIL,
  DEFAULT_TERRAIN_SCALE,
  DEM_SOURCE,
  DETAIL_LEVELS,
  MAX_TERRAIN_SCALE,
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
/** Only until the box is toggled by hand — until then exposure follows each ramp's default. */
let autoExposureChosen = has('autoExposure');
let autoExposure = readBoolean('autoExposure', defaultExposed(shadingKey));
let terrainScale = readNumber('terrainScale', DEFAULT_TERRAIN_SCALE, 0, MAX_TERRAIN_SCALE);
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
  // Screenshots re-render at print density (A3 @ 300dpi needs ~5k×3.5k inside the
  // crop); the default cap is 4096². MapLibre steps back down to what the GPU
  // actually allocates, so this only lifts the artificial ceiling.
  maxCanvasSize: [16384, 16384],
});

const scene = attachScene(
  map,
  { basemap: basemapKey, basemapVisible, shading: shadingKey, shadingVisible, exposure: null, terrainScale },
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
let anchor: CameraAnchor | null = null;
if (pivotEnabled) {
  anchor = enableCameraAnchor(map);
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

const about = setupAbout();

/** Latches on the first query: attribution for the session's geocoding use. */
let searchedMapTiler = false;
setupGeosearch(map, () => {
  if (searchedMapTiler) return;
  searchedMapTiler = true;
  applyLogos();
});

/* MapTiler errors ------------------------------------------------------------ */

// A failing style fans out into an error per tile; one notice a minute is plenty.
let mapTilerNoticeAt = 0;
map.on('error', (e) => {
  const err = e.error as Error & { url?: string; status?: number; body?: Blob };
  if (typeof err?.url === 'string' && err.url.includes('api.maptiler.com')) {
    const now = Date.now();
    if (now - mapTilerNoticeAt < 60000) return;
    mapTilerNoticeAt = now;
    // The suffix reads the response body (an AJAXError carries it as a Blob) to tell
    // an invalid key from limits — see maptilerSuffix.
    void (async () => {
      const body = err.body instanceof Blob ? await err.body.text().catch(() => '') : '';
      const status = typeof err.status === 'number' ? ` (HTTP ${err.status})` : '';
      showNotice(`the MapTiler basemap failed to load${status}${maptilerSuffix(err.status ?? 0, body)}`);
    })();
  } else {
    // Subscribing to 'error' silences MapLibre's own console reporting; everything not
    // handled here still belongs in the console.
    console.error(e.error);
  }
});

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
  applyLogos();
}

function setBasemapVisible(on: boolean): void {
  if (on === basemapVisible) return;
  basemapVisible = on;
  scene.set({ basemapVisible: on });
  syncTray();
  applyLogos();
}

onSchemeChange((dark) => {
  if (followsScheme) setBasemap(defaultBasemap(dark));
  // A hand-picked basemap keeps its style, but its chrome may still track the scheme.
  else applyChrome();
});

function setShading(key: ShadingKey): void {
  if (key === shadingKey) return;
  shadingKey = key;
  if (!autoExposureChosen) {
    autoExposure = defaultExposed(key);
    exposureBox.checked = autoExposure;
  }
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
  applyLogos();
}

/* Auto-exposure ------------------------------------------------------------- */

const exposureBox = document.getElementById('auto-exposure') as HTMLInputElement;
const exposureRow = exposureBox.parentElement as HTMLElement;
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
  // The pill shows only while a ramp is on screen — for hillshade or no shading there
  // is no exposure to offer, so the row disappears rather than sitting greyed out.
  exposureRow.hidden = !(shadingVisible && isRamp(shadingKey));
  exposureBox.title = 'spread the ramp over the elevations in view';

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
  autoExposureChosen = true;
  setAutoExposure(exposureBox.checked);
  write('autoExposure', autoExposure);
});

// Ephemeral, unlike About — an explainer, not a place to link into, so no hash entry.
const exposureDialog = document.getElementById('exposure-dialog') as HTMLDialogElement;
document.getElementById('exposure-info')!.addEventListener('click', () => exposureDialog.showModal());
document.getElementById('exposure-close')!.addEventListener('click', () => exposureDialog.close());
exposureDialog.addEventListener('click', (e) => {
  if (e.target === exposureDialog) exposureDialog.close();
});

// Before the first style lands, so the initial shading layer is built already pinned to
// the view rather than repainted after.
applyExposure();

/* Terrain scale ------------------------------------------------------------- */

const slider = document.getElementById('terrain-scale') as HTMLInputElement;
const sliderValue = document.getElementById('terrain-scale-value')!;
slider.max = String(MAX_TERRAIN_SCALE);
slider.value = String(terrainScale);
sliderValue.textContent = terrainScale.toFixed(1) + '×';

function setTerrainScale(value: number): void {
  if (value === terrainScale) return;
  terrainScale = value;
  slider.value = String(value);
  sliderValue.textContent = value.toFixed(1) + '×';
  scene.set({ terrainScale: value });
  applyLogos();
}

let writeTimer: number | undefined;
slider.addEventListener('input', () => {
  setTerrainScale(Number(slider.value));
  // MapLibre throttles its own hash writer to 300 ms; Safari refuses more than 100
  // replaceState calls per 30 s, which an unthrottled drag exceeds. Only the hash
  // trails — the terrain above is already current.
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => write('terrainScale', terrainScale), 300);
});

/* Logos ---------------------------------------------------------------------- */

const logos = setupLogos(document.querySelector('.maplibregl-ctrl-bottom-right')!);
function applyLogos(): void {
  logos.update({
    mapterhorn: terrainScale > 0 || shadingVisible,
    maptiler: isMapTiler(basemapKey) && basemapVisible,
    maptilerSearch: searchedMapTiler,
  });
}
applyLogos();

/* Screenshots ---------------------------------------------------------------- */

setupScreenshot(map, anchor);

/* Corner conflict ------------------------------------------------------------ */

// The card and the attribution share the bottom edge. Where the viewport fits both
// expanded they coexist; where it does not, the one just opened wins and the other
// gives way. MapLibre's attribution is a <details> whose compact-show class is its
// expanded state, toggled by its own ⓘ summary.
const attrib = document.querySelector('.maplibregl-ctrl-attrib') as HTMLElement;
const card = document.getElementById('card')!;
const attribExpanded = (): boolean => attrib.classList.contains('maplibregl-compact-show');
function collapseAttrib(): void {
  if (attribExpanded()) {
    (attrib.querySelector('.maplibregl-ctrl-attrib-button') as HTMLElement).click();
  }
}
function cornerConflict(): boolean {
  if (!tray.open() || !attribExpanded()) return false;
  const a = card.getBoundingClientRect();
  const b = attrib.getBoundingClientRect();
  return a.right + 8 > b.left && a.bottom > b.top;
}
// The folded stack cannot yield the way the card does — the tile is already the
// collapsed form — so where the expanded attribution would run under it (phones, where
// MapLibre auto-expands its credits at load), a clearance lifts the tile and the pill
// above the strip and drops them back when it collapses.
const settingsTile = document.getElementById('tray-tile')!;
let clearance = 0;
function tileConflict(): boolean {
  if (tray.open() || !attribExpanded()) return false;
  const t = settingsTile.getBoundingClientRect();
  const b = attrib.getBoundingClientRect();
  // t is measured wherever the current clearance put it; compare at rest.
  return t.right + 8 > b.left && t.bottom + clearance > b.top;
}
function applyClearance(): void {
  const next = tileConflict() ? Math.round(attrib.getBoundingClientRect().height) + 6 : 0;
  if (next === clearance) return;
  clearance = next;
  document.body.style.setProperty('--attrib-clearance', `${next}px`);
}
tray.onOpenChange(() => {
  if (cornerConflict()) collapseAttrib();
  applyClearance();
});
// Only the ⓘ expresses a wish for the attribution, and there the card yields. The
// geometry cannot be read inside the click: MapLibre's toggle drops the <details>'
// open attribute and the browser's default action restores it only after every
// listener has run, so a synchronous rect is the closed pill's. Hence the frame's
// wait — and the flag, or the observer below would win the microtask race and
// collapse what the user just opened.
let attribClicked = false;
attrib.querySelector('.maplibregl-ctrl-attrib-button')!.addEventListener('click', () => {
  attribClicked = true;
  requestAnimationFrame(() => {
    attribClicked = false;
    if (cornerConflict()) tray.close();
    // The observer's applyClearance ran before the box reopened; remeasure.
    applyClearance();
  });
});
// Everything else — MapLibre auto-expanding at load, credits widening as sources
// land, a window resize — is ambient, and there the card wins.
new MutationObserver(() => {
  if (!attribClicked && cornerConflict()) collapseAttrib();
  applyClearance();
}).observe(attrib, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
window.addEventListener('resize', () => {
  if (cornerConflict()) collapseAttrib();
  applyClearance();
});
applyClearance();

/* Thumbnails ----------------------------------------------------------------- */

/** False until a first preview has landed — empty tiles get eagerness, not patience. */
let thumbsPrimed = false;

const thumbs = createThumbnailer(map, {
  onImage: (id, url) => {
    thumbsPrimed = true;
    tray.setImage(id, url);
  },
  // Folded is not invisible: the settings tile still previews the view, so only a
  // hidden tab stops the walk.
  visible: () => !document.hidden,
});

/**
 * Every tile as a SceneSpec against the current selection: the shading row over the
 * current basemap, the basemap row under the current shading. Identical specs — the
 * selected pair sits in both rows — render once and land on every tile sharing them.
 * Ramp previews freeze the exposure they would get if selected — an untouched toggle
 * follows each ramp's default — measured once here rather than tracked while the walk runs.
 */
function thumbVariants(): ThumbVariant[] {
  const current = scene.spec();
  const frozen = exposure ?? visibleRange(map, DEM_SOURCE);
  const autoFor = (key: ShadingKey): boolean =>
    autoExposureChosen ? autoExposure : defaultExposed(key);
  const forRamp = (key: ShadingKey): Range | null => (isRamp(key) && autoFor(key) ? frozen : null);
  const variants = new Map<string, ThumbVariant>();
  const add = (id: string, spec: SceneSpec): void => {
    const key = JSON.stringify(spec);
    const seen = variants.get(key);
    if (seen) seen.ids.push(id);
    else variants.set(key, { ids: [id], spec });
  };
  // The settings tile previews the view itself — first because it is the cheapest
  // (no style swap), and folded it is the only render there is.
  const shownRamp = current.shadingVisible ? forRamp(current.shading) : null;
  add(CURRENT_TILE, { ...current, exposure: shownRamp });
  if (!tray.open()) return [...variants.values()];
  // The shading row next: it shares the mini map's current style, so the whole row is
  // layer swaps before the basemap row starts paying a setStyle per tile.
  add(tileId('s', null), { ...current, shadingVisible: false, exposure: null });
  for (const key of SHADING_KEYS) {
    add(tileId('s', key), { ...current, shading: key, shadingVisible: true, exposure: forRamp(key) });
  }
  add(tileId('b', null), { ...current, basemapVisible: false, exposure: shownRamp });
  for (const key of BASEMAP_KEYS) {
    add(tileId('b', key), { ...current, basemap: key, basemapVisible: true, exposure: shownRamp });
  }
  return [...variants.values()];
}

/** Seconds of stillness after the map settles before the walk spends anything. */
const THUMB_DELAY = 3000;
/** Opening the tray or returning to the tab asks for previews, not for patience. */
const THUMB_QUICK = 250;

let thumbTimer: number | undefined;
function scheduleThumbs(delay = THUMB_DELAY): void {
  window.clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    if (document.hidden) return;
    thumbs.refresh(thumbVariants());
  }, thumbsPrimed ? delay : THUMB_QUICK);
}
// 'idle' covers every trigger there is: a camera that settles, a control that changed
// the scene, an exposure ease that finished — each dirties the map and idles after.
map.on('idle', () => scheduleThumbs());
// A moving camera takes it all back: the pending refresh, the walk in flight, the
// retry — nothing renders or fetches against a view that is already gone.
map.on('movestart', () => {
  window.clearTimeout(thumbTimer);
  thumbs.cancel();
});
tray.onOpenChange(() => scheduleThumbs(THUMB_QUICK));
document.addEventListener('visibilitychange', () => scheduleThumbs(THUMB_QUICK));

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
  autoExposureChosen = has('autoExposure');
  setBasemap(readString('basemap', defaultBasemap(prefersDark()), BASEMAP_KEYS));
  setBasemapVisible(readBoolean('basemapVisible', true));
  setShading(readString('shading', DEFAULT_SHADING, SHADING_KEYS));
  setShadingVisible(readBoolean('shadingVisible', true));
  setAutoExposure(readBoolean('autoExposure', defaultExposed(shadingKey)));
  setTerrainScale(readNumber('terrainScale', DEFAULT_TERRAIN_SCALE, 0, MAX_TERRAIN_SCALE));
  setPerfDebug(readBoolean('debugPerf', false));
  setPivotDebug(readBoolean('debugPivot', false));
  tray.setForceCollapsed(readBoolean('collapsed', false));
  about.setOpen(readBoolean('about', false));
}
window.addEventListener('hashchange', applyHash);

applyChrome();
