// Clean A/B of subsampleBelow=512 on the Zermatt z13 view: fresh page per arm, the B
// arm swaps the contour tiles URL once and waits out the reload before shooting.
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

const HASH = '#map=13/45.9764/7.6586/0/0&contours=1&basemapVisible=0&shadingVisible=0&contourLabels=0&collapsed=1';
const settle = async (page) => {
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, { timeout: 90000 });
  await page.waitForTimeout(600);
};
const CROP = { x: 280, y: 160, width: 260, height: 220 };

const arm = async (label, tweak) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(URL_ + HASH, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (tweak) {
    await page.evaluate(() => {
      const src = window.map.getSource('mapterhorn-contours');
      src.setTiles([src.tiles[0] + '&subsampleBelow=512']);
    });
    await page.waitForTimeout(2500);
    await settle(page);
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${OUT}contour-sub-${label}.png` });
  await page.screenshot({ path: `${OUT}contour-sub-${label}-crop.png`, clip: CROP });
  await page.close();
};

await arm('raw', false);
await arm('512', true);

await browser.close();
server?.kill();
