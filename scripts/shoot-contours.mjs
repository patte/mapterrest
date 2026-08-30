// Renders the contour overlay into shots/: the default pitched view, a top-down z14
// where the 20 m lines and labels carry the picture, the amber palette on a night
// style, and the card with the contour tile pressed and the labels row out.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const shoot = async (hash, file) => {
  await page.goto(URL_ + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, {
    timeout: 90000,
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}${file}` });
};

await shoot('#contours=1', 'contours-default-view.png');
await page.locator('#card').screenshot({ path: `${SHOTS}contours-card.png` });
await shoot('#map=14/45.9764/7.6586/0/0&contours=1', 'contours-topdown-z14.png');
await shoot('#map=14/45.9764/7.6586/0/0&contours=1&basemap=carto-dark', 'contours-dark-z14.png');
// Zoomed out, where the coarse rungs carry the picture: the Valais at z10, the
// western Alps at z8, the whole arc at z6.
await shoot('#map=10/46.0/7.7/0/0&contours=1', 'contours-z10.png');
await shoot('#map=8/46.1/7.9/0/0&contours=1', 'contours-z8.png');
await shoot('#map=6/46.3/9/0/0&contours=1', 'contours-z6.png');

await page.close();
await browser.close();
server?.kill();
