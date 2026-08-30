// How the drape texture's upscale between integer zooms treats the contour lines: with
// terrain on, draped layers are baked into a fixed 2048 px texture per terrain tile, so
// on a 2× display a fractional zoom shows that texture stretched by up to 2×. Shoots
// top-down at 12.0 / 12.5 / 12.9 at deviceScaleFactor 2 (at 1× the upscale never
// exceeds 1:1 and nothing shows) and a 3× crop of the centre; TAG names the set.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;
const TAG = process.env.TAG || 'probe';
const SHOTS = new URL('../shots/', import.meta.url).pathname;

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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });

for (const z of ['12', '12.5', '12.9']) {
  const hash = `#map=${z}/46.77934/8.60525/0/0&contours=1&shading=hillshade&shadingVisible=0&basemap=carto-dark&collapsed=1`;
  await page.goto(URL_ + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, { timeout: 90000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}contour-upscale-${TAG}-z${z}.png` });
  // 200×140 css px around the centre, 3× nearest-neighbour so texels stay visible.
  await page.screenshot({
    path: `${SHOTS}contour-upscale-${TAG}-z${z}-crop.png`,
    clip: { x: 400, y: 280, width: 200, height: 140 },
    scale: 'device',
  });
}

await page.close();
await browser.close();
server?.kill();
