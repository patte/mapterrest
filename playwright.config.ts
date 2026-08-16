import { defineConfig } from '@playwright/test';
import { glLaunchOptions, residentServer } from './scripts/browser.mjs';

const gl = glLaunchOptions();
// A resident browser from `pnpm browser:start` is reused when its GL mode matches;
// otherwise each run launches its own.
const resident = residentServer(gl.mode);

// The suite drives the app through window.map, which is only exposed under
// import.meta.env.DEV — so the server has to be `vite dev`, never `vite preview`.
// 5173 is often squatted by a stale VS Code forward, hence the pinned port.
const PORT = Number(process.env.PORT || 5199);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // SwiftShader renders on ~5 CPU threads per page, so parallel workers starve each other
  // past the 90s map-load budget; only the GPU-backed mode can afford real parallelism.
  workers: gl.mode === 'metal' ? undefined : 1,
  // A fresh GL context through SwiftShader takes its time; map loads inside the
  // specs wait up to 90s each, so the per-test budget has to clear a few of them.
  timeout: 240_000,
  reporter: 'list',
  use: {
    baseURL: process.env.URL || `http://localhost:${PORT}/`,
    channel: gl.channel,
    // A warm launch takes ~2s; under machine load one of the parallel launches can hang
    // outright, and the default 180s launch timeout stalls the whole run before failing.
    // A minute is enough headroom for a cold first-ever launch (macOS bundle
    // verification) while surfacing a hang while the run is still worth interrupting.
    launchOptions: { args: gl.args, timeout: 60_000 },
    connectOptions: resident ? { wsEndpoint: resident.wsEndpoint } : undefined,
  },
  webServer: process.env.URL
    ? undefined
    : {
        command: `pnpm dev --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: true,
      },
});
