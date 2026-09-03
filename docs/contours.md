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
takes the next lower one, so the z0 rung covers the whole zoom-out:

| tile zoom | minor | major |
| --------- | ----- | ----- |
| 0         | 2000m | —     |
| 6         | 1000m | 5000m |
| 8         | 500m  | 2000m |
| 10        | 200m  | 1000m |
| 12        | 100m  | 500m  |
| 14        | 20m   | 100m  |

The two finest rungs are Mapterhorn's own contour example; above them the interval
roughly doubles every two zooms, so zoomed-out views and the far reaches of a pitched one
keep their lines without drowning in them. The coarsest rung's single value means no
major lines — at that scale every line is a landmark, and 10 000 m majors would never
occur.

## Where the detail comes from

A contour tile at zoom `z` traces the DEM tile at `max(0, min(z − 2, 12))`: `overzoom: 2`
asks maplibre-contour for a parent tile two levels up (cheaper on neighbours), and the
source's `maxzoom: 12` caps the DEM outright — deeper levels sharpen lines less than
they cost, and much of the world carries nothing deeper anyway. The floor at 0 is ours
(`patches/maplibre-contour-dem-zoom-floor.patch`): unpatched, a z0 or z1 contour tile asks for the DEM
at a negative zoom, the fetch fails and those zooms trace nothing. Three consequences
worth knowing:

- z0 and z1 trace the z0 DEM, split into quarters for z1.

- From tile z14 upward every line is traced from the same z12 data; deeper zooms add no
  new information, only smoother upscales.
- maplibre-contour bilinear-subsamples the grid before tracing once it drops below 100
  samples, which with 512 px tiles happens from z15 — so z13/z14 carry the rawest grid.

## Styling

Minor lines draw at 0.75 px, majors at 1.5 px, in per-basemap colors (`basemap.contour`).
No thinner: over terrain the lines are baked into a fixed 2048 px drape texture per
terrain tile that a fractional zoom stretches up to 2× on a 2× display, and a 0.5 px
line is one texel there, smearing into a grey band. No wider either — 1 px crowds the
20 m lines on z14's steep faces.
Only majors carry a label (`2 500m`); every 20 m line labelled is noise. The label font
is whatever the active style declares on its first symbol layer — the providers all name
their fonts differently, and shipping our own glyphs isn't worth it. A style without any
symbol layer would get lines without labels rather than a stack of 404s; none of the
current basemaps is in that position.

## Controls

The tray's overlays are two lines. *Relief* — hillshade and contours — is a pair of
toggles that compose, with a "none" tile that clears both; *colour* is a choice of one
ramp or none, and clicking the pressed ramp turns it off again. Each line's option —
elevation labels under contours, auto-exposure under a ramp — sits in a row of its own
under the line, disabled rather than hidden while its tile is off, so the tray never
shifts. Relief draws over colour: a hillshade over the heat ramp is the classic
terrain look, and contours sit over both. While contours are on, an "elevation labels"
checkbox appears. Everything survives in the hash: `hillshade=0` (default on),
`ramp=heatmap` (default none), `contours=1`, `contourLabels=0` (labels default on).
Links from before the split — `shading=heatmap`, `shadingVisible=0` — still render
what they showed.

Over a ramp the hillshade drops the basemap's tinted shadow and highlight for plain
black and white: the tint exists to marry the shade to the basemap's ground, and a ramp
is not that ground.

## Tuning

Two settings fold open under the relief tiles while contours is on, in an inset well
whose notch points at the contours tile ("lines", "falloff", detents −2…+3, hash
`contourDensity` / `contourFalloff`, 0/0 default), each a row of six dots between ⊖
and ⊕: the filled dot is the current detent, a tap on any dot jumps to it. They reshape the interval table
rather than replace it, one exponent per knob: each "lines" detent halves or doubles
every interval. "Falloff" is the exponent on the table's own slope — the deliberate
thinning that keeps zoomed-out and far-field tiles (a pitched view is a mosaic of tile
zooms) from drowning in lines. Each detent halves or adds half of that slope: at −2 the
table is flat, every tile traces the fine rung's interval; at +3 the thinning is past
squared and lines are a close-up-only affair. Computed
intervals snap to the 1-2-5 ladder (lines at "every 37 m" are cartographic nonsense),
and 0/0 reproduces the table bit for bit. A change lands in the source's tile URL, so
it replaces the source and re-traces.

The knob is the interval, not a line count: lines per screen follow the terrain's
steepness. Over flat country lines +3 with falloff −2 makes invisible
relief appear and keeps it visible zoomed out; the same corner over the Alps is a wall
of ink — reversible, and the trade is the user's. The default is tuned for the Alps.
The range runs one detent further up than down because flat country needs it: the
Po valley holds a few tens of metres of relief, so at the 20 m the table gives z12 tiles
even lines +2 traces two or three levels, and the count of lines is relief over
interval — each detent there is the difference between some contours and none. Falloff
cannot help: intervals snap to the 1-2-5 ladder, which has no rung between 10 and 20,
so a finer falloff step would only move which zoom flips, not how far. At lines +3 the
z12 rung is 5 m, and the DEM still traces the Po's terraces coherently rather than
noise (`shots/density-spike-po-3.png`).

## Verifying

`pnpm verify contour` covers the tracing and the tray toggle; `scripts/shoot-contours.mjs`
renders a gallery into `shots/`. Contours drape over the 3D terrain, which made them the
canary for a maplibre rendering bug — see [maplibre-patches.md](maplibre-patches.md).
