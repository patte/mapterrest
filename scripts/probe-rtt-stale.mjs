// Oracle for patches/maplibre-gl-stale-drape-after-zoom.patch (stale drape textures after a zoom animation):
// ease to a camera, then force a re-bake of every drape texture at that same camera.
// With the patch the settled arrival must be pixel-identical to the fresh bake.
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

const diffShots = async (a, b) => {
  const page = await browser.newPage();
  const n = await page.evaluate(async ([da, db]) => {
    const load = (d) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = d;
    });
    const pixels = (img) => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const x = cv.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, cv.width, cv.height).data;
    };
    const [pa, pb] = (await Promise.all([load(da), load(db)])).map(pixels);
    let diff = 0;
    for (let i = 0; i < pa.length; i += 4)
      if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) diff++;
    return { diff, total: pa.length / 4 };
  }, [a, b].map((buf) => `data:image/png;base64,${buf.toString('base64')}`));
  await page.close();
  return n;
};

const arm = async (label, startZ, endZ) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(URL_ + hash(startZ), { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.evaluate((z) => window.map.easeTo({ zoom: z, duration: 1200 }), endZ);
  await page.waitForTimeout(1300);
  await settle(page);
  const eased = await page.screenshot({ path: `${OUT}rtt-oracle-${label}-eased.png` });
  const camera = await page.evaluate(() => [window.map.getZoom(), ...Object.values(window.map.getCenter())]);
  // force a fresh bake of every drape texture, camera untouched
  await page.evaluate(() => {
    const m = window.map;
    const tiles = m.terrain.tileManager._tiles;
    for (const key in tiles) tiles[key].releaseRTT(m.painter);
    m.triggerRepaint();
  });
  await settle(page);
  const rebaked = await page.screenshot({ path: `${OUT}rtt-oracle-${label}-rebaked.png` });
  if (JSON.stringify(camera) !== JSON.stringify(await page.evaluate(() => [window.map.getZoom(), ...Object.values(window.map.getCenter())])))
    throw new Error(`${label}: camera moved between shots`);
  await page.close();
  const { diff, total } = await diffShots(eased, rebaked);
  console.log(`${label}: ${diff}/${total} differing pixels (z${startZ} → z${endZ})`);
  return diff;
};

const bad = (await arm('ease-in', 15.5, 16.5)) + (await arm('ease-out', 17.5, 16.5));
await browser.close();
server?.kill();
process.exit(bad === 0 ? 0 : 1);
