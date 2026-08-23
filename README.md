# Mapterrest — Mapterhorn terrain in MapLibre 3D

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

## The source

Mapterhorn is Copernicus GLO-30 worldwide, refined with national high-resolution models
where they exist, baked to terrarium and served behind Cloudflare — no key, CORS `*`, a
week of `cache-control`, so the browser reads it directly:

```js
{
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 256, // the tiles are 512 px — see docs/lod.md for why this says otherwise
}
```

Depth is uneven — z17 over Switzerland (swissALTI3D), z15 across much of Europe, the US,
Japan and New Zealand, z12 everywhere else — so `maxzoom` sits above what most of the
planet carries and the misses 404. MapLibre keeps the parent tile for an errored DEM
tile, so the cost of asking is requests, not holes.
[docs/mapterhorn.md](docs/mapterhorn.md) has the archives, the coverage probes and the
accuracy measurements.

`#detail=` picks how much terrain LOD to ask for: `high` pulls every lever, the default
`medium` holds the horizon at a quarter of the traffic, `low` gives up both levers for
metered connections and the headless checks. [docs/lod.md](docs/lod.md) is the story of
which levers exist and what each costs.

## Controls

A card in the lower left: a grid of basemap tiles under a row of shading tiles
(hillshade, elevation heatmap or grey heightmap), stacked the way the layers render,
each section led by a "none" tile that hides its layer. Once the camera settles, a hidden
mini map re-renders every tile into a live preview of what switching to it would show.
Above them: terrain scale (0–10×, true heights by default, 0 flattens), auto-exposure, and
the debug overlays. An X folds the whole card down to a single settings tile that
previews the current view; narrow screens and `#collapsed=1` start folded. The basemap
follows `prefers-color-scheme` until one is picked by hand. Auto-exposure pins the
colour ramps to the elevations in view —
[docs/exposure.md](docs/exposure.md) — and shift+drag orbits the terrain in the frame —
[docs/camera.md](docs/camera.md). In the opposite corner, the Mapterhorn and MapTiler
logos stack above the attribution while their data is on screen.

The camera pill beside the hint frames a paper-aspect screenshot — A2–A6, Letter, Legal
or Tabloid, landscape or portrait — and exports what the rectangle shows as a 300 dpi
PNG, re-rendered with tiles up to two zoom levels deeper than the screen. The file
carries its credits, the view's permalink and the centre as GPS —
[docs/screenshots.md](docs/screenshots.md).

| Gesture | Effect |
| --- | --- |
| drag | pan |
| **Shift + drag** | rotate (horizontal) and tilt (vertical) |
| right-drag, Ctrl + drag | rotate and tilt (MapLibre built-ins, kept) |
| scroll | zoom |

Camera and every control live in the location hash, so a reload restores the view:

```
#map=12.6/46.005/7.7/-135/78&basemap=carto-light&shading=heatmap&shadingVisible=0&autoExposure=0&terrainScale=3.7
```

`detail=`, `debugPivot=`, `debugPerf=`, `pivot=` and `collapsed=` join them; everything
else is written back as it changes. Hand-editing the hash applies live — except `detail=` and
`pivot=`, construction-time choices that reload the page.

## Docs

| | |
| --- | --- |
| [docs/mapterhorn.md](docs/mapterhorn.md) | The tile source: endpoints, archives, coverage depth, accuracy |
| [docs/lod.md](docs/lod.md) | Terrain LOD: the `tileSize` lever, the horizon params, the detail levels |
| [docs/exposure.md](docs/exposure.md) | Auto-exposure: what counts as visible, and the hillshade light |
| [docs/camera.md](docs/camera.md) | The orbit pivot, the raycast, and how the camera is anchored |
| [docs/thumbnails.md](docs/thumbnails.md) | Live previews: the scene spec, the hidden mini map's walk, the refresh policy |
| [docs/screenshots.md](docs/screenshots.md) | Print exports: the grown-viewport capture, the engine's ceilings, credits and file metadata |

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm verify` | Headless end-to-end: Playwright specs under `tests/`, one per subject — filter with `pnpm verify orbit`. ~1 min on a Mac GPU, ~7 min through software GL |
| `pnpm probe:coverage` | What asking past Mapterhorn's depth costs, per place and zoom |
| `pnpm browser:start` / `browser:stop` | Optional resident browser server; verify runs and probes connect to it instead of launching their own |

[AGENTS.md](AGENTS.md) has the operational detail: GL modes, the tile cache, spike-script
conventions.
