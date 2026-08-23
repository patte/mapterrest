import { test, type Page } from '@playwright/test';
import { open, check, settled } from './helpers';

/**
 * The geocoding endpoint is mocked in every case: the suite must not depend on (or
 * spend) MapTiler's geocoding quota, and fixed features make the camera assertions
 * exact. Routes match newest-first, so registering after open() outranks the tile cache.
 */
const GEOCODING = 'https://api.maptiler.com/geocoding/**';

const ZERMATT = {
  text: 'Zermatt',
  place_name: 'Zermatt, Visp, Valais, Switzerland',
  center: [7.749, 46.021],
  bbox: [7.622, 45.96, 7.879, 46.062],
  place_type: ['municipality'],
};
const STATION = {
  text: 'Bahnhofplatz 5',
  place_name: 'Bahnhofplatz 5, Zermatt, Switzerland',
  center: [7.747, 46.024],
  place_type: ['address'],
};

async function mockGeocoding(page: Page, features: object[]): Promise<void> {
  await page.route(GEOCODING, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features }) }),
  );
}

async function searchFor(page: Page, query: string): Promise<void> {
  await page.click('#geosearch-open');
  await page.fill('#geosearch-input', query);
  await page.waitForSelector('#geosearch-results li');
}

/** The pill animates open and shut, so both states are waited for, not read. */
async function collapsed(page: Page): Promise<boolean> {
  return page
    .waitForSelector('#geosearch-input', { state: 'hidden', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}
async function expanded(page: Page): Promise<boolean> {
  return page
    .waitForSelector('#geosearch-input', { state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}

test('pill expands, results list, selection flies the camera', async ({ browser }) => {
  const page = await open(browser);
  await mockGeocoding(page, [ZERMATT, STATION]);

  await check(await page.isHidden('#geosearch-input'), 'search starts collapsed to the pill');
  await page.click('#geosearch-open');
  await check(await expanded(page), 'pill expands into the input');
  await check(
    await page.evaluate(() => document.activeElement?.id === 'geosearch-input'),
    'the input takes focus on expand',
  );

  await page.fill('#geosearch-input', 'Zermatt');
  await page.waitForSelector('#geosearch-results li');
  const names = await page.$$eval('#geosearch-results .name', (els) => els.map((e) => e.textContent));
  await check(names[0] === 'Zermatt' && names[1] === 'Bahnhofplatz 5', 'both results listed', names.join('|'));

  const before = await page.evaluate(() => ({ bearing: window.map.getBearing() }));
  await page.click('#geosearch-results li >> nth=0');
  await check(await collapsed(page), 'selecting collapses back to the pill');
  // The camera anchor renumbers center and zoom on every moveend (settle keeps the
  // pixels, not the numbers), so arrival is asserted in screen space: the area is
  // found when the bbox's corners all project into the viewport.
  await page.waitForFunction((box) => {
    if (window.map.isMoving()) return false;
    return [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[0], box[3]],
      [box[2], box[3]],
    ].every(([lng, lat]) => {
      const p = window.map.project([lng, lat]);
      return p.x >= 0 && p.x <= innerWidth && p.y >= 0 && p.y <= innerHeight;
    });
  }, ZERMATT.bbox);
  await settled(page);
  const after = await page.evaluate(() => ({
    bearing: window.map.getBearing(),
    pitch: window.map.getPitch(),
  }));
  await check(Math.abs(after.bearing - before.bearing) < 1, 'bearing survives the move');
  await check(Math.abs(after.pitch - 45) < 0.1, 'pitch eases down to the search cap', `pitch ${after.pitch}`);
  await check(
    (await page.locator('.maplibregl-marker').count()) === 0,
    'no marker left on the map',
  );
  await page.close();
});

test('keyboard: / opens, arrows walk, Enter selects a point result, Escape closes', async ({ browser }) => {
  const page = await open(browser);
  await mockGeocoding(page, [ZERMATT, STATION]);

  await page.keyboard.press('/');
  await check(await expanded(page), '/ expands the search');
  await page.fill('#geosearch-input', 'Bahnhof');
  await page.waitForSelector('#geosearch-results li');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await check(
    await page.$eval('#geosearch-item-1', (el) => el.getAttribute('aria-selected') === 'true'),
    'arrow keys move the active row',
  );
  await page.keyboard.press('Enter');
  // Screen space again (see above): the point was flown to when it projects onto the
  // view axis — x at the viewport's middle — and inside the viewport. Late DEM tiles
  // nudge the camera after arrival, so y gets latitude.
  await page.waitForFunction((c) => {
    if (window.map.isMoving()) return false;
    const p = window.map.project(c);
    return Math.abs(p.x - innerWidth / 2) < 60 && p.y > 0 && p.y < innerHeight;
  }, STATION.center);
  await settled(page);
  const state = await page.evaluate(
    (c) => ({ px: window.map.project(c), pitch: window.map.getPitch() }),
    STATION.center,
  );
  await check(
    Math.abs(state.px.x - 700) < 60 && state.px.y > 0 && state.px.y < 900,
    'the address lands on screen on the view axis',
    JSON.stringify(state.px),
  );
  await check(Math.abs(state.pitch - 45) < 0.1, 'pitch eases down to the search cap', `pitch ${state.pitch}`);

  await page.keyboard.press('/');
  await page.keyboard.press('Escape');
  await check(await collapsed(page), 'Escape collapses the search');
  await page.close();
});

test('an API error is shown in the dropdown, scoped to its cause', async ({ browser }) => {
  const page = await open(browser);
  await page.route(GEOCODING, (route) => route.fulfill({ status: 403, body: 'Quota exceeded' }));
  await page.click('#geosearch-open');
  await page.fill('#geosearch-input', 'Zermatt');
  await page.waitForSelector('#geosearch-results li.note.warn');
  const note = await page.textContent('#geosearch-results li.note');
  await check(/HTTP 403/.test(note ?? ''), 'the note names the status', note ?? '');
  await check(/“Quota exceeded”/.test(note ?? ''), "the note quotes the server's words", note ?? '');
  await check(/free MapTiler key/.test(note ?? ''), 'the note explains the shared free key');
  // An invalid key names itself instead of blaming limits (newest route wins).
  await page.route(GEOCODING, (route) =>
    route.fulfill({ status: 403, body: 'Invalid key - Get your FREE key at https://cloud.maptiler.com/account/keys/' }),
  );
  await page.fill('#geosearch-input', 'Matterhorn');
  await page.waitForFunction(() =>
    document.querySelector('#geosearch-results li.note')?.textContent?.includes('not valid'),
  );
  const invalid = await page.textContent('#geosearch-results li.note');
  await check(!/free MapTiler key/.test(invalid ?? ''), 'no limits excuse for a broken key', invalid ?? '');
  await page.close();
});

test('a MapTiler map error raises the notice, other errors do not', async ({ browser }) => {
  const page = await open(browser);
  await page.evaluate(() => {
    window.map.fire('error', {
      error: Object.assign(new Error('Forbidden'), {
        status: 403,
        url: 'https://api.maptiler.com/maps/hybrid-v4/style.json',
      }),
    });
  });
  await check(await page.isVisible('#notice'), 'MapTiler failure shows the notice');
  const text = await page.textContent('#notice p');
  await check(/HTTP 403/.test(text ?? ''), 'the notice names the status', text ?? '');
  await check(/free MapTiler key/.test(text ?? ''), 'the notice explains the shared free key');
  await page.click('#notice-close');
  await check(await page.isHidden('#notice'), 'the X dismisses the notice');

  await page.evaluate(() => {
    window.map.fire('error', {
      error: Object.assign(new Error('boom'), { url: 'https://example.com/tile.png' }),
    });
  });
  await check(await page.isHidden('#notice'), 'a non-MapTiler error stays out of the notice');
  await page.close();
});

test('an unsubmitted query survives a stray click, and searching credits MapTiler', async ({ browser }) => {
  const page = await open(browser);
  await mockGeocoding(page, [ZERMATT]);
  await check(
    await page.locator('#logos .maptiler').isHidden(),
    'no MapTiler logo before any search (carto basemap)',
  );
  await searchFor(page, 'Zermatt');
  // The map, well clear of the search box, its results, and the tray.
  await page.mouse.click(700, 620);
  await check(await page.isVisible('#geosearch-input'), 'the box stays open after the stray click');
  await check((await page.inputValue('#geosearch-input')) === 'Zermatt', 'the typed query survives');
  await check(await page.isVisible('#geosearch-results'), 'the results stay with it');
  await check(await page.locator('#logos .maptiler').isVisible(), 'searching raises the MapTiler logo');
  const title = await page.getAttribute('#logos .maptiler', 'title');
  await check(title === 'search by MapTiler', 'the credit names the search, not the basemap', title ?? '');
  await page.click('#geosearch-close');
  await check(await collapsed(page), 'the X still cancels it');
  await page.click('#geosearch-open');
  await check((await page.inputValue('#geosearch-input')) === '', 'reopening starts fresh');
  await page.close();
});

test('typing away below two characters clears the results', async ({ browser }) => {
  const page = await open(browser);
  await mockGeocoding(page, [ZERMATT]);
  await searchFor(page, 'Zermatt');
  await page.fill('#geosearch-input', 'Z');
  await check(await page.isHidden('#geosearch-results'), 'short query hides the results');
  await page.close();
});
