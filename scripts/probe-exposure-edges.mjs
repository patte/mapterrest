// Does the exposed range match what the frame actually shows?
//
// Straight down: visibleRange against a dense queryTerrainElevation grid over the
// canvas — any excess is ground leaking in from beyond the frame's edge (pyramid
// cells are cut whole). Tilted: where on screen the sampled extremes sit, to show
// the endpoints can come from ground far away near the horizon.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;

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

await page.goto(URL_ + '#shading=heightmap', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });

const settle = async () => {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, {
    timeout: 90000,
  });
  await page.waitForTimeout(2500);
};

const probe = () =>
  page.evaluate(() => {
    const map = window.map;
    const vr = window.visibleRange(map, 'mapterhorn-dem');
    const { width, height } = map.getCanvas().getBoundingClientRect();
    let lo = { e: Infinity };
    let hi = { e: -Infinity };
    const N = 60;
    for (let iy = 0; iy <= N; iy++) {
      for (let ix = 0; ix <= N; ix++) {
        const x = (ix / N) * width;
        const y = (iy / N) * height;
        const e = map.queryTerrainElevation(map.unproject([x, y]));
        if (e == null) continue;
        if (e < lo.e) lo = { e, x: Math.round(x), y: Math.round(y) };
        if (e > hi.e) hi = { e, x: Math.round(x), y: Math.round(y) };
      }
    }
    const r = (v) => Math.round(v);
    return {
      measured: `${r(vr.lo)}–${r(vr.hi)} m`,
      sampled: `${r(lo.e)}–${r(hi.e)} m`,
      excess: `lo ${r(lo.e - vr.lo)} m, hi ${r(vr.hi - hi.e)} m`,
      sampledLoAt: `${lo.x},${lo.y} of ${r(width)}x${r(height)}`,
      sampledHiAt: `${hi.x},${hi.y}`,
    };
  });

await settle();
console.log('tilted (default Zermatt view, pitch 78):', await probe());

await page.evaluate(() => window.map.jumpTo({ pitch: 0, zoom: 12.6 }));
await settle();
console.log('straight down (same spot, pitch 0):', await probe());

await page.evaluate(() =>
  window.map.jumpTo({ center: [5.11, 52.09], zoom: 11, pitch: 0, bearing: 0 }),
);
await settle();
console.log('straight down (Utrecht, pitch 0):', await probe());

await browser.close();
server?.kill();
