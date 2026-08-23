# Geosearch

A magnifier pill in the top-left corner — the one corner no other control claims —
searching the [MapTiler Geocoding API](https://docs.maptiler.com/cloud/api/geocoding/)
with the same key the satellite basemap uses. Without a key the pill never appears, the
same policy that drops the satellite tile from the tray: better absent than a control
that can only 401.

## One pill, two widths

The collapsed pill *is* the search box: the magnifier button, the input and the × are
always laid out inside one rounded box that is 35 px wide at rest and animates to 320 px
on open (click, `/`, or ⌘K), the input fading in from under the clip. Two details keep
the magnifier from jumping during the slide: the box clips with `overflow: clip` rather
than `hidden` — a hidden-overflow box still scrolls programmatically, and focusing the
clipped input scrolled the magnifier out of view — and the focus itself passes
`preventScroll`. Results drop in below as a card; while they are open, arrows walk them,
Enter takes the active row (or the first), Escape and the × close everything.

Collapse is lazy about work in progress: focus leaving an *empty* box folds it back to
the pill, but a typed query survives a stray click on the map — the exits for it are
submitting, Escape, or the ×. Queries go out debounced (250 ms, two characters minimum),
biased by `proximity` toward the current centre so "Grindelwald" over the Alps does not
land in Australia, in the browser's language, and under an `AbortController` so a stale
response can never paint over a newer query's results.

## Landing the camera

A selected result only moves the camera — no marker, no contour. The camera movement is
the answer, and a marker would need a lifecycle of its own to get rid of it again. An
area result (a municipality, a region) carries a bbox and is framed with `fitBounds`; a
point result is flown to at a zoom by its type (address 13.5, street 13, otherwise
12.5). Bearing is kept, so the answer stays a terrain view rather than a reset to
top-down north.

Pitch is not kept: it eases down to at most 45°. At the app's default 78° the target
pose for a point flight sits inside the mountainside — MapLibre rescues the camera
upward, and the searched place ends up below the screen (measured: the target projected
to y≈990 in a 900 px viewport, and still y≈879 at 60° pitch). At 45° and these zooms the
camera stays kilometres above any relief, and the target lands on the view axis.

Numbers read back after the flight are not the numbers flown to: the camera anchor
(docs/camera.md) re-expresses the camera on every `moveend` — same pixels, the centre
renumbered to where the view axis meets the terrain, the zoom to that distance. The spec
therefore asserts arrival in screen space — bbox corners project into the viewport, a
point projects onto the view axis — never against `getCenter()`/`getZoom()`.

## Errors

A failed geocoding response renders where the results would be, naming the HTTP status
and, scoped by what actually came back (src/notice.ts), the likely reason: a body
naming an invalid or missing key is reworded to say so; on the remaining auth-shaped
statuses (402/403/429, where an exceeded free tier lands) the note adds that the shared
free key can run over its limits; and a body of short readable words is quoted, so an
unrecognised failure still shows the server's own explanation. Basemap-side MapTiler failures
(style or tiles, e.g. the key over quota) surface as a dismissible toast, top-centred,
throttled to one a minute since a dead style errors once per tile. Subscribing to the
map's `error` event silences MapLibre's own console reporting, so everything not
recognised as a MapTiler failure is re-logged.

## Credits

The first query latches the MapTiler logo into the corner stack for the session — their
Geocoding API asks for attribution just as the styles do — and the logo's label says
which of basemap and search it credits. Print exports keep crediting only what is in the
image: a mark up solely for geosearch carries `data-search-only`, and the exporter
(src/screenshot.ts) leaves it off paper.

## Testing

`tests/geosearch.spec.ts` mocks the geocoding endpoint in every case — the suite must
not depend on (or spend) geocoding quota, and fixed features make the assertions exact.
Playwright matches routes newest-first, so the mock simply registers after the tile
cache's catch-all. `scripts/shoot-geosearch.mjs` renders the pill, the results, the
error note and the toast into `shots/` in both themes.
