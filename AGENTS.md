# Working in mapterrest

## Verifying a change

Cheap oracles first: `pnpm typecheck`, `pnpm build`. Then the spec that covers the change:

```
GL=metal pnpm verify orbit        # one spec, seconds
GL=metal pnpm verify              # whole suite, ~1 min
pnpm verify                       # SwiftShader default, sequential, ~7 min
```

Specs live in `tests/`, one file per subject. Run the full suite only for broad changes;
run the SwiftShader default only when the change could interact with software GL or CI.

## The two GL modes

`scripts/browser.mjs` is the one definition of how a browser is launched — the playwright
config and the spike scripts both import it.

- Default is SwiftShader: deterministic, runs in CI, and reproduces software-GL bugs like
  the 255-tile coords-framebuffer overflow. It renders on ~5 CPU threads per page, so the
  config pins it to one worker — parallel SwiftShader workers starve each other past the
  90s map-load budget and fail spuriously.
- `GL=metal` renders on the real GPU via full Chromium in new-headless mode (the headless
  shell has no GPU path) and runs the suite fully parallel. First-ever launch of Chrome
  for Testing is slow (macOS verifies the bundle); a cold run can time out where the warm
  rerun passes.

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
