import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

// The lines are traced client-side from the DEM tiles, so the test is that the vector
// source actually holds features over the Alps, not just that the layers exist.
test('contours trace the DEM and ride above the shading', async ({ browser }) => {
  const page = await open(browser, { hash: '#contours=1' });
  await settled(page);

  await check(
    await page.evaluate(() => !!window.map.getLayer('terrain-contour-lines')),
    '#contours=1 brings the line layer up',
  );
  const features = await page.evaluate(
    () => window.map.querySourceFeatures('mapterhorn-contours', { sourceLayer: 'contours' }).length,
  );
  await check(features > 0, 'the contour source holds traced lines', `${features} features`);
  await check(
    await page.evaluate(() => {
      const ids = window.map.getStyle().layers.map((l: { id: string }) => l.id);
      return ids.indexOf('terrain-contour-lines') > ids.indexOf('terrain-shading');
    }),
    'the lines draw above the shading',
  );

  // Labels default on, set in the style's own font so its glyphs answer.
  const font = await page.evaluate(
    () => window.map.getLayer('terrain-contour-labels')?.layout.get('text-font').value.value,
  );
  await check(Array.isArray(font) && font.length > 0, 'the labels borrow the style font', String(font));
  await check(await page.isChecked('#contour-labels'), 'the labels checkbox starts checked');
  await page.uncheck('#contour-labels');
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-contour-labels')),
    'unchecking removes the label layer',
  );
  await check(
    await page.evaluate(() => !!window.map.getLayer('terrain-contour-lines')),
    'the lines outlive the labels',
  );
  await check(
    await page.evaluate(() => location.hash.includes('contourLabels=0')),
    'the choice lands in the hash',
  );

  // Contours are an overlay on the terrain, not the basemap: hiding the style leaves them up.
  await page.click('#basemap-thumbs .tile[data-key="none"]');
  await check(
    await page.evaluate(
      () => window.map.getLayoutProperty('terrain-contour-lines', 'visibility') !== 'none',
    ),
    'hiding the basemap leaves the contours up',
  );
  await page.close();
});

test('the contour tile toggles on top of the shading choice', async ({ browser }) => {
  const page = await open(browser);
  const pressed = (key: string) =>
    page.getAttribute(`#shading-thumbs .tile[data-key="${key}"]`, 'aria-pressed');
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-contour-lines')),
    'contours start off',
  );
  await check(
    !(await page.locator('#contour-labels-cluster').isVisible()),
    'the labels checkbox hides while contours are off',
  );

  await page.click('#shading-thumbs .tile[data-key="contours"]');
  await check(
    await page.evaluate(() => !!window.map.getLayer('terrain-contour-lines')),
    'the tile turns the lines on',
  );
  await check(
    (await pressed('contours')) === 'true' && (await pressed('hillshade')) === 'true',
    'contours press alongside the shading, not instead of it',
  );
  await check(
    await page.evaluate(() => location.hash.includes('contours=1')),
    'the toggle lands in the hash',
  );
  await check(
    await page.locator('#contour-labels-cluster').isVisible(),
    'the labels checkbox appears with the lines',
  );

  // The "none" tile empties the whole overlays row, contours included.
  await page.click('#shading-thumbs .tile[data-key="none"]');
  await check(
    await page.evaluate(
      () => !window.map.getLayer('terrain-contour-lines') && !window.map.getLayer('terrain-shading'),
    ),
    'the none tile clears shading and contours together',
  );
  await check((await pressed('none')) === 'true', 'and claims the row');
  await page.close();
});
