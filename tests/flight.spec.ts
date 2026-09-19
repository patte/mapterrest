import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

/* The forward and orbit toggles beside the magnifier */

const DEG = Math.PI / 180;

type Camera = {
  lngLat: { lng: number; lat: number };
  altitude: number;
  bearing: number;
  pitch: number;
  /** Where the given pivot projects to, read in the same frame as the rest. */
  at: { x: number; y: number } | null;
  /** Page time of the read: rates come from this, not from the test's own waits. */
  t: number;
};

/** The camera as the flight sees it: position, altitude, attitude. Runs in the page. */
const camera = (pivot: { x: number; y: number; elevation: number } | null = null): Camera => ({
  lngLat: window.map._camera.transform.getCameraLngLat(),
  altitude: window.map._camera.transform.getCameraAltitude(),
  bearing: window.map.getBearing(),
  pitch: window.map.getPitch(),
  at: pivot && window.projectPoint(window.map, pivot),
  t: performance.now(),
});

/** Metres east and north from a to b, flat-earth at a's latitude — fine over a few km. */
const offsetM = (a: Camera, b: Camera) => {
  const perDegLat = 111320;
  return {
    east: (b.lngLat.lng - a.lngLat.lng) * perDegLat * Math.cos(a.lngLat.lat * DEG),
    north: (b.lngLat.lat - a.lngLat.lat) * perDegLat,
  };
};

test('forward flies level along the bearing', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  await settled(page, 500);

  const forward = page.locator('#flight-forward');
  const before = await page.evaluate(camera, null);
  await forward.click();
  await check((await forward.getAttribute('aria-pressed')) === 'true', 'the button shows it is flying');
  await page.waitForTimeout(2000);
  const mid = await page.evaluate(camera, null);
  await forward.click();
  await check((await forward.getAttribute('aria-pressed')) === 'false', 'a second click lands');
  const landed = await page.evaluate(camera, null);
  await page.waitForTimeout(500);
  const after = await page.evaluate(camera, null);

  const moved = offsetM(before, mid);
  const distance = Math.hypot(moved.east, moved.north);
  // Heading of the movement, compass style, against the bearing it should follow.
  const heading = (Math.atan2(moved.east, moved.north) / DEG + 360) % 360;
  const bearing = (before.bearing + 360) % 360;
  const off = Math.abs(((heading - bearing + 540) % 360) - 180);
  await check(distance > 100, 'the camera moved', `${distance.toFixed(0)} m in 2 s`);
  await check(off < 1, 'along the bearing', `heading ${heading.toFixed(1)}°, bearing ${bearing.toFixed(1)}°`);
  await check(
    Math.abs(mid.altitude - before.altitude) < 2,
    'at the same altitude',
    `${(mid.altitude - before.altitude).toFixed(1)} m`,
  );
  await check(
    Math.abs(mid.bearing - before.bearing) < 0.01 && Math.abs(mid.pitch - before.pitch) < 0.01,
    'looking the same way',
    `Δbearing ${(mid.bearing - before.bearing).toFixed(2)}°, Δpitch ${(mid.pitch - before.pitch).toFixed(2)}°`,
  );
  const drift = offsetM(landed, after);
  await check(
    Math.hypot(drift.east, drift.north) < 5,
    'landing stays where the flight stopped',
    `${Math.hypot(drift.east, drift.north).toFixed(1)} m`,
  );
  await page.close();
});

test('orbit turns about the subject of the frame', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  await settled(page, 500);

  const orbit = page.locator('#flight-orbit');
  const pivot = await page.evaluate(() => window.choosePivot(window.map)?.point ?? null);
  await check(!!pivot, 'the frame has a subject to turn about');
  const before = await page.evaluate(camera, pivot);
  await orbit.click();
  await check((await orbit.getAttribute('aria-pressed')) === 'true', 'the button shows it is turning');
  // Past the ease-in, so the rate read is the cruising one.
  await page.waitForTimeout(1200);
  const started = await page.evaluate(camera, pivot);
  await page.waitForTimeout(1500);
  const mid = await page.evaluate(camera, pivot);
  await orbit.click();
  await check((await orbit.getAttribute('aria-pressed')) === 'false', 'a second click lands');

  const turned = mid.bearing - before.bearing;
  const rate = (mid.bearing - started.bearing) / ((mid.t - started.t) / 1000);
  // Loose below: the loop caps a frame's share at 100 ms, so a starved renderer (five
  // workers on one GPU) turns slower than nominal. Never faster.
  await check(turned > 2 && rate > 1.5 && rate < 3.3, 'turns at the orbit rate', `${rate.toFixed(2)}°/s`);
  await check(Math.abs(mid.pitch - before.pitch) < 0.01, 'without tilting', `Δ${(mid.pitch - before.pitch).toFixed(2)}°`);
  const err = Math.hypot(mid.at!.x - before.at!.x, mid.at!.y - before.at!.y);
  await check(err < 10, 'the pivot holds its pixel', `${err.toFixed(1)} px`);
  const moved = offsetM(before, mid);
  await check(Math.hypot(moved.east, moved.north) > 50, 'the camera swings, not just the view', `${Math.hypot(moved.east, moved.north).toFixed(0)} m`);

  // Every stop reverses the turn, and the arrow says so before the next press.
  await check(
    (await page.evaluate(() => window.flight.spin)) === -1 && (await orbit.getAttribute('data-spin')) === 'ccw',
    'stopping reverses the next orbit',
  );
  await orbit.click();
  const again = await page.evaluate(camera, pivot);
  await page.waitForTimeout(1500);
  const back = await page.evaluate(camera, pivot);
  await orbit.click();
  await check(back.bearing < again.bearing - 1, 'and it turns the other way', `${(back.bearing - again.bearing).toFixed(1)}°`);
  await check((await orbit.getAttribute('data-spin')) === 'cw', 'and reverses again');
  await page.close();
});

test('one flight at a time, and the user always wins', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  await settled(page, 500);
  const forward = page.locator('#flight-forward');
  const orbit = page.locator('#flight-orbit');
  const state = () => page.evaluate(() => ({ mode: window.flight.mode, flying: window.flight.flying }));

  await forward.click();
  await orbit.click();
  await check((await state()).mode === 'orbit', 'starting the orbit ends the forward flight');
  await check(
    (await forward.getAttribute('aria-pressed')) === 'false' && (await orbit.getAttribute('aria-pressed')) === 'true',
    'the buttons show which one runs',
  );

  // A plain drag on the map: the flight lets go of the camera for as long as the hand is
  // on it, and takes off again once it is off and the map has been quiet.
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(430, 410, { steps: 4 });
  const held = await page.evaluate(() => ({ ...{ mode: window.flight.mode, flying: window.flight.flying }, bearing: window.map.getBearing() }));
  await page.waitForTimeout(1500);
  const stillHeld = await page.evaluate(() => ({ flying: window.flight.flying, bearing: window.map.getBearing() }));
  await check(held.mode === 'orbit' && !held.flying, 'a drag pauses the flight, not the mode');
  await check((await orbit.getAttribute('aria-pressed')) === 'true', 'and the button stays pressed');
  await check(
    !stillHeld.flying && stillHeld.bearing === held.bearing,
    'a hand resting on the map keeps it paused',
    `${(stillHeld.bearing - held.bearing).toFixed(2)}° while held`,
  );
  await page.mouse.up();
  await page.waitForFunction(() => window.flight.flying, null, { timeout: 10000 });
  await check((await state()).flying, 'it takes off again once the hand is off');

  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 120);
  await check(!(await state()).flying, 'the wheel pauses it too');
  await page.waitForFunction(() => window.flight.flying, null, { timeout: 10000 });

  await orbit.click();
  await forward.click();
  const boxes = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    return { search: box('#geosearch-box'), flight: box('#flight') };
  });
  await check(
    boxes.search.top === boxes.flight.top && boxes.search.height === boxes.flight.height,
    'the pill stands level with the magnifier',
    `${boxes.search.height} vs ${boxes.flight.height} px tall`,
  );
  await check(boxes.flight.left - boxes.search.right >= 8, 'with a gap between them');
  await page.screenshot({ path: 'shots/flight-pill.png', clip: { x: 0, y: 0, width: 200, height: 60 } });
  await page.close();
});

test('a flight pauses to let the map go idle, then flies on', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  await settled(page, 500);
  await page.evaluate(() => {
    (window as any).__idles = 0;
    window.map.on('idle', () => {
      if (window.flight.mode) (window as any).__idles += 1;
    });
  });
  const forward = page.locator('#flight-forward');
  await forward.click();
  // Past the first leg, its pause and the second leg's ease-in.
  await page.waitForTimeout(12500);
  const a = await page.evaluate(camera, null);
  await page.waitForTimeout(700);
  const b = await page.evaluate(camera, null);
  const idles = await page.evaluate(() => (window as any).__idles as number);
  await forward.click();

  await check(idles >= 1, 'the map went idle mid-flight', `${idles} idle events`);
  const moved = offsetM(a, b);
  await check(
    Math.hypot(moved.east, moved.north) > 50,
    'and the flight went on afterwards',
    `${Math.hypot(moved.east, moved.north).toFixed(0)} m in 0.7 s`,
  );
  await page.close();
});

test('the flight lives in the hash', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  await settled(page, 500);
  const hash = () => page.evaluate(() => location.hash);
  const mode = () => page.evaluate(() => window.flight.mode);

  await page.locator('#flight-orbit').click();
  await check((await hash()).includes('flight=orbit'), 'starting writes flight=orbit');
  await page.locator('#flight-forward').click();
  await check((await hash()).includes('flight=forward'), 'switching writes flight=forward');
  await page.locator('#flight-forward').click();
  await check(!(await hash()).includes('flight='), 'a stop takes the key out');
  // The orbit above was stopped once, so the next one turns the other way — and a
  // reload has to know that.
  await check((await hash()).includes('spin=ccw'), 'the next orbit direction is in the hash');

  await page.evaluate(() => {
    location.hash += '&flight=orbit';
  });
  await page.waitForFunction(() => window.flight.mode === 'orbit', null, { timeout: 5000 });
  await check((await mode()) === 'orbit', 'an edited hash starts the flight');
  await page.close();

  const restored = await open(browser, { viewport: { width: 800, height: 600 }, hash: '#flight=orbit&spin=ccw' });
  await restored.waitForFunction(() => window.flight.mode === 'orbit', null, { timeout: 90000 });
  await check((await restored.evaluate(() => window.flight.mode)) === 'orbit', 'a reload takes off again');
  await check(
    (await restored.evaluate(() => window.flight.spin)) === -1 &&
      (await restored.locator('#flight-orbit').getAttribute('data-spin')) === 'ccw',
    'turning the way the hash says',
  );
  await restored.close();
});
