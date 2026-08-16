import { defineConfig } from '@playwright/test';

// The suite drives the app through window.map, which is only exposed under
// import.meta.env.DEV — so the server has to be `vite dev`, never `vite preview`.
// 5173 is often squatted by a stale VS Code forward, hence the pinned port.
const PORT = Number(process.env.PORT || 5199);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // A fresh GL context through SwiftShader takes its time; map loads inside the
  // specs wait up to 90s each, so the per-test budget has to clear a few of them.
  timeout: 240_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: {
    baseURL: process.env.URL || `http://localhost:${PORT}/`,
    // GL=metal renders on the real GPU: full Chromium in new-headless mode, since the
    // default headless shell has no GPU path. Default stays SwiftShader — deterministic,
    // works in CI, and reproduces the software-GL-specific bugs the suite guards.
    ...(process.env.GL === 'metal' ? { channel: 'chromium' as const } : {}),
    launchOptions: {
      args:
        process.env.GL === 'metal'
          ? ['--use-angle=metal']
          : ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  webServer: process.env.URL
    ? undefined
    : {
        command: `pnpm dev --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/`,
        reuseExistingServer: true,
      },
});
