import { defineConfig, type Plugin } from 'vite';
import { marked } from 'marked';

/** `import html from './x.md'` — rendered here at build time, so marked never ships. */
const markdown = (): Plugin => ({
  name: 'markdown-html',
  transform(src, id) {
    if (!id.endsWith('.md')) return;
    const html = (marked.parse(src, { async: false }) as string)
      // The app is fullscreen; a link that replaces it loses the user's view.
      .replaceAll('<a ', '<a target="_blank" rel="noopener" ');
    return { code: `export default ${JSON.stringify(html)};`, map: null };
  },
});

export default defineConfig({
  plugins: [markdown()],
  // Pre-bundling rewrites maplibre's worker entry into a path that 404s in dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  build: {
    // Maps for Bugsink (deploy.sh injects debug IDs and uploads them); 'hidden'
    // leaves the sourceMappingURL comment out, so visitors' browsers never fetch them.
    sourcemap: 'hidden',
    // maplibre and sentry in their own chunks: they only change on a dependency bump,
    // so a deploy of app code leaves them cached in returning visitors' browsers.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /maplibre-gl/ },
            { name: 'sentry', test: /@sentry/ },
          ],
        },
      },
    },
    // The maplibre chunk is an irreducible ~900 kB — everything in it boots the map on
    // page one — so the warning is set where it speaks only if something new grows.
    chunkSizeWarningLimit: 1000,
  },
});
