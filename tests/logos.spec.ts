import { test } from '@playwright/test';
import { open, check } from './helpers';

test('provider logos follow what the frame shows', async ({ browser }) => {
  const page = await open(browser, { hash: '#terrainScale=1' });

  await check(await page.isVisible('#logos .mapterhorn'), 'relief shows the Mapterhorn logo');
  await check(
    await page.isHidden('#logos .maptiler'),
    'a non-MapTiler basemap shows no MapTiler logo',
  );

  // Flat at 0× — but the default hillshade still reads the DEM, so the logo stays.
  await page.fill('#terrain-scale', '0');
  await page.dispatchEvent('#terrain-scale', 'input');
  await check(
    await page.isVisible('#logos .mapterhorn'),
    'a shading overlay alone keeps the Mapterhorn logo',
  );

  // Flat and unshaded — nothing of Mapterhorn shapes the frame.
  await page.click('#relief-thumbs .tile[data-key="none"]');
  await check(await page.isHidden('#logos'), 'flat and unshaded hides the stack');

  await page.fill('#terrain-scale', '2');
  await page.dispatchEvent('#terrain-scale', 'input');
  await check(await page.isVisible('#logos .mapterhorn'), 'scaling back up brings it back');

  // Satellite is in the tray only when a MapTiler key is configured.
  const satellite = page.locator('#basemap-thumbs .tile[data-key="satellite"]');
  if (await satellite.count()) {
    await satellite.click();
    await check(await page.isVisible('#logos .maptiler'), 'a MapTiler basemap shows their logo');
    await page.click('#basemap-thumbs .tile[data-key="none"]');
    await check(
      await page.isHidden('#logos .maptiler'),
      'hiding the basemap hides the MapTiler logo',
    );
  }
  await page.close();
});
