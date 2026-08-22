import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

test('a basemap switch leaves the camera where it was', async ({ browser }) => {
  // The default Zermatt view, pinned: high pitch over deep relief, where a lost centre
  // elevation moves the camera by kilometres. Dark scheme, so the switch to carto-light
  // below actually changes the style rather than no-oping on the default.
  const page = await open(browser, {
    hash: '#map=12.6/46.005/7.7/-135/78',
    colorScheme: 'dark',
  });
  await settled(page);

  const before = await page.evaluate(() => {
    const tr = window.map._camera.transform;
    return { altitude: tr.getCameraAltitude(), elevation: tr.elevation };
  });
  // The load-time anchoring has landed the centre on terrain — the switch that follows
  // has real height to lose.
  await check(
    before.elevation > 500,
    'the settled centre sits on terrain',
    `${before.elevation.toFixed(0)} m`,
  );

  await page.click('#basemap-thumbs .tile[data-key="carto-light"]');
  await settled(page);

  const after = await page.evaluate(() => {
    const tr = window.map._camera.transform;
    return {
      altitude: tr.getCameraAltitude(),
      ground: window.map.queryTerrainElevation(tr.getCameraLngLat()),
    };
  });
  const moved = after.altitude - before.altitude;
  await check(
    Math.abs(moved) < 1,
    'camera altitude survives the switch',
    `moved ${moved.toFixed(1)} m`,
  );
  await check(
    after.ground !== null && after.altitude > after.ground,
    'the camera is above the ground',
    `altitude ${after.altitude.toFixed(0)} m over ground ${after.ground?.toFixed(0)} m`,
  );
  await page.close();
});
