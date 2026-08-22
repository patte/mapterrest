import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

const PROBES = [
  { name: 'Matterhorn', lng: 7.6586, lat: 45.9763, expect: [4300, 4500] },
  { name: 'Jungfrau', lng: 7.9622, lat: 46.5367, expect: [4050, 4200] },
  { name: 'Zürich HB', lng: 8.5403, lat: 47.3779, expect: [390, 425] },
  { name: 'Lake Zürich', lng: 8.6, lat: 47.28, expect: [395, 415] },
];

test('DEM source, terrain, and elevation probes', async ({ browser }) => {
  // queryTerrainElevation reports the exaggerated mesh, so probe at 1x to read metres.
  // This is the case that verifies the detail=low mode itself, so it pins it.
  const page = await open(browser, { hash: '#terrainScale=1&detail=low' });

  const source = await page.evaluate(() => {
    const s = window.map.getStyle().sources['mapterhorn-dem'];
    return { encoding: s.encoding, tileSize: s.tileSize, minzoom: s.minzoom, maxzoom: s.maxzoom };
  });
  await check(source.encoding === 'terrarium', 'DEM source is terrarium', JSON.stringify(source));
  await check(source.minzoom === 0, 'relief reaches the horizon (minzoom 0)');
  await check(source.tileSize === 512, 'detail=low declares the tiles at their real size');
  // calculateTileZoom is where setSourceTileLodParams lands; unset means default LOD.
  await check(
    await page.evaluate(
      () => window.map.getSource('mapterhorn-dem').calculateTileZoom === undefined,
    ),
    'detail=low leaves the LOD params alone',
  );
  await check(!!(await page.evaluate(() => window.map.getTerrain())), 'terrain is attached');
  await check(
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
    await settled(page);
    const m = await page.evaluate(
      ([lng, lat]) => window.map.queryTerrainElevation({ lng, lat }),
      [p.lng, p.lat],
    );
    const ok = m !== null && m >= p.expect[0] && m <= p.expect[1];
    await check(ok, `${p.name} elevation`, `${m?.toFixed(1)} m, expected ${p.expect.join('–')}`);
  }
  await page.close();
});

test('detail=high buys a zoom level', async ({ browser }) => {
  // Flat, so asking for the tuned detail costs a handful of tiles rather than hundreds.
  const detailed = await open(browser, { hash: '#map=12.6/46.005/7.7/-135/0&detail=high' });
  await check(
    (await detailed.evaluate(
      () => window.map.getStyle().sources['mapterhorn-dem'].tileSize,
    )) === 256,
    'detail=high understates tileSize to buy a zoom level',
  );
  await detailed.close();
});

test('default detail is medium', async ({ browser }) => {
  // No detail in the hash: the app's own default has to be medium — real tile size, LOD
  // params shaping the horizon.
  const dflt = await open(browser, { hash: '#map=12.6/46.005/7.7/-135/0' });
  await check(
    (await dflt.evaluate(() => window.map.getStyle().sources['mapterhorn-dem'].tileSize)) === 512,
    'default detail declares the tiles at their real size',
  );
  await check(
    await dflt.evaluate(
      () => typeof window.map.getSource('mapterhorn-dem').calculateTileZoom === 'function',
    ),
    'default detail shapes the horizon with the LOD params',
  );
  await dflt.close();
});
