// What asking for more zoom than Mapterhorn carries actually costs.
//
// The source maxzoom sits above what most of the planet has, so misses are expected.
// This reports, per place and zoom, how many tile requests hit and missed and whether
// the terrain still has elevation there — a miss that falls back to the parent keeps
// its height, a miss that does not reads 0 m.
import { chromium } from 'playwright';

const URL_ = process.env.URL || 'http://localhost:5173/';

const PLACES = [
  { name: 'Matterhorn (CH, z17)', lng: 7.6586, lat: 45.9763, ground: 4478 },
  { name: 'Mont Blanc (FR, z15)', lng: 6.8652, lat: 45.8326, ground: 4808 },
  { name: 'Everest (NP, z12)', lng: 86.925, lat: 27.9881, ground: 8849 },
  { name: 'Aconcagua (AR, z12)', lng: -70.0109, lat: -32.6532, ground: 6961 },
];
const ZOOMS = [12, 14, 16];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

let hits = 0;
let misses = 0;
let bytes = 0;
page.on('response', (res) => {
  if (!res.url().includes('tiles.mapterhorn.com')) return;
  if (res.status() === 200) {
    hits++;
    bytes += Number(res.headers()['content-length'] || 0);
  } else misses++;
});

await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
// Exaggeration off, so a reading is the DEM's own metres.
await page.evaluate(() => window.map.setTerrain({ source: 'mapterhorn-dem', exaggeration: 1 }));

console.log('place                       zoom  hit  miss   MiB   summit m   vs ground');
for (const place of PLACES) {
  for (const zoom of ZOOMS) {
    hits = misses = bytes = 0;
    await page.evaluate(
      ([lng, lat, z]) => window.map.jumpTo({ center: [lng, lat], zoom: z, pitch: 60 }),
      [place.lng, place.lat, zoom],
    );
    await page.waitForTimeout(5000);
    const m = await page.evaluate(
      ([lng, lat]) => window.map.queryTerrainElevation({ lng, lat }),
      [place.lng, place.lat],
    );
    const delta = m === null ? '—' : `${(m - place.ground).toFixed(0).padStart(5)} m`;
    console.log(
      `${place.name.padEnd(26)}  z${String(zoom).padStart(2)}  ${String(hits).padStart(3)}  ${String(misses).padStart(4)}  ${(bytes / 1048576).toFixed(1).padStart(4)}  ${(m ?? 0).toFixed(1).padStart(8)}   ${delta}`,
    );
  }
}

await browser.close();
