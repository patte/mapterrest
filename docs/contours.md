# Contour lines

There are no contour tiles to download. [maplibre-contour] registers a protocol that
fetches the same Mapterhorn DEM tiles the terrain uses — the browser's HTTP cache dedupes
the traffic — and traces isolines into vector tiles in a web worker. The `DemSource` is
created on first use, so a session that never turns contours on never pays for the
worker; one instance serves every map (main, thumbnails, screenshot) and shares its tile
cache. All of it lives in `src/contours.ts`.

[maplibre-contour]: https://github.com/onthegomap/maplibre-contour

## Intervals

The elevation gap between lines, minor and major, by tile zoom; a zoom without an entry
takes the next lower one, and below the lowest there are none at all:

| tile zoom | minor | major |
| --------- | ----- | ----- |
| 4         | 2000m | —     |
| 6         | 1000m | 5000m |
| 8         | 500m  | 2000m |
| 10        | 200m  | 1000m |
| 12        | 100m  | 500m  |
| 14        | 20m   | 100m  |

The two finest rungs are Mapterhorn's own contour example; above them the interval
roughly doubles every two zooms, so zoomed-out views and the far reaches of a pitched one
keep their lines without drowning in them. z4's single value means no major lines — at
that scale every line is a landmark, and 10 000 m majors would never occur.

## Where the detail comes from

A contour tile at zoom `z` traces the DEM tile at `min(z − 2, 12)`: `overzoom: 2` asks
maplibre-contour for a parent tile two levels up (cheaper on neighbours), and the
source's `maxzoom: 12` caps the DEM outright — deeper levels sharpen lines less than
they cost, and much of the world carries nothing deeper anyway. Two consequences worth
knowing:

- From tile z14 upward every line is traced from the same z12 data; deeper zooms add no
  new information, only smoother upscales.
- maplibre-contour bilinear-subsamples the grid before tracing once it drops below 100
  samples, which with 512 px tiles happens from z15 — so z13/z14 carry the rawest grid.

## Styling

Minor lines draw at 0.5 px, majors at 1 px, in per-basemap colors (`basemap.contour`).
Only majors carry a label (`2 500m`); every 20 m line labelled is noise. The label font
is whatever the active style declares on its first symbol layer — the providers all name
their fonts differently, and shipping our own glyphs isn't worth it. A style without any
symbol layer would get lines without labels rather than a stack of 404s; none of the
current basemaps is in that position.

## Controls

The contour tile in the tray is additive — a toggle riding on top of the exclusive
shading choice — and the row's "none" tile clears both. While contours are on, an
"elevation labels" checkbox appears. Both survive in the hash: `contours=1`,
`contourLabels=0` (labels default on).

## Verifying

`pnpm verify contour` covers the tracing and the tray toggle; `scripts/shoot-contours.mjs`
renders a gallery into `shots/`. Contours drape over the 3D terrain, which made them the
canary for a maplibre rendering bug — see [maplibre-patches.md](maplibre-patches.md).
