# Screenshots: the print is a bigger map, not denser pixels

The camera pill beside the hint opens framing mode: a screen-fixed, paper-aspect
rectangle with the map fully live behind it. A dropdown picks the paper (A2–A6, Letter,
Legal, Tabloid), a rotate button flips the orientation, and capture downloads a PNG of
exactly what the rectangle framed, at 300 dpi for that paper — A4 landscape is
3508×2480. Shift+capture is the clean shot: no attribution or logos on the pixels (the
file's metadata still carries the credits, see below). Escape or the X leaves the mode.

## Why pixel ratio alone is not quality

The obvious way to render at print density — raise the canvas's pixel ratio — sharpens
less than it seems. MapLibre selects tiles against the map's CSS size; pixel ratio only
rasterises *those* tiles more densely. Vector basemaps genuinely sharpen, but the
terrain mesh, the DEM-derived shadings and every raster (satellite above all) are
upscales of tiles that were chosen for a screen, not a sheet of paper. An A2 done this
way is a soft A4 with crisp labels.

## The grown viewport

So the capture renders a genuinely bigger map. Growing the container k× while adding
log₂ k of zoom reproduces the same view exactly — the camera's physical position is
unchanged, there are just more pixels — which was probed at ~1 px of drift across a
2× frame. Tile selection now happens at the print's true size: DEM, basemap and
satellite all load up to two zoom levels deeper than the screen showed.

The growth is capped at **4×**; whatever remains of the ratio is pixel density on top.
The final canvas is the same size either way — the split only decides how much of it is
real tile detail. The cap is measured, not taste:

| Growth | Outcome |
| --- | --- |
| 2× / 4× | clean captures, A4 through A2 |
| ~6× (uncapped A2) | a blank white export, or an exception inside MapLibre's render loop, and a session that can wedge |

An "ultra" toggle lifting the cap was built and abandoned on that evidence. The engine
has real ceilings up there — among them a terrain coords framebuffer that indexes at
most 255 terrain tiles per frame — and past them the failure is not a graceful glitch.
A capture that does die restores the map, lifts the veil and says so, rather than
hanging.

Capture takes seconds now, not milliseconds: the veil covers the shapeshifting map
while the deeper tiles settle. Repeat captures of the same view are nearly free — the
tiles carry a week of HTTP cache.

## The camera, handled with tongs

Three things about the camera made this hard, each found by a probe:

- **The orbit anchor** re-settles the camera on programmatic zoom and drags the framing
  hundreds of pixels off. The capture wraps itself in the anchor's own
  `suspend()`/`resume()`, built for gestures — and this is one.
- **The pivot stack drives the camera unclamped** (centre elevation 0, far below the
  terrain). Rendered from that representation, the grown deep-zoom frame starves the
  terrain drape: tiles with no basemap coverage smear their edges into grey curtains.
  The *clamped* representation of the very same view renders cleanly, and
  `setCenterClampedToGround()` is public runtime API — so the capture borrows the clamp
  for its duration and hands back the pivot's representation afterwards.
- **Restoring by zoom number is not restoring the view.** The clamp rewrites elevation
  and what the numbers mean; setting the old zoom back left a 236 px drift. The capture
  saves the full representation — centre, zoom, pitch, bearing, *elevation* — and jumps
  back to all of it at once. The spec holds this with a projection oracle: the
  Matterhorn's screen position before and after must agree within 5 px.

## Credits, on paper and in the file

The attribution line is drawn onto the image on a small pill, with the provider logos
above it — but only the logos the print actually owes. MapTiler's free tier asks for
their mark; Mapterhorn's TileJSON asks only for the © text, so their wordmark joins the
stack only when MapTiler's mark is due anyway.

Every export also carries metadata, spliced in as PNG chunks behind IHDR (canvas
`toBlob` writes none):

| Chunk | Carries | Why |
| --- | --- | --- |
| `pHYs` | 300 dpi | without it viewers assume 72 and a print dialog sizes an A4 as a metre-wide poster |
| `tEXt Comment` | the view's permalink | the hash holds camera and layers — any export leads back to the exact view that made it |
| `iTXt Copyright` | the attribution line | rides along even in the clean shot; iTXt because tEXt is Latin-1 and UTF-8-minded viewers turn its bare © into `?` |
| `tEXt Software`, `Creation Time` | provenance | |
| `eXIf` | the view centre as GPS | a minimal hand-built TIFF; photo libraries pin the export on their world map |

On printer resolution: an inkjet's "5760×1440 dpi" counts single-colour droplet
positions, and it takes a cluster of droplets to halftone one image pixel — the image
detail such printers resolve is on the order of 300–400 ppi, and their drivers resample
to a ~360 ppi grid internally. 300 dpi input prints sharp; more would add pixels the
paper cannot show, at file sizes and canvas dimensions the capture ceiling above has
opinions about.
