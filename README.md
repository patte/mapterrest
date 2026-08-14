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

| File | Role |
| --- | --- |
| [src/terrain.ts](src/terrain.ts) | The Mapterhorn source spec |
| [src/basemaps.ts](src/basemaps.ts) | Basemap styles with matching sky and hillshade palettes |
| [src/shading.ts](src/shading.ts) | Hillshade and elevation-heatmap layers |
| [src/theme.ts](src/theme.ts) | `prefers-color-scheme` detection |
| [src/urlState.ts](src/urlState.ts) | Control state in the location hash |
| [src/shiftDragCamera.ts](src/shiftDragCamera.ts) | Shift+drag orbit around the terrain in the frame |
| [src/pivot.ts](src/pivot.ts) | Which point that orbit turns around |
| [src/pivotDebug.ts](src/pivotDebug.ts) | `#debugPivot=1` overlay for inspecting the choice |
| [src/cameraAnchor.ts](src/cameraAnchor.ts) | Where the camera is anchored, with MapLibre's ground pin off |
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

5.0 / 100 is what is set. 3.0 / 100 buys two more levels at the horizon and is not worth
it: that view takes 161 s and 1.1 GB of heap to settle, against 23 s and 273 MB.

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
| terrain exaggeration | 0–10×, true heights by default |

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

### The gesture turns around the terrain in the frame

MapLibre turns about `transform.center`, which sits on the horizontal plane at the
centre's own elevation rather than on the terrain. Pitched into a valley that point is
well past the ridge in view — 11.8 km out over Zermatt where the ground under the centre
pixel is 9.5 km out, and 7.3 km two-thirds of the way down the frame. Turning about the
far point drags the whole frame around with it.

So the handler raycasts — the ground under a pixel, found by marching a ray against the
DEM (see [below](#the-raycast-does-not-ask-the-gpu)). The hits are taken once at mousedown,
the camera's offset from the pivot is frozen in the camera's own basis, and every frame
rebuilds that offset at the new angles. Distance and angular position are both preserved,
so the pivot keeps its pixel and its size. MapLibre's own rotate handler turns about the
centre regardless: `MouseRotateHandler` emits no anchor, and the pivot machinery is
skipped for the centre point.

Mean displacement of nine fixed ground points, and how far the pivot itself slides:

| Gesture | About the centre | Orbit about the terrain |
| --- | --- | --- |
| 10° turn | 164 px (pivot slides 56 px) | 58 px (0.6 px) |
| 30° turn | 414 px (156 px) | 154 px (0.7 px) |
| 5° tilt | 81 px (28 px) | 30 px |
| 15° tilt | 282 px (84 px) | 88 px |

### Which point, though

Raycasting a fixed fraction of the frame holds *that pixel* exactly and grabs whatever
happens to be under it. Head-on at the Matterhorn from the Italian side, filling the view,
0.65 of the way down the frame is the glacier at the mountain's base — 3.7 km out at
4634 m — while the summit projects to y = 41 of 900. (Every elevation through this section
is exaggerated metres, measured at 1.4×, which was the default when the pivot was worked
out.) A 25° tilt swung the camera 5820 →
7280 m about that base and took the summit clean out of the frame: the turning circle
"way out". Pitched down at the same mountain, the same fraction lands on the slope in
view, which is why it felt right there.

So the pivot is chosen by what the frame is *of*, not by where a pixel is. At mousedown
[pivot.ts](src/pivot.ts) raycasts a 13×9 grid across the middle of the viewport, takes each
hit's distance along the view axis, and weights it by where attention sits (below). A
**surface** is then a band of depth, ±0.35 octaves wide, and the pivot goes to the surface
a turn would hold the frame stillest around.

The grid is 13 wide because a subject narrower than the spacing between rays falls through
it: 7 columns leave 222 px between samples on a 1900 px frame, 13 leave 111 px. 117 rays
cost 4.1 ms, affordable only because they are marched against the DEM rather than read
back from the GPU — 36 readbacks used to cost 2 ms on their own.

Stillest, measured. Turning by θ about a pivot D away swings the camera through an arc of
about D·θ, and a point at depth d then slides across the screen by roughly
`focal · θ · |D/d − 1|` — nothing at all at d = D, and more the further its depth is from
the pivot's. Summed over the frame that is what a choice of pivot costs:

```
cost(D) = Σ weight · |D/d − 1|
```

and the surface to turn about is the one that minimises it. The preference for the near
thing falls out of the geometry rather than being dialled in: a far point's term saturates
at its weight — a pivot at no distance means the camera never translates, so nothing moves
much — while a near point's grows without bound. That last part needs a cap, one sample
being allowed to be badly held but not infinitely badly held; without it a strip of ground
250 m under the camera takes the pivot off a mountain at 4.5 km. It is set to 1, where a
sample saturates once the pivot is twice its own depth — tight, because the attention
shape below hands full weight to the near ground along the bottom of the frame.

Scoring surfaces by the weight they own instead — the share of the screen they cover —
reads well and breaks on the near, deep subject, because depth measured in octaves means
the closer a thing is the more of them it spans. At
`#map=16.14/45.977387/7.659333/-93.8/70` the Matterhorn's samples spread over 0.17 octaves
and it won; half a zoom level closer, at `16.25`, the same mountain spread over 0.65, split
across two bands, and lost to the plain 4 km behind it holding 47 % of the weight. Widening
the band to hold it merges the two at the first view instead. Stillness gets both:
1.58 km and 1.73 km.

The band still says what a surface *is*, though, and that is what stops a scene without
gaps from chaining. Tipped toward level the ground runs to the horizon unbroken: at
`#map=14.55/45.97982/7.65853/177.4/85` every neighbouring pair of samples sits inside any
gap threshold, so cutting the depths where the gaps are chains the mountain 3 km ahead to
the range 25 km behind it as one 36-point "surface" whose centre of mass is 6.3 km out in
the valley — and two samples either side of the threshold decide it.

### Attention is a triangle, not a disc

Every ray's weight comes from where attention sits in the frame: a triangle from the
middle down to the bottom corners, inset from the edges, full weight inside and falling
off outside.

A disc says attention is a cone about the view axis, and on a tilted camera that is wrong
in a specific way. Screen position and world distance are coupled — along the bottom of
the frame a step sideways is metres, along the top it is kilometres — so a round mask
covers a wildly lopsided patch of ground. What a viewer means by *what I am looking at* is
a patch of ground in front of them, and the perspective image of that patch is a triangle:
pinched where the ground recedes toward the horizon, broad where it is close.

It decides the pivot wherever a subject recedes from the camera. At
`#map=14.63/45.98623/7.60814/-74.6/68` the mountain is a ridge running away, 2.5 km at the
bottom of the frame and 4.9 km at its apex — and the apex is exactly what a centred disc
weighs most, so the pivot went to the far end of the subject rather than its near mass.
The triangle brings it to 3.0 km, onto the face.

Two things it does not need. No pitch term: level with the ground the triangle is what the
projection gives, and looking straight down the whole frame sits at one depth, where no
weighting can change the answer. And no world-space model, though that was the obvious
generalisation — attention as a ball around wherever the view axis lands answers 4.0–4.4 km
at the view above, because the axis strikes the far apex and the ball follows it out there.
The triangle works precisely because it fixes attention at a depression angle below the
horizon rather than at whatever the axis hits, and a fixed depression angle is a fixed
screen row.

**The pivot is a point on that surface**, so the subject turns even when the frame is not
centred on it: at the view above, the face's centre of mass is 96 px below and right of
the middle of the window, and that is where the pivot goes. Getting a point that is
genuinely on the terrain takes one more step — the centre of mass of a curved surface is
not on it, and across a ridge it lands inside the mountain — so the centroid is projected
back to a pixel and re-cast from there, with the nearest sample standing in if that pixel
misses. Either way the pivot is a raycast hit.

Below three hits, on a frame that is nearly all sky, the old ladder of anchors takes over
(0.65, 0.8, 0.5, 0.92 down the centre column, first hit wins), and with no terrain at all
the gesture turns about the centre.

### The raycast does not ask the GPU

`map.terrain.pointCoordinate(p)` is the obvious way to get the ground under a pixel — it
reads MapLibre's coords framebuffer, and it is what MapLibre's own pan and zoom anchoring
calls. It is also **silently wrong on a large window**. Which tile a pixel came from is
encoded in one byte of that framebuffer:

```js
const uniformValues = terrainCoordsUniformValues(255 - terrain.coordsIndex.length, ...)
...
const tileID = this.coordsIndex[255 - rgba[3]];   // 8 bits → 255 tiles, and no guard
```

Past 255 rendered terrain tiles the index wraps, pixels decode to the wrong tile, and the
call returns a *real* coordinate from somewhere else on the planet. A 1900×1532 window at
pitch 85 draws 306 of them, and every sample of the frame came back 200–350 km out on a
mountain 3 km away — while the same view in a 1400×900 window (172 tiles) answered
correctly. MapLibre documents the limit in a source comment and does nothing about it; no
issue or PR in the repository mentions it. The tile count is ours to inflate, too: the LOD
params below are what take the default view from 36 tiles to 319.

So the grid marches rays against the DEM instead, with `rayCrossing` in
[cameraAnchor.ts](src/cameraAnchor.ts) — the same geometric march and bisection the camera
anchor uses to find where the view axis meets the terrain, pointed through an arbitrary
pixel rather than straight ahead. Three things come out of it:

| | `pointCoordinate` | marched against the DEM |
| --- | --- | --- |
| 306 tiles, pitch 85 | 200–350 km, garbage | 5.11 km, same as at 18 tiles |
| 36 rays, 1900×1532 | 2 ms | **1.6 ms** |
| answers from | the rendered mesh | the DEM the anchor settles against |

The timings are from SwiftShader, where `readPixels` is a memory read; on a real GPU it is
a pipeline sync and the gap is wider. The third row matters as much as the first: the
pivot and the settle used to disagree by the metres that mesh and DEM differ by on a
slope. `pnpm verify` runs at 18 tiles and could never catch the overflow, so it asserts the
invariant instead — it stubs `pointCoordinate` to return null and checks the pivot does not
move.

The pivot never depends on where the mouse went down — shift+drag from anywhere and the
mountain in view is what turns — which is how Google Maps 3D behaves, and Google is where
the complaint came from. It holds its pixel to 0.1 px through a 48° turn.

Rotate and tilt speeds are half MapLibre's own — 0.4 and 0.25 °/px — which the calmer
pivot made room for. Moves are coalesced into one camera update per animation frame; a
trackpad reports them faster than the map renders.

**`#debugPivot=1` draws the choice.** A crosshair on the pivot, and every grid sample at
its own world position, sized by the weight it carried and coloured by its depth against
the pivot's — warm nearer, blue further, amber at it, saturating at half and double.
The samples ringed in white are the surface that won. It solves when the camera
comes to rest, so the pivot is inspectable before committing to a drag, and holds the
gesture's own pivot while one is running: the crosshair sits still while the samples swing
around it. Tuning affordance, not a feature — Google shows nothing.

### What a camera costs to write down

MapLibre stores a camera as a centre, an elevation and a zoom — where the view axis meets
the ground, and how far away that is. Close in on a mountain, that is a bad way to hold
one, and everything below is the app working around it.

**The ground pin is off, and [cameraAnchor.ts](src/cameraAnchor.ts) anchors instead.**
With `centerClampedToGround` (MapLibre's default) the centre's elevation is re-clamped to
the DEM every rendered frame and every terrain tile, and the camera moves by whatever the
difference has become. In the mountains it is never zero: deeper tiles rewrite the ground
mid-gesture — a wheel zoom at pitch 78 teleported the centre 2.4 km and ran the zoom
backwards — and the recalculation MapLibre runs when a gesture ends re-derives zoom from
a near-degenerate gap, which jumped a pan release from z12.8 to z13.4 and pulled the
centre back 2.2 km. With the pin off and the camera settled once per finished movement,
the same wheel run holds the centre to a metre and release moves nothing at all.

**Settling adopts a point the camera already looks through.** The centre goes where the
view axis meets the terrain — a point on the axis, so adopting it moves no pixel, and at
the terrain's own elevation, so nothing is left to correct later. Finding it is a march:
sampling the ground along the axis in geometric steps and bisecting the first crossing,
read with `getElevationForLngLatZoom` at the tile zoom the settle is about to set.
Raycasting the centre pixel is quicker but answers from the rendered mesh, and mesh and
DEM disagree by metres on a slope — metres of elevation being metres of camera, that was
a 13.6 m drop felt on letting go. Solving for the crossing instead of marching to it
diverges wherever the ground is steeper than the axis, which in the Alps is most of it:
one pass moved the plane 100 m the wrong way and left 268 m to take back.

**Except while the first view loads.** The hash carries no elevation, so the restored
camera sits on elevation 0 — in the Alps, inside a mountain. Until the user first moves,
each arriving terrain tile re-anchors the centre to the ground the way the pin used to,
so the saved zoom keeps meaning what it meant when the hash was written; a reload
reproduces the camera to within a few metres of DEM refinement.

**The plane the centre rides on is the gesture's, not MapLibre's.** Left to
`calculateCameraOptionsFromCameraLngLatAltRotation`, the distance to the centre is the
camera's height over that plane divided by cos(pitch) — and at the view above, the camera
flies 22 m over a wall that a 1.4× exaggeration has pushed to 5199 m. The distance collapses
and the zoom expressing it snaps from z14 to **z18.7**, tile LOD and all. The shift+drag
orbit names the plane instead and holds the gesture's own, so zoom stays put through a
turn and slides evenly through a tilt — 14.1 → 12.25 tilting up to level, 14.1 → 15.24
tilting down, no step anywhere. During the gesture `camera.elevationFreeze` holds off
MapLibre's remaining elevation writers, as its own terrain gestures do.

**The camera is kept 20 m above the ground under it.** Turning about a pivot in front
swings it through whatever is behind, and at z15.6 on a valley side that was 700 m inside
the mountain, near plane under the surface, frame full of the inside of the terrain.
MapLibre lifts a buried camera itself but does it by rewriting pitch and zoom, which the
next frame of the gesture overwrites. Lifting it here costs the pivot its exact hold while
the camera is riding the limit; the alternative is flying through rock.

**The gesture stops tilting at 85°.** A camera at level has no honest centre — the axis
meets the ground nowhere, so the settle caps the centre 10 km ahead and lifts its plane
to the axis, and MapLibre throws on the matrices at exactly 90. The last few degrees are
left to the built-in gestures; a drag that starts above 85 can still tilt back down.

## URL state

Camera and every control live in the location hash, so a reload restores the view:

```
#map=12.6/46.005/7.7/-135/78&basemap=carto-light&shading=heatmap&shadingVisible=0&exaggeration=3.7
```

`detail=` and `debugPivot=` join them, read once at load; everything else is written back
as it changes.

MapLibre's named-hash mode (`hash: 'map'`) reads the existing params, sets only its own
key and re-serialises the rest, so both writers coexist. `urlState.ts` mirrors MapLibre's
serialisation exactly — otherwise the hash flips between encoded and decoded forms as
each side writes.

Bearing runs −180 to 180 there. `Hash._isValidHash` rejects anything outside that and
drops the whole `map` param with it, so a hand-written `225` silently loads the default
camera instead.

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

**`terrain.pointCoordinate` corrupts past 255 rendered terrain tiles**, silently, returning
a real coordinate from the wrong tile — see [above](#the-raycast-does-not-ask-the-gpu).
`map.terrain.coordsIndex.length` is the count to check it against. Anything that reads that
framebuffer is affected, including MapLibre's own pan and zoom anchoring, so a big window
over dense terrain is worth suspecting whenever a screen-to-ground answer looks absurd.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm verify` | Headless end-to-end at `detail=low`: terrain, elevations, attribution, hash round-trip, colour scheme, shift+drag orbit and its pivot, mobile panel (needs `pnpm dev` running) |
| `pnpm probe:coverage` | What asking past Mapterhorn's depth costs, per place and zoom (needs `pnpm dev` running) |
