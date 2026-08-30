// patte's repro: at z16.5 near Monte Guglielmo, contour lines look different arriving
// from 15.5 than from 17.5. Shoot both arrivals plus a fresh control, and dump the
// contour source's visible tile coordinates (canonical z vs overscaled z) per arm.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const OUT = new URL('../shots/', import.meta.url).pathname;
const PORT = 5199;
const URL_ = `http://localhost:${PORT}/`;

const up = async () => {
  try { return (await fetch(URL_, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
};
let server = null;
if (!(await up())) {
  server = spawn('pnpm', ['dev', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!(await up())) {
    if (Date.now() - t0 > 15000) throw new Error('no dev server');
    await new Promise((r) => setTimeout(r, 250));
  }
}

const gl = glLaunchOptions();
const resident = residentServer(gl.mode);
const browser = resident
  ? await chromium.connect(resident.wsEndpoint)
  : await chromium.launch({ channel: gl.channel, args: gl.args });

const hash = (z) =>
  `#map=${z}/45.93998/10.190674/0/0&contours=1&shadingVisible=0&contourLabels=0&collapsed=1`;
const settle = async (page) => {
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, { timeout: 90000 });
  await page.waitForTimeout(600);
};
const jump = async (page, zoom) => {
  await page.evaluate((z) => window.map.jumpTo({ zoom: z }), zoom);
  await settle(page);
};
const ease = async (page, zoom) => {
  await page.evaluate((z) => window.map.easeTo({ zoom: z, duration: 1200 }), zoom);
  await page.waitForTimeout(1300);
  await settle(page);
};
const state = (page) =>
  page.evaluate(() => {
    // the bundle is minified: find every source-cache registry by shape, not name
    const style = window.map.style;
    const found = {};
    let slot = 0;
    for (const v of Object.values(style)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      let registry = false;
      try {
        for (const [k, c] of Object.entries(v)) {
          if (c && typeof c.getVisibleCoordinates === 'function' && k.includes('contours')) {
            registry = true;
            const tiles = c.getVisibleCoordinates().map(
              (t) => `z${t.canonical.z}${t.overscaledZ !== t.canonical.z ? `@${t.overscaledZ}` : ''}`,
            );
            const counts = {};
            for (const t of tiles) counts[t] = (counts[t] || 0) + 1;
            found[`registry${slot}:${k}`] = counts;
          }
        }
      } catch {}
      if (registry) slot++;
    }
    return { zoom: window.map.getZoom(), tiles: found };
  });

const run = async (label, startZ, path, mode = jump) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(URL_ + hash(startZ), { waitUntil: 'domcontentloaded' });
  await settle(page);
  for (const z of path) await mode(page, z);
  console.log(label, JSON.stringify(await state(page)));
  await page.screenshot({ path: `${OUT}contour-dir-${label}.png` });
  await page.screenshot({ path: `${OUT}contour-dir-${label}-crop.png`, clip: { x: 250, y: 150, width: 300, height: 300 } });
  await page.close();
};

await run('fresh-165', 16.5, []);
await run('ease-from-155', 15.5, [16.5], ease);
await run('ease-from-175', 17.5, [16.5], ease);

// the jumpTo white-void side quest: does it recover on its own or on a repaint?
{
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(URL_ + hash(15.5), { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.evaluate(() => window.map.jumpTo({ zoom: 16.5 }));
  for (const wait of [500, 2000, 5000]) {
    await page.waitForTimeout(wait);
    console.log(`jump-void after +${wait}ms`, JSON.stringify(await state(page)));
  }
  await page.evaluate(() => window.map.triggerRepaint());
  await page.waitForTimeout(500);
  console.log('jump-void after triggerRepaint', JSON.stringify(await state(page)));
  await page.screenshot({ path: `${OUT}contour-dir-jump-void.png` });
  await page.close();
}

await browser.close();
server?.kill();
