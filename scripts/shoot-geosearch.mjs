// Renders the geosearch states into shots/: the collapsed pill, the expanded box with
// results, an API-error note, and the basemap-failure notice, in both themes.
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

const FEATURES = [
  {
    text: 'Zermatt',
    place_name: 'Zermatt, Visp, Valais, Switzerland',
    center: [7.749, 46.021],
    bbox: [7.622, 45.96, 7.879, 46.062],
    place_type: ['municipality'],
  },
  {
    text: 'Zermatt ZBAG-zb',
    place_name: 'Zermatt ZBAG-zb, Zermatt, Switzerland',
    center: [7.747, 46.024],
    place_type: ['poi'],
  },
  {
    text: 'Zermatt Bergbahnen',
    place_name: 'Zermatt Bergbahnen, Zermatt, Switzerland',
    center: [7.75, 46.02],
    place_type: ['poi'],
  },
];

async function shoot(theme, suffix) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: theme });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });

  const corner = { clip: { x: 0, y: 0, width: 460, height: 340 } };
  await page.screenshot({ path: `${SHOTS}geosearch-pill${suffix}.png`, ...corner });

  await page.route('https://api.maptiler.com/geocoding/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: FEATURES }) }),
  );
  await page.click('#geosearch-open');
  await page.fill('#geosearch-input', 'Zermatt');
  await page.waitForSelector('#geosearch-results li');
  await page.hover('#geosearch-results li >> nth=0');
  await page.screenshot({ path: `${SHOTS}geosearch-results${suffix}.png`, ...corner });

  await page.unroute('https://api.maptiler.com/geocoding/**');
  await page.route('https://api.maptiler.com/geocoding/**', (route) =>
    route.fulfill({ status: 403, body: 'Forbidden' }),
  );
  await page.fill('#geosearch-input', 'Matterhorn');
  await page.waitForSelector('#geosearch-results li.note');
  await page.screenshot({ path: `${SHOTS}geosearch-error${suffix}.png`, ...corner });

  await page.evaluate(() => {
    window.map.fire('error', {
      error: Object.assign(new Error('Forbidden'), {
        status: 403,
        url: 'https://api.maptiler.com/maps/hybrid-v4/style.json',
      }),
    });
  });
  await page.waitForSelector('#notice');
  await page.screenshot({
    path: `${SHOTS}geosearch-notice${suffix}.png`,
    clip: { x: 350, y: 0, width: 700, height: 120 },
  });
  await page.close();
}

await shoot('light', '');
await shoot('dark', '-dark');

await browser.close();
if (server) server.kill();
console.log('shots written to shots/');
