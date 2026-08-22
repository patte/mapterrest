# Previews: one spec, one hidden map

Every tile in the tray shows what the map would look like after clicking it. That
promise is kept literally: a preview is the same scene composition as the main view,
rendered at the same camera, and never a canned icon — which is why, with the opaque
grey heightmap selected, the whole basemap row honestly goes grey.

## The spec

`scene.ts` splits what a map *shows* from which map shows it. A `SceneSpec` — basemap,
shading, their visibilities, the exposure range, terrain scale — plus `attachScene()`
makes any MapLibre map render that spec, owning the `style.load` re-attachment (DEM
source, terrain, sky, backdrop, shading layer) and diffing changes onto the live map.
The main view is one attached scene fed by the controls; every preview is another spec
on a second map. Anything added to the spec and the composer — contours, say — appears
in the main view and in every preview with no thumbnail-specific code.

Each tile's spec is a variation of the current one: the overlay row varies the shading
over the current basemap, the basemap row varies the basemap under the current shading,
the "none" tiles turn one layer off. Identical specs render once and land on every tile
sharing them — the selected pair sits in both rows. Ramp previews freeze the exposure
the main view would give them, measured once per walk rather than tracked.

## The walk

One hidden 96 px map (`thumbnails.ts`) — never one per tile, GL contexts are capped and
each costs like a map — walks the variants: overlay row first, all layer swaps on the
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
  re-renders, out of the 12 variants a full walk carries:

  | Change | Renders |
  | --- | --- |
  | basemap | ~6 — overlay row, "none" tile, settings tile; the other basemaps don't reference it |
  | shading | ~9 — basemap row and ramps; the other shadings keep their context |
  | camera settled again, nothing else | 12 |
  | nothing | 0 |

- Folded, the tray is still not off: the settings tile previews the current view, so
  the walk keeps exactly that one variant fresh. Only a hidden tab stops everything.

The mini map is real work on software GL — it roughly halves SwiftShader's frame
budget, which is what surfaced the exposure ease's clamped-dt bug (see the comment at
the `dt` in `exposure.ts`). Specs that need a fast page under SwiftShader should not
carry a ramp through a reload.
