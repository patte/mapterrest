# Previews: one spec, one hidden map

Every tile in the tray shows what the map would look like after clicking it. That
promise is kept literally: a preview is the same scene composition as the main view,
rendered at the same camera, and never a canned icon — which is why, with the opaque
grey heightmap selected, the whole basemap row honestly goes grey.

## The spec

`scene.ts` splits what a map *shows* from which map shows it. A `SceneSpec` — basemap
and its visibility, the colour ramp, hillshade, contours and their labels, the exposure
range, terrain scale — plus `attachScene()` makes any MapLibre map render that spec,
owning the `style.load` re-attachment (DEM source, terrain, sky, backdrop, overlay
layers) and diffing changes onto the live map. The main view is one attached scene fed
by the controls; every preview is another spec on a second map. Anything added to the
spec and the composer appears in the main view and in every preview with no
thumbnail-specific code.

Each tile's spec is a variation of the current one: the relief line varies one toggle
(its "none" turns both off), the colour line varies the ramp, the basemap row varies
the basemap under the current overlays. Identical specs render once and land on every
tile sharing them — the selection sits in every row. Ramp previews freeze the exposure
they would get if selected — an untouched toggle follows each ramp's default — measured
once per walk rather than tracked.

## The walk

One hidden 96 px map (`thumbnails.ts`) — never one per tile, GL contexts are capped and
each costs like a map — walks the variants: overlay lines first, all layer swaps on the
current style, then the basemap row at a `setStyle` per tile. Each variant settles on
`idle` and is snapshotted off a `preserveDrawingBuffer` canvas; `fadeDuration: 0`, or
crossfades land half-blended in the shot. The mini map runs `low` detail and a camera
zoomed out under the main one (`ZOOM_OUT`) — at the main zoom a square tile shows a
sliver of the frame's centre; the full ~4 levels that would fit the frame render a view
a switch would never show.

Walks never overlap and every seam bites if they do:

- `idle` can fire in the seam of a style swap, before the incoming style has asked for
  its tiles — a snapshot there is a navy void. The settle re-arms until the style and
  its tiles are actually loaded, and a basemap swap first waits for its `style.load`.
- The old terrain must not draw over an incoming style: the painter's depth pass reads
  `style.projection`, unresolved until the style lands, and every frame until then
  throws. The scene drops terrain across the swap and restores it — with the camera
  elevation stashed and put back — at `style.load`.
- A variant can still land on a mini map whose last style never finished (a timed-out
  tile server, an aborted walk) and MapLibre throws on the swap. Variants fail alone
  inside the walk, and the walk chain itself is rejection-proof — a rejected link once
  silently swallowed every refresh after it, which reads as "thumbnails stopped
  working" until reload.

## The policy

The main map's `idle` is the only trigger there is: a camera that settles, a control
that changed the scene, an exposure ease that finished — each dirties the map and idles
after. From there:

- A refresh waits 3 s of stillness; `movestart` takes back the pending timer, the walk
  in flight, and any retry. A moving camera costs no renders and no tile fetches.
- Empty tiles get eagerness instead: until a first preview lands, the delay is 250 ms —
  a fresh page fills as soon as the map first idles.
- A walk that lost variants to timeouts re-runs once, 15 s later, unless superseded —
  stale thumbs heal on a still map, and a downed tile server is not polled forever.
- Each tile remembers the spec + camera of its delivered snapshot, and a variant whose
  every tile already shows that render is skipped whole. What a selection change
  re-renders, out of the ~12 variants a full walk carries:

  | Change | Renders |
  | --- | --- |
  | basemap | ~6 — overlay lines and the "none" tile; the other basemaps don't reference it |
  | an overlay | ~10 — the other lines and the basemap row; the line's own tiles keep their context |
  | camera settled again, nothing else | ~12 |
  | nothing | 0 |

- Folded, the tray is still not off: the settings tile previews the current view. That
  preview never uses the walk — see below — so a folded tray costs no mini map at all.
  Only a hidden tab stops everything.

The mini map is real work on software GL — it roughly halves SwiftShader's frame
budget, which is what surfaced the exposure ease's clamped-dt bug (see the comment at
the `dt` in `exposure.ts`). Specs that need a fast page under SwiftShader should not
carry a ramp through a reload.

## The settings tile

The settings tile previews the view itself, and the view itself is already rendered:
the preview is a square cut from the middle of the main map's frame, redrawn and copied
in the same task (the WebGL buffer is only valid until the browser composites, so there
is no `preserveDrawingBuffer` to pay for — the same trick the screenshot capture uses).
It refreshes on the walk's schedule, keyed on spec + camera + canvas size so an
unchanged view is not worth a redraw, and never involves the mini map — which also
means it shows the frame at its own zoom rather than the walk's `ZOOM_OUT`, arguably
the more honest "this is your current view".

## The bake

A first load used to pay the full walk before the tray showed anything: the mini map,
seven basemap styles, and all their tiles. Measured on a dev server, that walk was most
of what a first load cost — 337 provider requests and 14.8 MiB against 113 and 3.4 MiB
without it. `pnpm bake:thumbs` (`scripts/bake-thumbs.mjs`) renders the walk once per
colour scheme at the default view and writes the results into `src/assets/thumbs/` —
17 webp files and a generated manifest — and the app answers a first load's walk from
those instead.

A preview is a function of the camera, the selection, and the colour scheme, so a baked
image is only honest for the exact render it replaces. The walk therefore asks the
manifest per variant (`bakedThumbs.ts`), with the spec and camera it is about to
render: a hit is delivered like any snapshot, and only the first miss creates the mini
map. Matching is semantic rather than byte-exact — the camera anchor settles the
default view a hair off the constructor constants, and a ramp's auto-exposure range
follows the viewport — with tolerances a 96 px tile four zoom levels out cannot show.
Everything fails open: a shared-link camera, a stale bake after a style change, a range
past the tolerance each cost one live render, never a wrong image. Startup additionally
paints the baked images as stand-ins before the map's first frame (lenient on exposure,
whose real range needs loaded DEM tiles; gated on the hash carrying no camera); the
walk then confirms or replaces them.

The output is checked in, so a deploy never regenerates it and needs neither a GPU nor
the tile servers. A re-run keeps the checked-in bytes for every render that comes out
perceptually identical — GPU renders are not byte-reproducible, and the webp encoder
diverges on any pixel of jitter — so git stays quiet unless an image actually changed.
Re-run the bake when the default view or the style list changes —
a forgotten re-run shows up as the walk quietly rendering live again, which
`tests/thumbnails.spec.ts` would catch — or when upstream styles drift enough to notice
at 96 px, which nothing detects. `#bakedThumbs=0` turns the bake off for a session;
the bake script itself loads the app that way, since the walk it captures must render
live rather than answer from the manifest being replaced.
