import type { RasterDEMSourceSpecification } from 'maplibre-gl';

export const DEM_SOURCE = 'mapterhorn-dem';

/**
 * Mapterhorn: Copernicus GLO-30 worldwide, refined with national high-resolution
 * models where they exist, baked to terrarium and served from PMTiles archives
 * behind a CDN. No key, `access-control-allow-origin: *`, tiles cached a week.
 *
 * Depth is uneven — z17 over Switzerland (swissALTI3D), z15 across much of Europe,
 * the US, Japan and New Zealand, z12 everywhere else. MAX_ZOOM therefore sits above
 * what most of the planet carries and the misses 404; MapLibre keeps the parent tile
 * for those, so the cost of asking is requests, not holes in the terrain.
 *
 * minzoom 0 means the horizon ring is a single small tile rather than something to
 * ration, so relief runs to the edge of the projection at any pitch.
 *
 * tileSize is what coveringTiles does its zoom maths against, and the tiles really are
 * 512 px. Declaring 256 asks for one zoom level deeper across the whole frame — 19 tiles
 * over Mont Blanc becomes 36, the far ridges go from z11 to z13, and elevations read the
 * same to the decimetre. This sets the whole frame's level; the decay toward the horizon
 * is shaped separately, below.
 */
export const DEM_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

export const DEM_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>';

const TERRAIN_SOURCE: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: [DEM_TILE_URL],
  encoding: 'terrarium',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 17,
  attribution: DEM_ATTRIBUTION,
};

/**
 * How much of the above to ask for, measured at the default view in a 1400×900 window:
 *
 * - `high` pulls both levers — tileSize understated to 256 and the LOD params below —
 *   for 179 tiles and 68.5 MiB.
 * - `medium`, the default, keeps the LOD params but declares the tiles at their real
 *   512 px: one zoom level shallower everywhere, the horizon still held, at a quarter
 *   of the traffic — 47 tiles and 19.6 MiB.
 * - `low` gives up both levers: 28 tiles and 11.4 MiB, for metered connections and the
 *   headless checks.
 *
 * It is a load-time choice, `#detail=high`, not a control. tileSize only takes effect on
 * a source declared at `style.load`; swapping it on a live map strands render-to-texture
 * tiles and paints blank bands over the relief.
 */
export const DETAIL_LEVELS = ['high', 'medium', 'low'] as const;
export type Detail = (typeof DETAIL_LEVELS)[number];
export const DEFAULT_DETAIL: Detail = 'medium';

export const demSource = (detail: Detail): RasterDEMSourceSpecification => ({
  ...TERRAIN_SOURCE,
  tileSize: detail === 'high' ? 256 : 512,
});

/** Which levels shape the decay toward the horizon with setSourceTileLodParams. */
export const usesLodParams = (detail: Detail): boolean => detail !== 'low';

/**
 * Arguments for setSourceTileLodParams, which shapes how fast terrain zoom decays
 * toward the horizon. It only bites once the horizon is on screen, which is most of
 * the time here.
 *
 * Left alone, a pitch-78 view spans z6 to z14 and the far ridges are barely modelled.
 * Fewer zoom levels on screen pulls the horizon up, but on its own it drags the whole
 * range down — the tile budget is the binding constraint, and MapLibre sheds zoom
 * uniformly to stay inside it. Raising the budget with it keeps the foreground at z14
 * and lifts the horizon to z9: 36 tiles and 12.7 MiB becomes 319 and 118 MiB.
 *
 * Tighter is available and not worth it. 3.0/100 reaches z11 at the horizon but wants
 * 714 tiles, and the view takes 161 s and 1.1 GB of heap to settle, against 23 s and
 * 273 MB here.
 *
 * Zoomed in, the same cap turns against itself. Levels on screen bound how far below
 * the foreground the horizon may fall, and past z17 the foreground is pinned at the
 * source's maxzoom, so at z20 the cap pins the horizon at z15: hundreds of z12–z14
 * tiles over land the near slope hides, each with a 2048² drape texture. Measured at
 * z20, pitch 80 over Zermatt: 5 levels held 18 GiB on the GPU across 393 drapes and
 * took 2.4 s a frame; 7 levels held 2.1 GiB across 44 at 20 ms, with the same
 * foreground tiles in both. So the cap loosens as the camera comes down to the ground:
 * the tuned 5 from 1600 m up (the default view flies 2170 m over its valley), 7 from
 * 200 m down, log-linear between. Height over the ground under the camera rather than
 * zoom, because zoom here is the distance to the axis crossing (cameraAnchor.ts) — the
 * same camera reads z14.5 or z21.7 depending on which slope the axis meets first. The
 * ratio stays put, since lowering it sheds foreground zoom too.
 */
export const MAX_ZOOM_LEVELS_ON_SCREEN = 5.0;
export const TILE_COUNT_MAX_MIN_RATIO = 100;

const LOD_HIGH_METRES = 1600;
const LOD_LOW_METRES = 200;
const LOD_LOW_LEVELS = 7;

/** Levels on screen for a camera this far over its ground, in half-level steps. */
export const levelsOnScreen = (heightAboveGround: number): number => {
  const t = Math.log2(LOD_HIGH_METRES / Math.max(1, heightAboveGround)) / Math.log2(LOD_HIGH_METRES / LOD_LOW_METRES);
  const levels = MAX_ZOOM_LEVELS_ON_SCREEN + (LOD_LOW_LEVELS - MAX_ZOOM_LEVELS_ON_SCREEN) * Math.min(1, Math.max(0, t));
  return Math.round(levels * 2) / 2;
};

/** True heights. The slider goes to 10 for anyone who wants the relief pushed, 0 flattens. */
export const DEFAULT_TERRAIN_SCALE = 1;
export const MAX_TERRAIN_SCALE = 10;
