# The camera

Shift+drag rotates (horizontal) and tilts (vertical), and the gesture orbits the terrain
in the frame rather than the map centre. Shift+drag is MapLibre's box-zoom gesture by
default; that is given up for this. MapLibre bakes its modifier check into
`MouseMoveStateManager` (`LEFT && ctrlKey || RIGHT`) with no option to change it, so
[shiftDragCamera.ts](../src/shiftDragCamera.ts) is a separate handler. It listens on the
document in the capture phase and stops propagation, so MapLibre's drag handlers never
see the gesture and the map cannot pan while rotating.

## The gesture turns around the terrain in the frame

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

## Which point, though

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
[pivot.ts](../src/pivot.ts) raycasts a 13×9 grid across the middle of the viewport, takes
each hit's distance along the view axis, and weights it by where attention sits (below). A
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

## Attention is a triangle, not a disc

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

## The raycast does not ask the GPU

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
issue or PR in the repository mentions it. The tile count is ours to inflate, too: the
LOD params ([lod.md](lod.md)) are what take the default view from 36 tiles to 319.
`map.terrain.coordsIndex.length` is the count to check against, and anything that reads
that framebuffer is affected, including MapLibre's own pan and zoom anchoring — so a big
window over dense terrain is worth suspecting whenever a screen-to-ground answer looks
absurd.

So the grid marches rays against the DEM instead, with `rayCrossing` in
[cameraAnchor.ts](../src/cameraAnchor.ts) — the same geometric march and bisection the
camera anchor uses to find where the view axis meets the terrain, pointed through an
arbitrary pixel rather than straight ahead. Three things come out of it:

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

## What a camera costs to write down

MapLibre stores a camera as a centre, an elevation and a zoom — where the view axis meets
the ground, and how far away that is. Close in on a mountain, that is a bad way to hold
one, and everything below is the app working around it.

**The ground pin is off, and [cameraAnchor.ts](../src/cameraAnchor.ts) anchors instead.**
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
flies 22 m over a wall that a 1.4× terrain scale has pushed to 5199 m. The distance collapses
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
