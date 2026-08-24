// Bakes the tray previews: runs the thumbnail walk live at the default view, once per
// colour scheme, and writes the results into src/assets/thumbs/ as webp files plus a
// generated manifest module. The app serves these on first load and skips the walk's
// renders — and their tile requests — for every entry that still matches what the walk
// would render (src/bakedThumbs.ts); a stale bake costs a live render, never a wrong
// image. The output is checked in, so deploys never regenerate it — re-run when the
// default view, the style list, or upstream tiles change.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;

// window.map and the __thumb* probes only exist under import.meta.env.DEV, so the
// server must be `vite dev`; reuse one already answering at URL_, else start our own.
const up = async () => {
  try {
    return (await fetch(URL_, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};
let server = null;
if (!(await up())) {
  server = spawn('pnpm', ['dev', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!(await up())) {
    if (Date.now() - t0 > 15000) throw new Error(`no dev server came up at ${URL_}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const gl = glLaunchOptions();
const resident = residentServer(gl.mode);
const browser = resident
  ? await chromium.connect(resident.wsEndpoint)
  : await chromium.launch({ channel: gl.channel, args: gl.args });

// The two schemes bake the same default camera; anything further apart than the
// matcher's own tolerance means the settle was not deterministic — worth a look, not a
// silent half-usable manifest.
const CAMERA_EPS = 1e-3;
const sameCamera = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= CAMERA_EPS);

/** spec JSON → { id, spec, camera, webp, schemes } — one image per distinct render. */
const entries = new Map();

for (const colorScheme of ['light', 'dark']) {
  const page = await browser.newPage({
    // The suite's viewport, so its default-load spec sees the exact ranges baked here;
    // real viewports lean on the matcher's exposure tolerance instead.
    viewport: { width: 1400, height: 900 },
    // Retina tiles stay sharp; a 1x display just downscales.
    deviceScaleFactor: 2,
    colorScheme,
  });
  // The walk must render live — with the bake enabled it would answer from the very
  // manifest this run replaces.
  await page.goto(`${URL_}#bakedThumbs=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  // Every row tile rendered, all against one camera: a mid-walk anchor settle leaves a
  // mix behind, and the walk after it re-renders the lot.
  await page.waitForFunction(
    () => {
      const tiles = document.querySelectorAll('#shading-thumbs .tile, #basemap-thumbs .tile').length;
      const rendered = window.__thumbRendered;
      const images = window.__thumbImages;
      if (!rendered || rendered.size < tiles || !images || images.size < tiles) return false;
      return new Set([...rendered.values()].map((k) => JSON.stringify(JSON.parse(k)[1]))).size === 1;
    },
    null,
    { timeout: 240000 },
  );
  const shots = await page.evaluate(async () => {
    const toWebp = async (png) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.85);
    };
    const out = [];
    for (const [id, key] of window.__thumbRendered) {
      const [spec, camera] = JSON.parse(key);
      out.push({ id, spec, camera, webp: await toWebp(window.__thumbImages.get(id)) });
    }
    return out;
  });
  for (const shot of shots) {
    const specKey = JSON.stringify(shot.spec);
    const seen = entries.get(specKey);
    if (!seen) entries.set(specKey, { ...shot, schemes: new Set([colorScheme]) });
    else if (!sameCamera(seen.camera, shot.camera))
      throw new Error(`camera drifted between bakes for ${shot.id}: ${seen.camera} vs ${shot.camera}`);
    else seen.schemes.add(colorScheme);
  }
  await page.close();
}
// Named by the first tile the render lands on; a scheme suffix separates the renders
// that exist per scheme (the shading row varies with the default basemap).
const list = [...entries.values()];
for (const e of list) {
  const base = e.id.replace(':', '-');
  e.name = e.schemes.size === 2 ? base : `${base}-${[...e.schemes][0]}`;
}
const names = new Set(list.map((e) => e.name));
if (names.size !== list.length) throw new Error('bake produced colliding file names');
list.sort((a, b) => a.name.localeCompare(b.name));

const outDir = fileURLToPath(new URL('../src/assets/thumbs/', import.meta.url));

// A render is not byte-reproducible (parallel float math, atlas packing order follows
// tile arrival), and the webp encoder diverges on any pixel of it. Keep the checked-in
// bytes wherever the new render shows the same image, so a re-run leaves git quiet
// unless something actually changed; anything past the thresholds stays fresh.
const DIFF_TOLERANCE = 8; // per channel, out of 255 — render jitter sits well under it
// Fraction of pixels past the tolerance. Generous because jitter re-encoded at q0.85
// moves low-contrast blocks measurably (dark styles reach ~5%) while looking identical;
// a real change — a style redesign, another exposure, moved tiles — moves tens of %.
const KEEP_BELOW = 0.05;
const old = new Map();
try {
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.webp')) old.set(f, readFileSync(join(outDir, f)));
  }
} catch {}
let kept = 0;
if (old.size > 0) {
  const page = await browser.newPage();
  for (const e of list) {
    const previous = old.get(`${e.name}.webp`);
    if (!previous) {
      console.log(`  ${e.name}.webp: new`);
      continue;
    }
    const fraction = await page.evaluate(
      async ([a, b, tolerance]) => {
        const decode = async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        };
        const [ia, ib] = [await decode(a), await decode(b)];
        if (ia.width !== ib.width || ia.height !== ib.height) return 1;
        let past = 0;
        for (let i = 0; i < ia.data.length; i += 4) {
          for (let ch = 0; ch < 4; ch++) {
            if (Math.abs(ia.data[i + ch] - ib.data[i + ch]) > tolerance) {
              past++;
              break;
            }
          }
        }
        return past / (ia.data.length / 4);
      },
      [`data:image/webp;base64,${previous.toString('base64')}`, e.webp, DIFF_TOLERANCE],
    );
    const percent = `${(fraction * 100).toFixed(2)}% of pixels past the tolerance`;
    if (fraction < KEEP_BELOW) {
      e.keep = previous;
      kept++;
      console.log(`  ${e.name}.webp: ${percent} — kept as checked in`);
    } else {
      console.log(`  ${e.name}.webp: ${percent} — updated`);
    }
  }
  await page.close();
}
// Closing a connected browser only disconnects; the resident server stays for the next run.
await browser.close();
server?.kill();

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const e of list) {
  writeFileSync(join(outDir, `${e.name}.webp`), e.keep ?? Buffer.from(e.webp.split(',')[1], 'base64'));
}
const imports = list.map((e, i) => `import t${i} from './${e.name}.webp';`).join('\n');
const rows = list
  .map((e, i) => `  { spec: ${JSON.stringify(e.spec)}, camera: ${JSON.stringify(e.camera)}, url: t${i} },`)
  .join('\n');
writeFileSync(
  join(outDir, 'manifest.ts'),
  `// Generated by scripts/bake-thumbs.mjs (\`pnpm bake:thumbs\`) — do not edit by hand.
// Re-run the bake when the default view, the style list, or upstream tiles change;
// until then this file and its images are checked in so a deploy never regenerates them.
import type { BakedThumb } from '../../bakedThumbs';

${imports}

export const BAKED_THUMBS: BakedThumb[] = [
${rows}
];
`,
);
console.log(`baked ${list.length} previews into src/assets/thumbs/ (${kept} unchanged, kept as checked in)`);
