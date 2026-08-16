import { test } from '@playwright/test';
import { open, check } from './helpers';

test('Mapterhorn is credited', async ({ browser }) => {
  const page = await open(browser);
  const attribution = await page.textContent('.maplibregl-ctrl-attrib');
  await check(/Mapterhorn/.test(attribution ?? ''), 'Mapterhorn credited in the attribution control');
  await check(
    (await page.locator('.maplibregl-ctrl-attrib a[href*="mapterhorn.com"]').count()) > 0,
    'attribution links to mapterhorn.com',
  );
  await page.close();
});
