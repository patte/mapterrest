// Renders the auto-exposure row (heatmap selected: box off, ⓘ beside it) and the open
// explainer dialog into shots/, for eyeballing the row's spacing and the dialog's text.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;
const SHOTS = new URL('../shots/', import.meta.url).pathname;

// window.map is only exposed under import.meta.env.DEV, so the server must be `vite dev`;
// reuse one already answering at URL_, otherwise start our own and take it down after.
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

await page.goto(URL_ + '#shading=heatmap', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, {
  timeout: 90000,
});
await page.waitForTimeout(500);

await page.locator('#card').screenshot({ path: `${SHOTS}exposure-row-info.png` });
await page.click('#exposure-info');
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}exposure-dialog.png` });
await page.close();

// Narrow, where the shading strip scrolls and the exposure row right-aligns; the
// tray starts collapsed here, so the settings tile opens it first.
const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
await narrow.goto(URL_ + '#shading=heatmap', { waitUntil: 'domcontentloaded' });
await narrow.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
await narrow.click('#tray-tile');
await narrow.waitForTimeout(300);
await narrow.locator('#card').screenshot({ path: `${SHOTS}exposure-row-narrow.png` });

await browser.close();
server?.kill();
