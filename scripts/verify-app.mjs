// Headless end-to-end check: terrain attaches, elevations are sane, every control
// round-trips through the hash, and the mobile panel folds away. Needs `pnpm dev`.
import { chromium } from 'playwright';

const URL_ = process.env.URL || 'http://localhost:5173/';

const PROBES = [
  { name: 'Matterhorn', lng: 7.6586, lat: 45.9763, expect: [4300, 4500] },
  { name: 'Jungfrau', lng: 7.9622, lat: 46.5367, expect: [4050, 4200] },
  { name: 'Zürich HB', lng: 8.5403, lat: 47.3779, expect: [390, 425] },
  { name: 'Lake Zürich', lng: 8.6, lat: 47.28, expect: [395, 415] },
];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/**
 * A fresh page per case, so hash state and colour scheme never leak between them, and
 * every case runs at `detail=low`: none of them are testing the tuned LOD, and a pitched
 * frame at full detail pulls hundreds of tiles through a software GL.
 */
async function open(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ...opts });
  const hash =
    opts.hash?.includes('detail=') || opts.appDefaultDetail
      ? (opts.hash ?? '')
      : opts.hash
        ? `${opts.hash}&detail=low`
        : '#detail=low';
  await page.goto(URL_ + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  return page;
}

/* Terrain and elevations --------------------------------------------------- */

// queryTerrainElevation reports the exaggerated mesh, so probe at 1x to read metres.
const page = await open({ hash: '#exaggeration=1' });
await page.waitForTimeout(8000);

const source = await page.evaluate(() => {
  const s = window.map.getStyle().sources['mapterhorn-dem'];
  return { encoding: s.encoding, tileSize: s.tileSize, minzoom: s.minzoom, maxzoom: s.maxzoom };
});
check(source.encoding === 'terrarium', 'DEM source is terrarium', JSON.stringify(source));
check(source.minzoom === 0, 'relief reaches the horizon (minzoom 0)');
check(source.tileSize === 512, 'detail=low declares the tiles at their real size');
// calculateTileZoom is where setSourceTileLodParams lands; unset means default LOD.
check(
  await page.evaluate(() => window.map.getSource('mapterhorn-dem').calculateTileZoom === undefined),
  'detail=low leaves the LOD params alone',
);
check(!!(await page.evaluate(() => window.map.getTerrain())), 'terrain is attached');
check(
  (await page.evaluate(() =>
    window.map.style.getLayer('terrain-shading').paint.get('hillshade-illumination-anchor'),
  )) === 'map',
  'hillshade light is anchored to the map, not the viewport',
);

for (const p of PROBES) {
  // Flat: a probe wants one tile over the point, and the LOD params that pull hundreds
  // of tiles toward a horizon do nothing at pitch 0.
  await page.evaluate(
    ([lng, lat]) => window.map.jumpTo({ center: [lng, lat], zoom: 14, pitch: 0 }),
    [p.lng, p.lat],
  );
  await page.waitForTimeout(3500);
  const m = await page.evaluate(
    ([lng, lat]) => window.map.queryTerrainElevation({ lng, lat }),
    [p.lng, p.lat],
  );
  const ok = m !== null && m >= p.expect[0] && m <= p.expect[1];
  check(ok, `${p.name} elevation`, `${m?.toFixed(1)} m, expected ${p.expect.join('–')}`);
}

// Flat, so asking for the tuned detail costs a handful of tiles rather than hundreds.
const detailed = await open({ hash: '#map=12.6/46.005/7.7/-135/0&detail=high' });
check(
  (await detailed.evaluate(() => window.map.getStyle().sources['mapterhorn-dem'].tileSize)) === 256,
  'detail=high understates tileSize to buy a zoom level',
);
await detailed.close();

// No detail in the hash: the app's own default has to be medium — real tile size, LOD
// params shaping the horizon.
const dflt = await open({ hash: '#map=12.6/46.005/7.7/-135/0', appDefaultDetail: true });
check(
  (await dflt.evaluate(() => window.map.getStyle().sources['mapterhorn-dem'].tileSize)) === 512,
  'default detail declares the tiles at their real size',
);
check(
  await dflt.evaluate(
    () => typeof window.map.getSource('mapterhorn-dem').calculateTileZoom === 'function',
  ),
  'default detail shapes the horizon with the LOD params',
);
await dflt.close();

/* Attribution -------------------------------------------------------------- */

const attribution = await page.textContent('.maplibregl-ctrl-attrib');
check(/Mapterhorn/.test(attribution ?? ''), 'Mapterhorn credited in the attribution control');
check(
  (await page.locator('.maplibregl-ctrl-attrib a[href*="mapterhorn.com"]').count()) > 0,
  'attribution links to mapterhorn.com',
);

/* Controls round-trip through the hash ------------------------------------- */

await page.selectOption('#shading', 'heatmap');
await page.uncheck('#basemap-visible');
await page.fill('#exaggeration', '3.7');
await page.dispatchEvent('#exaggeration', 'input');
await page.waitForTimeout(500);

const hash = await page.evaluate(() => location.hash);
for (const part of ['shading=heatmap', 'basemapVisible=0', 'exaggeration=3.7']) {
  check(hash.includes(part), `hash carries ${part}`);
}
check(
  await page.evaluate(() => window.map.getLayer('terrain-shading')?.type === 'color-relief'),
  'heatmap swaps in the color-relief layer',
);

await page.uncheck('#shading-visible');
await page.waitForTimeout(300);
check(
  await page.evaluate(() => !window.map.getLayer('terrain-shading')),
  'shading checkbox removes the layer',
);
check((await page.evaluate(() => location.hash)).includes('shadingVisible=0'), 'hash carries shadingVisible=0');

const restored = await open({ hash: '#basemap=liberty&shading=heatmap&shadingVisible=0&exaggeration=2.5' });
await restored.waitForTimeout(1500);
check(await restored.evaluate(() => document.getElementById('basemap').value === 'liberty'), 'hash restores the basemap');
check(await restored.evaluate(() => !window.map.getLayer('terrain-shading')), 'hash restores shading off');
check(
  await restored.evaluate(() => Math.abs(window.map.getTerrain().exaggeration - 2.5) < 1e-6),
  'hash restores exaggeration',
);
await restored.close();

/* Colour scheme autodetect ------------------------------------------------- */

for (const [colorScheme, expected] of [
  ['dark', 'carto-dark'],
  ['light', 'carto-light'],
]) {
  const themed = await open({ colorScheme });
  const picked = await themed.evaluate(() => document.getElementById('basemap').value);
  const body = await themed.evaluate(() => document.body.dataset.theme);
  check(picked === expected, `${colorScheme} browser picks ${expected}`, `got ${picked}`);
  check(body === colorScheme, `panel follows the ${colorScheme} scheme`);
  await themed.close();
}

const chosen = await open({ colorScheme: 'dark', hash: '#basemap=carto-light' });
check(
  await chosen.evaluate(() => document.getElementById('basemap').value === 'carto-light'),
  'an explicit basemap in the hash beats the browser scheme',
);
await chosen.close();

/* Shift+drag orbits the terrain it grabbed ---------------------------------- */

// A small window: the pitched default view is the expensive one to settle, and the
// gesture only needs terrain under the anchor and a rendered frame to raycast.
const orbit = await open({ viewport: { width: 800, height: 600 } });
await orbit.waitForTimeout(10000);

const grabbed = await orbit.evaluate(() => {
  const tr = window.map._camera.transform;
  const anchor = [tr.width / 2, tr.height * 0.65];
  const hit = window.map.terrain.pointCoordinate({ x: anchor[0], y: anchor[1] });
  if (!hit) return null;
  const ll = hit.toLngLat();
  return { anchor, lng: ll.lng, lat: ll.lat, bearing: tr.bearing, pitch: tr.pitch };
});
check(!!grabbed, 'terrain answers a raycast under the gesture anchor');

await orbit.keyboard.down('Shift');
await orbit.mouse.move(400, 300);
await orbit.mouse.down();
for (let i = 1; i <= 8; i++) {
  await orbit.mouse.move(400 + i * 9, 300 + i * 5);
  await orbit.waitForTimeout(20);
}
// The camera as the drag ends, to compare with where it settles: MapLibre pins the
// centre's elevation to the terrain every frame, and a gesture that hands back a state
// it disagrees with gets dragged a kilometre vertically the moment the mouse comes up.
const midDrag = await orbit.evaluate(() => window.map._camera.transform.getCameraAltitude());

await orbit.mouse.up();
await orbit.keyboard.up('Shift');
await orbit.waitForTimeout(1000);

const turned = await orbit.evaluate((g) => {
  const tr = window.map._camera.transform;
  const p = window.map.project([g.lng, g.lat]);
  return {
    bearing: tr.bearing,
    pitch: tr.pitch,
    camAlt: tr.getCameraAltitude(),
    errPx: Math.hypot(p.x - g.anchor[0], p.y - g.anchor[1]),
  };
}, grabbed);

check(
  Math.abs(turned.bearing - (grabbed.bearing + 72 * 0.4)) < 0.5,
  'a 72 px drag turns by the rotate speed',
  `${turned.bearing.toFixed(2)}°`,
);
check(
  Math.abs(turned.pitch - (grabbed.pitch - 40 * 0.25)) < 0.5,
  'a 40 px drag tilts by the pitch speed',
  `${turned.pitch.toFixed(2)}°`,
);
// The whole point of the raycast pivot: the ground it grabbed keeps its pixel.
check(turned.errPx < 10, 'the grabbed terrain holds its place through the turn', `${turned.errPx.toFixed(1)} px`);
check(
  Math.abs(turned.camAlt - midDrag) < 2,
  'letting go leaves the camera where the drag left it',
  `${(turned.camAlt - midDrag).toFixed(1)} m`,
);
await orbit.close();

/* Mobile panel ------------------------------------------------------------- */

const phone = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
check(await phone.locator('#panel-toggle').isVisible(), 'toggle button shows on a phone');
check(!(await phone.locator('#panel').isVisible()), 'panel starts folded on a phone');
await phone.click('#panel-toggle');
check(await phone.locator('#panel').isVisible(), 'toggle opens the panel');
check(
  (await phone.getAttribute('#panel-toggle', 'aria-expanded')) === 'true',
  'toggle reports aria-expanded',
);
const overflow = await phone.evaluate(() => {
  const r = document.getElementById('panel').getBoundingClientRect();
  return { left: r.left, right: r.right, width: window.innerWidth };
});
check(overflow.right <= overflow.width, 'open panel stays inside the viewport', JSON.stringify(overflow));
await phone.click('#panel-toggle');
check(!(await phone.locator('#panel').isVisible()), 'toggle closes the panel again');
await phone.close();

check(!(await page.locator('#panel-toggle').isVisible()), 'toggle button hides on desktop');
check(await page.locator('#panel').isVisible(), 'panel always open on desktop');

await page.close();
await browser.close();

console.log(failures.length ? `\n${failures.length} failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
