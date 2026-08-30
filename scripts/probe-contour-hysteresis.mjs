// Does a contour render at zoom Z depend on how you got there — and what smooths the
// staircase? Arms: a fresh load at z13; b jump 13→16→13; b2 ease 16→13 then re-pin the
// camera; c fresh at z9 stepped up, camera re-pinned. All shots and red-pixel diffs land
// in shots/. Then the same view with subsampleBelow=512 injected into the tile URL.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

const HASH13 = '#map=13/45.9764/7.6586/0/0&contours=1&basemapVisible=0&shadingVisible=0&contourLabels=0&collapsed=1';
const settle = async (page) => {
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, { timeout: 90000 });
  await page.waitForTimeout(600);
};
const camera = (page) =>
  page.evaluate(() => {
    const c = window.map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: window.map.getZoom(), bearing: window.map.getBearing(), pitch: window.map.getPitch() };
  });
const pin = async (page, cam) => {
  await page.evaluate((c) => window.map.jumpTo({ center: [c.lng, c.lat], zoom: c.zoom, bearing: c.bearing, pitch: c.pitch }), cam);
  await settle(page);
};
const jump = async (page, zoom) => {
  await page.evaluate((z) => window.map.jumpTo({ zoom: z }), zoom);
  await settle(page);
};
const shoot = (page, file) => page.screenshot({ path: OUT + file });
const CROP = { x: 280, y: 160, width: 260, height: 220 };
const crop = (page, file) => page.screenshot({ path: OUT + file, clip: CROP });

// a — fresh at 13
const pa = await browser.newPage({ viewport: { width: 800, height: 600 } });
await pa.goto(URL_ + HASH13, { waitUntil: 'domcontentloaded' });
await settle(pa);
const cam = await camera(pa);
console.log('camera a:', cam);
await shoot(pa, 'contour-hyst-a-fresh13.png');
await crop(pa, 'contour-hyst-crop-raw.png');

// b — same page, up to 16 and back down by jump
await jump(pa, 16);
await jump(pa, 13);
console.log('camera b:', await camera(pa));
await shoot(pa, 'contour-hyst-b-jump-from16.png');

// b2 — animated ease out like a scroll zoom, then the camera pinned back to a's
await jump(pa, 16);
await pa.evaluate(() => window.map.easeTo({ zoom: 13, duration: 1500 }));
await pa.waitForTimeout(1600);
await settle(pa);
console.log('camera b2 before pin:', await camera(pa));
await pin(pa, cam);
await shoot(pa, 'contour-hyst-b2-eased-from16.png');

// smoothing demo on the same page: re-point the source at subsampleBelow=512 tiles
await pa.evaluate(() => {
  const src = window.map.getSource('mapterhorn-contours');
  src.setTiles([src.tiles[0] + (src.tiles[0].includes('?') ? '&' : '?') + 'subsampleBelow=512']);
});
await settle(pa);
await shoot(pa, 'contour-hyst-subsample512.png');
await crop(pa, 'contour-hyst-crop-subsample512.png');
await pa.close();

// c — fresh at 9, stepped up, camera pinned to a's
const pc = await browser.newPage({ viewport: { width: 800, height: 600 } });
await pc.goto(URL_ + HASH13.replace('#map=13', '#map=9'), { waitUntil: 'domcontentloaded' });
await settle(pc);
for (const z of [10, 11, 12, 13]) await jump(pc, z);
console.log('camera c before pin:', await camera(pc));
await pin(pc, cam);
await shoot(pc, 'contour-hyst-c-stepped-from9.png');
await pc.close();

// red-pixel diffs, rendered in a throwaway page's canvas
const pd = await browser.newPage({ viewport: { width: 100, height: 100 } });
await pd.goto('about:blank');
const diff = async (f1, f2, out) => {
  const b1 = readFileSync(OUT + f1).toString('base64');
  const b2 = readFileSync(OUT + f2).toString('base64');
  const r = await pd.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + s; });
    const [i1, i2] = await Promise.all([load(a), load(b)]);
    const cv = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const d1 = cv(i1), d2 = cv(i2);
    const c = document.createElement('canvas'); c.width = i1.width; c.height = i1.height;
    const x = c.getContext('2d'); x.drawImage(i1, 0, 0);
    const outImg = x.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < d1.length; i += 4) {
      if (Math.abs(d1[i] - d2[i]) > 8 || Math.abs(d1[i + 1] - d2[i + 1]) > 8 || Math.abs(d1[i + 2] - d2[i + 2]) > 8) {
        n++; outImg.data[i] = 255; outImg.data[i + 1] = 0; outImg.data[i + 2] = 0; outImg.data[i + 3] = 255;
      } else { const g = (outImg.data[i] + outImg.data[i + 1] + outImg.data[i + 2]) / 3; outImg.data[i] = outImg.data[i + 1] = outImg.data[i + 2] = 128 + g / 3; }
    }
    x.putImageData(outImg, 0, 0);
    return { differing: n, total: d1.length / 4, diff: c.toDataURL() };
  }, [b1, b2]);
  writeFileSync(OUT + out, Buffer.from(r.diff.split(',')[1], 'base64'));
  console.log(`${f1} vs ${f2}:`, { differing: r.differing, total: r.total });
};
await diff('contour-hyst-a-fresh13.png', 'contour-hyst-b-jump-from16.png', 'contour-hyst-diff-ab.png');
await diff('contour-hyst-a-fresh13.png', 'contour-hyst-b2-eased-from16.png', 'contour-hyst-diff-ab2.png');
await diff('contour-hyst-a-fresh13.png', 'contour-hyst-c-stepped-from9.png', 'contour-hyst-diff-ac.png');
await diff('contour-hyst-a-fresh13.png', 'contour-hyst-subsample512.png', 'contour-hyst-diff-smooth.png');
await pd.close();

await browser.close();
server?.kill();
