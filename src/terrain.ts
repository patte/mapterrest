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
const TERRAIN_SOURCE: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 17,
  attribution: '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
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
 */
export const MAX_ZOOM_LEVELS_ON_SCREEN = 5.0;
export const TILE_COUNT_MAX_MIN_RATIO = 100;

/** True heights. The slider goes to 10 for anyone who wants the relief pushed, 0 flattens. */
export const DEFAULT_TERRAIN_SCALE = 1;
export const MAX_TERRAIN_SCALE = 10;
