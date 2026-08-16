# Working in mapterrest

## Verifying a change

Cheap oracles first: `pnpm typecheck`, `pnpm build`. Then the spec that covers the change:

```
pnpm verify orbit                 # one spec, seconds
pnpm verify                       # whole suite, ~1 min on a Mac
GL=swiftshader pnpm verify        # the CI renderer, sequential, ~7 min
```

Specs live in `tests/`, one file per subject. Run the full suite only for broad changes;
run the SwiftShader mode when the change could interact with software GL, and before a
release, to keep that path honest.

## The two GL modes

`scripts/browser.mjs` is the one definition of how a browser is launched — the playwright
config and the spike scripts both import it. An explicit `GL=metal` / `GL=swiftshader`
wins; otherwise a Mac gets Metal and CI or Linux gets SwiftShader.

- Metal renders on the real GPU via full Chromium in new-headless mode (the headless
  shell has no GPU path) and runs the suite fully parallel. First-ever launch of Chrome
  for Testing is slow (macOS verifies the bundle); a cold run can time out where the warm
  rerun passes.
- SwiftShader is deterministic, needs no GPU, and reproduces software-GL bugs like the
  255-tile coords-framebuffer overflow. It renders on ~5 CPU threads per page, so the
  config pins it to one worker — parallel SwiftShader workers starve each other past the
  90s map-load budget and fail spuriously.

## Resident browser

`pnpm browser:start` keeps a browser server up and records it in `.browser-server.json`;
verify runs and probes connect to it instead of launching (saves the process launch,
worth ~0.5s on a single spec) and fall back to launching whenever it is absent or its GL
mode does not match. `pnpm browser:stop` takes it down. Opt-in — nothing requires it.

## Tile cache

The specs serve every provider asset (DEM tiles, basemap tiles, styles, glyphs — anything
not from the dev server) out of a gitignored `.tile-cache/` disk cache shared across
workers and runs, so repeated runs cost the providers nothing. `TILECACHE=0` goes to the
network; `rm -rf .tile-cache` empties it — there is no invalidation, so clear it when
Mapterhorn republishes tiles. `probe:coverage` deliberately bypasses it: that script
*measures* tile traffic, and a cache would falsify its numbers.

## Gotchas

- `window.map`, `window.visibleRange`, `window.choosePivot`, `window.projectPoint` exist
  only under `import.meta.env.DEV` — anything driving the app needs `vite dev`, never
  `vite preview`. The playwright config and `probe:coverage` start their own dev server;
  port 5173 is often squatted by a stale VS Code forward, which is why they pin 5199.
- The specs still contain fixed sleeps, which are contention-sensitive: don't run
  CPU-heavy work alongside a SwiftShader run, or elevations get probed before the right
  tiles are in.

## Spike scripts

One-off probe/PoC scripts are welcome in `scripts/`; `probe-coverage.mjs` is the
precedent: import `glLaunchOptions()` from `scripts/browser.mjs`, reuse a dev server
answering at `URL` or spawn your own on a pinned port and kill it on exit, and settle on
conditions (`map.areTilesLoaded() && map.loaded()`) rather than fixed sleeps — a fixed
pause under-measures whatever outlasts it.
