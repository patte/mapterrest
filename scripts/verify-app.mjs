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

/* Visible elevation range -------------------------------------------------- */

// The range is what the exposure spreads over the ramp, so what it must not do is answer
// for the horizon: pitched over the Netherlands the raw DEM tiles reach the Ardennes.
const ranges = await open({ hash: '#map=12.6/46.005/7.7/-135/0' });
// The range is null until a tile near enough to count has loaded, so wait on that rather
// than on a duration — a second GL context in a software renderer takes its time.
const settle = () =>
  ranges.waitForFunction(() => window.visibleRange(window.map, 'mapterhorn-dem') !== null, null, {
    timeout: 60000,
  });

await settle();
const zermatt = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
check(
  zermatt !== null && zermatt.lo > 300 && zermatt.hi > 4000,
  'Zermatt exposes over the valley and the summits',
  JSON.stringify(zermatt),
);

await ranges.evaluate(() => window.map.jumpTo({ center: [5.11, 52.09], zoom: 11, pitch: 78 }));
await ranges.waitForTimeout(9000);
await settle();
const flat = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
check(
  flat !== null && flat.lo > -50 && flat.hi < 300,
  'the Netherlands at pitch exposes over the country, not the horizon',
  JSON.stringify(flat),
);

await ranges.evaluate(() => window.map.jumpTo({ center: [10, 20], zoom: 1, pitch: 0 }));
await ranges.waitForTimeout(9000);
await settle();
const world = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
// A z0 tile is the planet in 256 px, so the summits it carries are flattened — and that
// is the range to expose over, because it is the data being drawn.
check(
  world !== null && world.lo < 0 && world.hi > 3000,
  'the world view exposes over the whole globe',
  JSON.stringify(world),
);
await ranges.close();

/* Auto-exposure ------------------------------------------------------------- */

// The point of the exposure is that the ramp follows the view, so the test is that two
// views with different relief end up pinned to different metres.
const exposed = await open({ hash: '#map=12.6/46.005/7.7/-135/0&shading=heightmap' });
const ramp = () =>
  exposed.evaluate(() => {
    const stops = window.map.style.getLayer('terrain-shading').getPaintProperty('color-relief-color');
    return [stops[3], stops[5]];
  });
// A jump leaves the tiles it came from renderable for a while, and the exposure follows
// what is loaded — so settle on the tiles, not on a duration, then let the ease arrive.
const settled = async () => {
  await exposed.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, {
    timeout: 90000,
  });
  await exposed.waitForTimeout(2500);
};

await settled();
const alpine = await ramp();
check(alpine[0] > 300 && alpine[1] > 4000, 'the grey ramp is pinned to the alpine view', alpine.join('–'));

await exposed.evaluate(() => window.map.jumpTo({ center: [5.11, 52.09], zoom: 11, pitch: 0 }));
await exposed.waitForTimeout(3000);
await settled();
const dutch = await ramp();
check(dutch[1] < 300, 'the ramp follows the view down to a flat one', dutch.join('–'));

// Hillshade lights the gradient, so there is no exposure for the checkbox to set.
await exposed.selectOption('#shading', 'hillshade');
await exposed.waitForTimeout(500);
check(await exposed.isDisabled('#auto-exposure'), 'auto-exposure is offered only to the ramps');
check(
  (await exposed.textContent('#exposure-range')) === '',
  'the range read-out clears when nothing is exposed',
);
await exposed.close();

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
await page.uncheck('#auto-exposure');
await page.fill('#exaggeration', '3.7');
await page.dispatchEvent('#exaggeration', 'input');
await page.waitForTimeout(500);

const hash = await page.evaluate(() => location.hash);
for (const part of ['shading=heatmap', 'basemapVisible=0', 'exaggeration=3.7', 'autoExposure=0']) {
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

/* Shift+drag orbits the subject of the frame -------------------------------- */

// A small window: the pitched default view is the expensive one to settle, and the
// gesture only needs terrain in the frame and a rendered frame to raycast.
const orbit = await open({ viewport: { width: 800, height: 600 } });
await orbit.waitForTimeout(10000);

const grabbed = await orbit.evaluate(() => {
  const map = window.map;
  const tr = map._camera.transform;
  const pivot = window.choosePivot(map);
  if (!pivot) return null;
  const at = window.projectPoint(map, pivot.point);

  // On the terrain, not hanging in front of or inside it: the pixel the pivot projects to
  // must raycast back to the pivot's own depth.
  const under = map.terrain.pointCoordinate(at);
  const lat = under && under.toLngLat().lat;
  // Mercator units per metre at that latitude, the same scale MercatorCoordinate uses.
  const perMetre = under && 1 / (6378137 * 2 * Math.PI * Math.cos((lat * Math.PI) / 180));
  const underDepth = under
    ? Math.hypot(under.x - pivot.point.x, under.y - pivot.point.y) / perMetre
    : null;

  // Oracle for projectPoint, which the pivot's screen position is measured with: a point
  // raycast from a pixel has to project back onto that pixel.
  const probe = { x: tr.width * 0.35, y: tr.height * 0.7 };
  const hit = map.terrain.pointCoordinate(probe);
  const back = hit && window.projectPoint(map, { x: hit.x, y: hit.y, elevation: hit.z });

  return {
    from: pivot.from,
    depth: pivot.depth,
    share: pivot.share,
    point: pivot.point,
    hits: pivot.samples.filter((s) => s.point).length,
    voted: pivot.samples.filter((s) => s.chosen).length,
    total: pivot.samples.length,
    at,
    offCentre: Math.hypot(at.x - tr.width / 2, at.y - tr.height / 2),
    surfaceGapM: underDepth,
    surfaceDropM: under ? Math.abs(under.z - pivot.point.elevation) : null,
    roundTripPx: back ? Math.hypot(back.x - probe.x, back.y - probe.y) : null,
    bearing: tr.bearing,
    pitch: tr.pitch,
  };
});
check(!!grabbed, 'the frame grid finds a pivot');
check(
  grabbed.from === 'subject' && grabbed.hits >= 3,
  'the grid, not the anchor ladder, chooses it',
  `${grabbed.hits}/${grabbed.total} hits`,
);
// A band of the depth range rather than everything down to the horizon, so the share is a
// minority of a frame that runs from the foreground to 40 km out — and has to be one.
check(
  grabbed.voted >= 3 && grabbed.share > 0.2 && grabbed.share < 0.9,
  'one surface carries the choice',
  `${grabbed.voted} pts, ${(grabbed.share * 100).toFixed(0)}% of the weight`,
);
// The point of choosing a surface rather than a depth: the pivot is on the terrain, which
// means the pixel it projects to looks back at the pivot itself.
check(
  grabbed.surfaceGapM !== null && grabbed.surfaceGapM < 30 && grabbed.surfaceDropM < 30,
  'the pivot sits on the terrain surface',
  `${grabbed.surfaceGapM?.toFixed(1)} m across, ${grabbed.surfaceDropM?.toFixed(1)} m up`,
);
check(
  grabbed.roundTripPx !== null && grabbed.roundTripPx < 5,
  'a raycast point projects back onto the pixel it came from',
  `${grabbed.roundTripPx?.toFixed(1)} px`,
);

// terrain.pointCoordinate encodes the tile a pixel came from in one byte, so past 255
// rendered terrain tiles it decodes the wrong tile and answers with a real coordinate from
// somewhere else — a 1900×1532 window at pitch 85 draws 306 and every sample came back
// 200-350 km out. These checks run at detail=low, 18 tiles, and would never see it. So
// assert the pivot does not ask that question at all: break the call, expect no change.
const withoutCoords = await orbit.evaluate((g) => {
  const map = window.map;
  const real = map.terrain.pointCoordinate;
  map.terrain.pointCoordinate = () => null;
  try {
    const pivot = window.choosePivot(map);
    return (
      pivot && {
        from: pivot.from,
        movedM: Math.abs(pivot.depth - g.depth),
        hits: pivot.samples.filter((s) => s.point).length,
      }
    );
  } finally {
    map.terrain.pointCoordinate = real;
  }
}, grabbed);
check(
  withoutCoords?.from === 'subject' && withoutCoords.movedM < 1,
  'the pivot is marched off the DEM, not read from the coords framebuffer',
  `${withoutCoords?.hits} hits, ${withoutCoords?.movedM.toFixed(2)} m`,
);

// Off centre and away from the mountain: where the drag starts must not move the pivot.
await orbit.keyboard.down('Shift');
await orbit.mouse.move(620, 460);
await orbit.mouse.down();
for (let i = 1; i <= 8; i++) {
  await orbit.mouse.move(620 + i * 9, 460 + i * 5);
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
  const p = window.projectPoint(window.map, g.point);
  return {
    bearing: tr.bearing,
    pitch: tr.pitch,
    camAlt: tr.getCameraAltitude(),
    errPx: p ? Math.hypot(p.x - g.at.x, p.y - g.at.y) : Infinity,
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
// The whole point of the pivot: it keeps its pixel, however far from it the drag began.
check(turned.errPx < 10, 'the pivot holds its place through the turn', `${turned.errPx.toFixed(1)} px`);
check(
  Math.abs(turned.camAlt - midDrag) < 2,
  'letting go leaves the camera where the drag left it',
  `${(turned.camAlt - midDrag).toFixed(1)} m`,
);
await orbit.close();

/* Zooming out ---------------------------------------------------------------*/

// The anchor marches the view axis to find the terrain the centre should sit on. A march
// that stops short reports no terrain for a view that is nothing but terrain, and settle
// then puts the centre on a plane 10 km under the camera — so the map holds a zoom for a
// height it is nowhere near and asks the LOD for that detail across a continent. At
// pitch 0 the camera passes 80 km up at z10.5, which is why this checks from there down.
const high = await open({ hash: '#map=13/50.195639/11.502985' });
const ground = await high.evaluate(() =>
  window.map.terrain.getElevationForLngLatZoom(window.map.getCenter(), 12),
);
for (const zoom of [11, 10, 9]) {
  const settled = await high.evaluate(async (z) => {
    window.map.jumpTo({ zoom: z });
    await new Promise((done) => setTimeout(done, 3000));
    const tr = window.map._camera.transform;
    return { zoom: tr.zoom, plane: tr.elevation, altitude: tr.getCameraAltitude() };
  }, zoom);
  check(
    Math.abs(settled.plane - ground) < 500 && Math.abs(settled.zoom - zoom) < 0.5,
    `zooming out to z${zoom} leaves the centre on the ground`,
    `plane ${settled.plane.toFixed(0)} m against ${ground.toFixed(0)} m, reads z${settled.zoom.toFixed(2)}`,
  );
}
await high.close();

// Mid-ocean the march finds no DEM at all, which is the other way in: settling on a
// crossing that does not exist writes the same invented plane. Nothing to anchor to means
// leave the camera alone, so the plane stays at sea level and the LOD stays coarse.
const sea = await open({ hash: '#map=1.46/-40.3/-82.3' });
await sea.evaluate(async () => {
  window.map.jumpTo({ zoom: 3 });
  await new Promise((done) => setTimeout(done, 3000));
});
const overWater = await sea.evaluate(() => ({
  plane: window.map._camera.transform.elevation,
  zoom: window.map._camera.transform.zoom,
  rtt: window.map.terrain.tileManager._renderableTilesKeys.length,
}));
check(
  Math.abs(overWater.plane) < 500 && overWater.rtt < 255,
  'a camera over open water keeps its centre at sea level',
  `plane ${overWater.plane.toFixed(0)} m, z${overWater.zoom.toFixed(2)}, ${overWater.rtt} terrain tiles`,
);
await sea.close();

/* The pivot debug overlay -------------------------------------------------- */

const debug = await open({ viewport: { width: 800, height: 600 }, hash: '#debugPivot=1' });
await debug.waitForTimeout(10000);
const overlay = await debug.evaluate(() => {
  const canvas = document.querySelector('.maplibregl-canvas-container canvas:last-child');
  if (!canvas || canvas === document.querySelector('.maplibregl-canvas')) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let drawn = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) drawn++;
  return { drawn, pointerEvents: getComputedStyle(canvas).pointerEvents };
});
check(!!overlay, '#debugPivot=1 adds an overlay canvas');
check(overlay?.drawn > 0, 'the overlay draws the pivot and its grid', `${overlay?.drawn} px`);
check(overlay?.pointerEvents === 'none', 'the overlay does not swallow the gesture');
const plain = await open({ viewport: { width: 400, height: 300 } });
check(
  await plain.evaluate(
    () => document.querySelectorAll('.maplibregl-canvas-container canvas').length === 1,
  ),
  'without the param there is no overlay',
);
await plain.close();
await debug.close();

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
