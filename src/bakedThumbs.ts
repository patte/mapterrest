import type { SceneSpec } from './scene';
import { BAKED_THUMBS } from './assets/thumbs/manifest';

/**
 * One entry of the checked-in bake (`pnpm bake:thumbs`): a tray preview rendered at the
 * default view, matched here against what the walk is about to render. The spec fields
 * are plain strings rather than the app's key unions so a bake that outlives a renamed
 * basemap or shading merely stops matching instead of failing the build.
 */
export type BakedThumb = {
  spec: {
    basemap: string;
    basemapVisible: boolean;
    shading: string;
    shadingVisible: boolean;
    exposure: { lo: number; hi: number } | null;
    terrainScale: number;
  };
  /** lng, lat, zoom, pitch, bearing at bake time. */
  camera: number[];
  url: string;
};

/**
 * Matching is semantic, not byte-exact: the camera anchor settles the default view a
 * hair off the constructor constants, and a ramp's auto-exposure range follows the
 * viewport. At 96px and four zoom levels out, none of these tolerances is visible;
 * anything outside them is a genuinely different render and falls back to live.
 */
const LNG_LAT_EPS = 1e-3;
const ZOOM_EPS = 0.05;
const ANGLE_EPS = 0.5;
/** Per endpoint, as a fraction of the baked range's span. */
const EXPOSURE_TOLERANCE = 0.2;

const cameraClose = (a: number[], b: number[]): boolean =>
  Math.abs(a[0] - b[0]) <= LNG_LAT_EPS &&
  Math.abs(a[1] - b[1]) <= LNG_LAT_EPS &&
  Math.abs(a[2] - b[2]) <= ZOOM_EPS &&
  Math.abs(a[3] - b[3]) <= ANGLE_EPS &&
  Math.abs(a[4] - b[4]) <= ANGLE_EPS;

const exposureClose = (a: SceneSpec['exposure'], b: BakedThumb['spec']['exposure']): boolean => {
  if (a === null || b === null) return a === b;
  const slack = (b.hi - b.lo) * EXPOSURE_TOLERANCE;
  return Math.abs(a.lo - b.lo) <= slack && Math.abs(a.hi - b.hi) <= slack;
};

const specMatches = (spec: SceneSpec, baked: BakedThumb['spec'], anyExposure: boolean): boolean =>
  spec.basemap === baked.basemap &&
  spec.basemapVisible === baked.basemapVisible &&
  spec.shading === baked.shading &&
  spec.shadingVisible === baked.shadingVisible &&
  spec.terrainScale === baked.terrainScale &&
  (anyExposure || exposureClose(spec.exposure, baked.exposure));

/** The baked image for exactly this render, or null to render live. */
export const bakedThumb = (spec: SceneSpec, camera: number[]): string | null =>
  BAKED_THUMBS.find((b) => specMatches(spec, b.spec, false) && cameraClose(camera, b.camera))
    ?.url ?? null;

/**
 * Startup stand-in for `spec`, before the walk confirms anything: exposure is ignored
 * because a ramp's range needs loaded DEM tiles to compute, and the camera because the
 * caller has already established the hash carries none. A stand-in the walk then
 * disowns is simply replaced by its live render.
 */
export const bakedPlaceholder = (spec: SceneSpec): string | null =>
  BAKED_THUMBS.find((b) => specMatches(spec, b.spec, true))?.url ?? null;
