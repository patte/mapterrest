# Alpenglow — Mapterhorn terrain in MapLibre 3D

Pre-baked terrarium tiles from [Mapterhorn](https://mapterhorn.com) driving MapLibre's 3D
terrain. No key, no proxy, no transcoding: the tiles arrive ready for `raster-dem`.

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Sibling of [../glo30-proto](../glo30-proto), which streams the same Copernicus GLO-30
data live from S3 as Cloud Optimized GeoTIFFs and transcodes it in the browser. That
prototype answers "can this be done from the raw bucket"; this one answers "what does it
look like when someone has already done it well".

| File | Role |
| --- | --- |
| [src/terrain.ts](src/terrain.ts) | The Mapterhorn source spec |
| [src/basemaps.ts](src/basemaps.ts) | Basemap styles with matching sky and hillshade palettes |
| [src/shading.ts](src/shading.ts) | Hillshade and elevation-heatmap layers |
| [src/theme.ts](src/theme.ts) | `prefers-color-scheme` detection |
| [src/urlState.ts](src/urlState.ts) | Control state in the location hash |
| [src/shiftDragCamera.ts](src/shiftDragCamera.ts) | Shift+drag rotate/tilt gesture |
| [src/main.ts](src/main.ts) | Map, terrain, shading, UI |

## Mapterhorn

Copernicus GLO-30 worldwide, refined with national high-resolution models where they
exist, baked to terrarium and served from PMTiles archives behind Cloudflare. The hosted
endpoint needs no key and answers `access-control-allow-origin: *` with a week of
`cache-control`, so the browser reads it directly:

```js
{
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 256, // the tiles are 512 px — see LOD below for why this says otherwise
}
```

Tiles run 270–470 KB of lossless WebP over mountains, less over flat ground. A tilted
view draws a dozen or so, which is the whole cost of a frame.

The archives are downloadable too — `planet.pmtiles` is 706 GB covering z0–12, with
regional z13+ archives on top (Switzerland is a 312 GB `6-33-22.pmtiles` reaching z18).
Both the ZXY endpoint and the raw archives carry CORS headers and answer range requests,
so `pmtiles://https://download.mapterhorn.com/planet.pmtiles` works from a browser with
nothing self-hosted. That path skips the CDN, though, so the tile endpoint is the fast
one; the archives are for self-hosting and `pmtiles extract` subsets.

## Zoom depth is uneven, and that is fine

Coverage past z12 exists only where a country published a high-resolution model:

| | Depth |
| --- | --- |
| Switzerland (swissALTI3D) | z17 |
| Much of Europe, the US, Japan, New Zealand | z15 |
| Andes, Himalaya, Iceland, most of Africa | z12 |

`maxzoom` is therefore set to 17 — above what most of the planet carries — and the misses
404. MapLibre keeps the parent tile for an errored DEM tile, so the cost of asking is
requests, not holes. Measured with `pnpm probe:coverage`, exaggeration at 1×:

| Place | Zoom | Hits | Misses | Summit read | vs. true |
| --- | --- | --- | --- | --- | --- |
| Matterhorn | 16 | 12 | 0 | 4445.6 m | −32 m |
| Mont Blanc | 16 | 14 | 0 | 4756.1 m | −52 m |
| Everest | 16 | 1 | 22 | 8713.3 m | −136 m |
| Aconcagua | 16 | 0 | 6 | 6902.9 m | −58 m |

Everest and Aconcagua hold their height through a screen of 404s — the terrain there is
simply the z12 tile stretched, which is what the data supports.

`minzoom` is 0. A single small tile carries the horizon ring, so relief runs to the edge
of the projection at any pitch, with none of the per-cell rationing the COG prototype
needs.

## LOD: `tileSize` is the only lever

Terrain LOD falls off with distance, and out of the box it falls off early — the far
ridges of a pitched view arrive at z9 while the foreground is at z13.

`tileSize` is what `coveringTiles` does its zoom maths against. The tiles really are
512 px; declaring **256** asks for one zoom level deeper across the whole frame. Measured
over Mont Blanc at z12.6, pitch 78:

| | Tiles | Transfer | Zoom spread |
| --- | --- | --- | --- |
| `tileSize: 512` | 19 | 7.4 MiB | z6:1 z9:4 z10:4 z11:2 z12:4 z13:4 |
| `tileSize: 256` | 36 | 12.7 MiB | z6:1 z7:1 z9:4 z10:4 z11:6 z12:4 z13:8 z14:8 |

Elevations are unaffected — the same four probes read within 4 m either way, since this
shifts which tile is chosen, not how its pixels are decoded.

Nothing else moves terrain LOD. `TerrainTileManager.deltaZoom` is documented for exactly
this ("raster-dem tiles will load the actualZoom - deltaZoom zoom-level") and is a no-op
in 6.3: 1 and 0 request byte-identical tile sets, and -1 throws
`targetZ > this.overscaledZ`. `qualityFactor` and the render-to-texture tile size are
fixed once `setTerrain()` has run, and mutating them afterwards changes nothing.

A rebuilt source is not the same as a declared one. Swapping `tileSize` on a live map —
`setTerrain(null)`, `removeSource`, `addSource`, `setTerrain` — leaves stale
render-to-texture tiles that show up as a blank patch with vertical banding. Declared at
`style.load` the same setting renders clean; five cameras from pitch 85 to z15.5, and
Everest behind a screen of 404s, produce no blank pixels at all.

## Accuracy

Read off the rendered mesh at 1× exaggeration by `pnpm verify`:

| Point | Rendered | Truth |
| --- | --- | --- |
| Matterhorn | 4442.6 m | 4478 m |
| Jungfrau | 4138.0 m | 4158 m |
| Zürich HB | 408.3 m | ~408 m ground |
| Lake Zürich | 405.6 m | 406 m lake surface |

Over Switzerland this is swissALTI3D, a *terrain* model, where raw GLO-30 is a *surface*
model that includes buildings and canopy. Both directions of the difference show up
above: the peaks come out far closer than GLO-30 manages (which puts the Matterhorn at
4220 m), and Zürich HB reads ground rather than roof.

## UI

One panel, collapsing behind a button under 640 px. Both pickers pair a checkbox with a
select, so the choice survives being switched off:

| Control | Effect |
| --- | --- |
| basemap | style, and whether it draws at all |
| shading | hillshade or elevation heatmap, and whether it draws at all |
| terrain exaggeration | 0–10× |

With the basemap off, background layers stay on: MapLibre hangs vertical skirts off every
terrain tile edge to cover LOD seams, and over a see-through drape those skirts smear
edge pixels into grey curtains. A backdrop layer replaces the style's near-black or
paper-white ground with a mid tone the relief reads against.

The heatmap is MapLibre's `color-relief` layer, a ramp over absolute elevation in metres,
so its colours mean the same thing everywhere. Both shading layers are inserted before
the style's first symbol layer, or place names end up behind the relief.

The hillshade light is anchored to the map. MapLibre anchors it to the viewport by
default, which welds the sun to the screen: rotating the camera re-lights every slope,
and a bearing that runs the light along the ridges flattens them into smears that read
as lost detail. Sampling 49 fixed ground points across a 99° turn, viewport anchoring
shifts their shading 2.3× as much as map anchoring does (mean 101.1 vs 43.5, the
remainder being the pitch change). Anchored to the map an azimuth is a real compass
bearing, which is also what a sun position would need.

The basemap follows `prefers-color-scheme` and keeps following it — switch the OS between
light and dark and the map changes under you — until a basemap is picked by hand, after
which the choice is the user's and lives in the hash.

## Camera controls

| Gesture | Effect |
| --- | --- |
| drag | pan |
| **Shift + drag** | rotate (horizontal) and tilt (vertical) |
| right-drag, Ctrl + drag | rotate and tilt (MapLibre built-ins, kept) |
| scroll | zoom |

Shift+drag is MapLibre's box-zoom gesture by default; that is given up for this. MapLibre
bakes its modifier check into `MouseMoveStateManager` (`LEFT && ctrlKey || RIGHT`) with no
option to change it, so [src/shiftDragCamera.ts](src/shiftDragCamera.ts) is a separate
handler. It listens on the document in the capture phase and stops propagation, so
MapLibre's drag handlers never see the gesture and the map cannot pan while rotating.

## URL state

Camera and every control live in the location hash, so a reload restores the view:

```
#map=12.6/46.005/7.7/225/78&basemap=carto-light&shading=heatmap&shadingVisible=0&exaggeration=3.7
```

MapLibre's named-hash mode (`hash: 'map'`) reads the existing params, sets only its own
key and re-serialises the rest, so both writers coexist. `urlState.ts` mirrors MapLibre's
serialisation exactly — otherwise the hash flips between encoded and decoded forms as
each side writes.

## Things worth knowing

**`setStyle()` replaces sources, layers, terrain and sky wholesale**, so the DEM source,
terrain, sky, backdrop and shading layer are re-attached on every `style.load` — which
fires on the initial load and on each style change alike.

**MapLibre's terrain mesh, 128 vertices per tile edge, is coarser than this DEM.**
Rendering the default view at 256 changes 19% of the frame, and the difference sits
entirely on ridgelines, crests and the Matterhorn's silhouette — the mesh, not the tiles, is what rounds them off. `meshSize` is
a public field on `map.terrain` rather than part of `TerrainSpecification`, so raising it
means re-applying after every `setTerrain()`. Not turned on yet; four times the vertices
per tile wants a frame-time measurement first.

**CARTO publishes its DataViz basemaps under their original names.** DataViz Dark is Dark
Matter, DataViz Light is Positron; there is no `dataviz-*` style URL, those 404.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm verify` | Headless end-to-end: terrain, elevations, attribution, hash round-trip, colour scheme, mobile panel (needs `pnpm dev` running) |
| `pnpm probe:coverage` | What asking past Mapterhorn's depth costs, per place and zoom (needs `pnpm dev` running) |
