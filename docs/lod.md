# LOD: `tileSize` is the only lever

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

That lifts the whole frame by a level. The *decay toward the horizon* is a separate
control, `setSourceTileLodParams(maxZoomLevelsOnScreen, tileCountMaxMinRatio)`, which
only bites once the horizon is on screen — which here is most of the time.

The two arguments have to move together. Allowing fewer zoom levels on screen pulls the
horizon up, but on its own it drags the whole range down with it: the tile budget is the
binding constraint and MapLibre sheds zoom uniformly to stay inside it, so the foreground
falls from z14 to z12. Raising the budget alongside keeps the foreground and lifts only
the far end:

| `maxZoomLevelsOnScreen` / `tileCountMaxMinRatio` | Tiles | Transfer | Horizon | Foreground |
| --- | --- | --- | --- | --- |
| default | 36 | 12.7 MiB | z6 | z14 |
| 4.0 / 3.0 (the doc's example) | 62 | 26.4 MiB | z8 | z12 |
| **5.0 / 100** | 319 | 118 MiB | z9 | z14 |
| 3.0 / 100 | 714 | 249 MiB | z11 | z14 |

5.0 / 100 is what is set up to z14. 3.0 / 100 buys two more levels at the horizon and is
not worth it: that view takes 161 s and 1.1 GB of heap to settle, against 23 s and 273 MB
here.

Close to the ground, the cap loosens: `levelsOnScreen` in [terrain.ts](../src/terrain.ts)
runs from 5 with the camera 1600 m or more over the ground beneath it to 7 at 200 m and
below, log-linear in half-level steps, re-applied on `move` and `idle`. Height rather than
zoom, because zoom here is the distance to where the view axis meets the terrain
([camera anchor](camera.md)) and the same camera reads z14.5 or z21.7 depending on which
slope that is. Levels on screen bound how far below the foreground the horizon may fall,
and near the ground the foreground is pinned at the source's maxzoom, so a fixed 5 pins
the horizon at z15 from a camera a few metres up — hundreds of z12–z14 tiles over land
the near slope hides, each carrying a 2048² drape texture. Measured at z20, pitch 80 over Zermatt (GPU bytes from the `#debugPerf=1`
overlay, `scripts/probe-gpu-memory.mjs`):

| levels on screen | GPU | drapes (RTT tiles) | DEM tiles in view | frame |
| --- | --- | --- | --- | --- |
| 5 | 18.1 GiB | 393 | 469 | 2.4 s |
| 7 | 2.1 GiB | 44 | 46 | 20 ms |
| 9.314 (MapLibre's default) | 2.0 GiB | 39 | 38 | 18 ms |

The foreground tiles are the same set in each; only the far field coarsens. 5 levels at
that camera was the GPU process running out of memory after a few minutes of moving.

`#detail=` picks how much of this to ask for. `high` pulls both levers as described
above. The default, `medium`, keeps the LOD params but declares the tiles at their real
512 px: one zoom level shallower everywhere, the horizon still held, at a quarter of the
traffic. `low` gives up both levers; it is for a metered connection and for the headless
checks, which all run that way — none of them are testing the tuned LOD, and a pitched
frame at full detail through a software GL took twenty minutes where `low` takes one.
Measured on the default view in a 1400×900 window: `high` 179 tiles / 68.5 MiB, `medium`
47 / 19.6, `low` 28 / 11.4. The level is read at load rather than offered as a control,
because `tileSize` only counts on a source declared at `style.load` — swapping it live
strands render-to-texture tiles and paints blank bands over the relief.

Nothing else moves terrain LOD. `TerrainTileManager.deltaZoom` is documented for exactly
this ("raster-dem tiles will load the actualZoom - deltaZoom zoom-level") and is a no-op
in 6.3: 1 and 0 request byte-identical tile sets, and -1 throws
`targetZ > this.overscaledZ`. `qualityFactor` (2) is hardcoded in MapLibre; the drape size
it sets — `painter.renderToTexture.rttSize`, 2048 px for a 512 px source — is read live
by the pool, but halving it is a drape-sharpness trade, not an LOD lever.

A rebuilt source is not the same as a declared one. Swapping `tileSize` on a live map —
`setTerrain(null)`, `removeSource`, `addSource`, `setTerrain` — leaves stale
render-to-texture tiles that show up as a blank patch with vertical banding. Declared at
`style.load` the same setting renders clean; five cameras from pitch 85 to z15.5, and
Everest behind a screen of 404s, produce no blank pixels at all.

## The mesh is a separate ceiling

MapLibre's terrain mesh, 128 vertices per tile edge, is coarser than this DEM. Rendering
the default view at 256 changes 19% of the frame, and the difference sits entirely on
ridgelines, crests and the Matterhorn's silhouette — the mesh, not the tiles, is what
rounds them off. `meshSize` is a public field on `map.terrain` rather than part of
`TerrainSpecification`, so raising it means re-applying after every `setTerrain()`. Not
turned on yet; four times the vertices per tile wants a frame-time measurement first.
