import { defineConfig } from 'vite';

export default defineConfig({
  // Pre-bundling rewrites maplibre's worker entry into a path that 404s in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
