import { defineConfig } from 'vite';

export default defineConfig({
  // Pre-bundling rewrites maplibre's worker entry into a path that 404s in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: {
    // maplibre in its own chunk: it only changes on a dependency bump, so a deploy of
    // app code leaves it cached in returning visitors' browsers.
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'maplibre', test: /maplibre-gl/ }] } },
    },
    // The maplibre chunk is an irreducible ~900 kB — everything in it boots the map on
    // page one — so the warning is set where it speaks only if something new grows.
    chunkSizeWarningLimit: 1000,
  },
});
