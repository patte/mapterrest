import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

// The range is what the exposure spreads over the ramp, so what it must not do is answer
// for ground outside the frame: a DEM tile's own extremes cover the whole tile, and a
// coarse tile runs hundreds of kilometres past the edge of the view.
test('visible elevation range answers for the frame', async ({ browser }) => {
  const ranges = await open(browser, { hash: '#map=12.6/46.005/7.7/-135/0' });
  // The range is null until a tile near enough to count has loaded, so wait on that rather
  // than on a duration — a second GL context in a software renderer takes its time.
  const settle = () =>
    ranges.waitForFunction(() => window.visibleRange(window.map, 'mapterhorn-dem') !== null, null, {
      timeout: 60000,
    });

  await settle();
  const zermatt = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
  await check(
    zermatt !== null && zermatt.lo > 300 && zermatt.hi > 4000,
    'Zermatt exposes over the valley and the summits',
    JSON.stringify(zermatt),
  );

  // Bearing is set rather than inherited, because it decides what the check is about: at
  // −135 the frame runs southwest to lat 50.2 and the Ardennes really are on the skyline, so
  // the range is allowed to carry them. What it may not carry is the whole-tile reach that
  // put −299 to 990 m on a country with 95 m of relief.
  await ranges.evaluate(() =>
    window.map.jumpTo({ center: [5.11, 52.09], zoom: 11, pitch: 78, bearing: -135 }),
  );
  await settled(ranges);
  await settle();
  const flat = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
  // The floor is North Sea bathymetry at the skyline, and it deepens with tile
  // coarseness (−73 m at detail=low, −121 m at the default), so it gets room. The guard
  // against whole-tile reach is the ceiling: a leak answers with the Ardennes tiles'
  // full extremes and blows straight past 400 (historically 990).
  await check(
    flat !== null && flat.lo > -160 && flat.hi < 400,
    'the Netherlands at pitch exposes over the frame, not over the tiles behind it',
    JSON.stringify(flat),
  );

  // The view that named the problem: at z5.45 the frame is drawn with z4 tiles a tenth on
  // screen each, whose own extremes are Elbrus and the Karagiye Depression 1200 km south of
  // the bottom edge — −131 to 4839 m over ground that runs 0 to 340 m.
  await ranges.evaluate(() =>
    window.map.jumpTo({ center: [38.024, 57.914], zoom: 5.45, pitch: 0, bearing: 0 }),
  );
  await settled(ranges);
  await settle();
  const coarse = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
  await check(
    coarse !== null && coarse.lo > -30 && coarse.hi < 800,
    'a coarse zoom exposes over the ground in frame, not the tiles that overhang it',
    JSON.stringify(coarse),
  );

  // Open ocean is exactly 0.000 m across the frame. A ramp whose ends meet renders one flat
  // colour, so the floor holds it open — and no wider, since real flat country runs 22 m and
  // up and has its own contrast to keep.
  await ranges.evaluate(() => window.map.jumpTo({ center: [-40, 30], zoom: 12, pitch: 0 }));
  await settled(ranges);
  await settle();
  const still = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
  await check(
    still !== null && still.hi - still.lo > 1 && still.hi - still.lo <= 12,
    'dead-flat water holds the ramp open at the floor, not wider',
    still ? `${(still.hi - still.lo).toFixed(2)} m` : '',
  );

  await ranges.evaluate(() => window.map.jumpTo({ center: [10, 20], zoom: 1, pitch: 0 }));
  await settled(ranges);
  await settle();
  const world = await ranges.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'));
  // A z0 tile is the planet in 256 px, so the summits it carries are flattened — and that
  // is the range to expose over, because it is the data being drawn.
  await check(
    world !== null && world.lo < 0 && world.hi > 3000,
    'the world view exposes over the whole globe',
    JSON.stringify(world),
  );
  await ranges.close();
});
