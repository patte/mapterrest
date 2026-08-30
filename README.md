# Mapterrest

Mapterrest is a fullscreen 3D map viewer built on MapLibre. It uses pre-baked Terrarium
tiles from [Mapterhorn](https://mapterhorn.com) for terrain, then layers on selectable
basemaps, elevation overlays along with a set of useful tools.

## Features

- [x] Global elevation model from [Mapterhorn](https://mapterhorn.com)
- [x] Subject detection for intuitive map controls
- [x] Basemaps from: OpenFreeMap, Carto, Maptiler
- [x] Overlays: Hillshading, Heightmap (green to white, greyscale)
- [x] Auto-exposure: adjusts the colour gradient to the visible terrain, inspired by [Heightmapper](https://tangrams.github.io/heightmapper/)
- [x] Geosearch: fly to any place, via the [MapTiler](https://www.maptiler.com/) Geocoding API
- [x] Screenshot export: A2–A6, Letter, Legal, Tabloid
- [x] Permalinks: camera position, basemap, overlay, and settings are all encoded in the URL
- [x] Client side error reporting to [Bugsink](https://bugsink.com/)

Big thanks to all geospatial contributors and generous providers for making it possible to see the world in all these interesting and beautiful ways!

## Development

For local development follow these steps:

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

### Testing

```bash
pnpm verify orbit             # one spec, seconds
pnpm verify                   # whole suite, ~3 min on a Mac GPU
GL=swiftshader pnpm verify    # the CI renderer: software GL, sequential, ~12 min
```

`pnpm verify` runs the headless end-to-end specs in `tests/`, one file per subject. On a
Mac it renders on the real GPU and runs fully parallel; `GL=swiftshader` switches to the
deterministic software renderer CI uses — run that when a change could interact with
software GL, and before a release. A full SwiftShader run takes about 12 minutes on an
M2 Mac.

Provider assets (DEM and basemap tiles, styles, glyphs) are served from a gitignored
`.tile-cache/`, so repeated runs cost the providers nothing. `rm -rf .tile-cache` clears
it — do that when Mapterhorn republishes tiles.

`pnpm browser:start` keeps a browser server up for verify runs to connect to instead of
launching their own; `pnpm browser:stop` takes it down. Optional — everything works
without it.

## Prod

I currently deploy this manually with [./scripts/deploy.sh](scripts/deploy.sh) to bunny cdn. For this to work `cp .env.deploy.example .env.deploy` and set the required envs.

## Keys

Most of the integrated providers don't require an API key and just work.

MapTiler has a generous free tier which we use for local development and for hosting on mapterrest.com. If you want to run your own instance of Mapterrest, you create your MapTiler API key at [https://www.maptiler.com/cloud/](https://www.maptiler.com/cloud/) and set it in `.env` as `VITE_MAPTILER_API_KEY=yourkey` like shown in [.env.example](.env.example).

## Docs

- [docs/mapterhorn.md](docs/mapterhorn.md): Terrain source: endpoints, archives, coverage depth, accuracy
- [docs/lod.md](docs/lod.md): Terrain LOD: the `tileSize` lever, horizon parameters, and detail levels
- [docs/exposure.md](docs/exposure.md): Auto-exposure: what counts as visible, and how the hillshade light is set
- [docs/camera.md](docs/camera.md): Camera orbit: pivot, raycast, and the anchor model
- [docs/thumbnails.md](docs/thumbnails.md): Live previews: scene spec, hidden mini map walk, refresh policy
- [docs/screenshots.md](docs/screenshots.md): Print exports: grown-viewport capture, renderer ceilings, credits, file metadata
- [docs/geosearch.md](docs/geosearch.md): Geosearch: the morphing pill, landing a camera on terrain, errors and credits
- [docs/contours.md](docs/contours.md): Contour lines: traced in-browser from the DEM, intervals, detail ceiling, labels

## Contributing

All contributions are welcome! Please open an issue for questions, feature requests, bug reports or criticisms... or even better submit a pull request!

## License

[MIT](LICENSE). If Mapterrest is useful to you, a link back to this project is appreciated.
