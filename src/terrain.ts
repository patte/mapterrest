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
 * same to the decimetre. Terrain LOD has no other lever: TerrainTileManager.deltaZoom is
 * documented for exactly this and is a no-op in 6.3, and qualityFactor is fixed once
 * setTerrain has run.
 */
export const TERRAIN_SOURCE: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 17,
  attribution: '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>',
};

export const DEFAULT_EXAGGERATION = 1.4;
export const MAX_EXAGGERATION = 10;
