# Auto-exposure

Heightmapper's idea: instead of a ramp fixed to absolute metres, spread the lowest visible
elevation to the foot of the ramp and the highest to its head. Over the Netherlands a
fixed 0–6000 m scale puts 95 m of relief into one and a half percent of the ramp and the
country renders black; exposed to −10…85 m the polders, the dykes and the Utrechtse
Heuvelrug all separate.

The cost is that a shade stops meaning a height — mid grey is 47 m in one view and 2450 m
in another. So it is a checkbox whose default follows the ramp: grey has nothing to lose
by following the view, so the heightmap starts exposed; the heat ramp's sea blue and snow
white do mean a height, so the heatmap starts on its own metres. A hand toggle then
applies to both ramps. Hillshade offers no exposure at all — it reads the DEM's gradient
and never sees an absolute elevation for the endpoints to move. The ⓘ beside the checkbox
opens a short in-app version of this page.

What counts as visible is the whole question. The DEM tiles behind the shading carry their
own `dem.min`/`dem.max`, so the range is read off the data being drawn rather than sampled
from it — but those extremes answer for a whole tile, and a tile is only sometimes the
size of the frame. Over Rybinsk at z5.45 the four z4 tiles drawn are about a tenth on
screen each, and they carry Elbrus and the Karagiye Depression more than a thousand
kilometres south of the bottom edge: the ramp is pinned to −131…4839 m over ground that
runs 0 to 340 m, and the map goes black. Nudging to z6 only trades those tiles for a set
that reaches the Carpathians instead.

So each tile is cut to the frustum before it is read. `getTileBoundingVolume` and
`intersectsFrustum` are what `coveringTiles` picks tiles with, which makes the cut agree
with what is drawn by construction, and `Aabb.quadrant` walks a tile down in quarters. To
answer for a quarter, a tile carries a pyramid of its own elevation extremes down to 4 px
cells, built in one pass the first time the tile is found straddling the frustum edge.
That pass is the one MapLibre already runs to fill `dem.min`/`dem.max` — no server bakes
those in — so the alternative of fetching real sub-tiles pays the same pass once per
sub-tile, plus a request and a decode, and matching a 4 px cell of a z4 tile means z11,
which is 16384 of them.

The walk costs the frame's edge rather than its area: a node wholly in view answers from
its stored extremes and a node wholly outside answers not at all. A node whose extremes
already sit inside the range found so far is skipped outright — no child can widen what
its parent could not — which is what keeps the pitched views cheap. Zermatt at pitch 78
reads 223–4772 m in 0.5 ms; the same walk without that skip measured 2.4 ms over a smaller
set of tiles.

Everything in frame counts and nothing else does, so there is no distance to argue about
and no constant to tune. That is a change of policy as well as of precision: the ramp now
answers for the horizon when the horizon is in shot. Looking southwest from Utrecht at
pitch 78 the frame runs to lat 50.2 and the ramp carries the Ardennes at 297 m, where a
cut on distance would have held the country at 85 m. Pitch down, or turn, and it is a flat
country again.

The honest limit is resolution rather than reach. A cell is cut whole, so what it holds
past the frame's edge is counted, and a cell is only as small as its tile is deep: 4 px of
a z12 tile is 50 m of ground, but 4 px of the z5 tile LOD gives the horizon is 6 km. That
is what the size is chosen against — measured against a per-pixel scan, 4 px answers the
Netherlands 22 m over its true 275 m top, where 16 px is 107 m over and 64 px is 290 m.
Against the span it perturbs that is 5 %, where 16 px was 26 %, and it is nothing at all
wherever one tile level fills the frame. It costs 171 KB a tile rather than 11 KB and
nothing in time, since the descent is bounded by the skip rather than by the depth.

The other end of the ramp has a floor of its own. Open ocean reads exactly 0.000 m across
the frame, and a ramp whose ends meet is one flat colour — MapLibre takes the collapsed
stops without complaint, so what `MIN_SPAN` prevents is a black frame, not an error.
10 m clears the 1/256 m the terrarium encoding quantises to, stays well clear of the half
metre `SETTLED` ignores, and sits under the 22 to 27 m that real flat country — Flevoland,
the Po valley, the Hungarian plain — turns out to hold, so none of them are spread to fit
a floor instead of keeping their own contrast.

At world zoom the whole question is moot, because every tile is in frame — Everest comes
back as 5604 m, which is what a z0 tile flattens it to and therefore what the ramp should
end at. So auto-exposure needs no threshold to disable it: at that scale it simply becomes
the global ramp.

The range steps as cells cross the frustum and as a loading tile replaces a coarser one
that answered differently, so a ramp repainted straight from it would make the map
breathe. The endpoints ease over a quarter second instead. Only a range that has actually
moved is reported: repainting an unchanged one dirties the style, which draws a frame,
which fires `sourcedata`, which measures again — and a still map never reaches `loaded()`.

## The hillshade light

The hillshade light is anchored to the map. MapLibre anchors it to the viewport by
default, which welds the sun to the screen: rotating the camera re-lights every slope,
and a bearing that runs the light along the ridges flattens them into smears that read
as lost detail. Sampling 49 fixed ground points across a 99° turn, viewport anchoring
shifts their shading 2.3× as much as map anchoring does (mean 101.1 vs 43.5, the
remainder being the pitch change). Anchored to the map an azimuth is a real compass
bearing, which is also what a sun position would need.
