# The Mapterhorn source

Copernicus GLO-30 worldwide, refined with national high-resolution models where they
exist, baked to terrarium and served from PMTiles archives behind Cloudflare. The hosted
endpoint needs no key and answers `access-control-allow-origin: *` with a week of
`cache-control`, so the browser reads it directly:

```js
{
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 256, // the tiles are 512 px — see lod.md for why this says otherwise
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
