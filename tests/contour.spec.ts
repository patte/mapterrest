import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

// The lines are traced client-side from the DEM tiles, so the test is that the vector
// source actually holds features over the Alps, not just that the layers exist.
test('contours trace the DEM and ride above the relief', async ({ browser }) => {
  const page = await open(browser, { hash: '#contours=1&ramp=heatmap' });
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
      const [ramp, hillshade, lines] = ['terrain-ramp', 'terrain-hillshade', 'terrain-contour-lines'].map(
        (id) => ids.indexOf(id),
      );
      return ramp >= 0 && ramp < hillshade && hillshade < lines;
    }),
    'the stack draws ramp, then hillshade, then the lines',
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

test('the relief line composes, the colour line chooses', async ({ browser }) => {
  const page = await open(browser);
  const pressed = (line: string, key: string) =>
    page.getAttribute(`#${line}-thumbs .tile[data-key="${key}"]`, 'aria-pressed');
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-contour-lines')),
    'contours start off',
  );
  await check(
    await page.isDisabled('#contour-labels'),
    'the labels checkbox is disabled while contours are off',
  );

  await page.click('#relief-thumbs .tile[data-key="contours"]');
  await check(
    await page.evaluate(() => !!window.map.getLayer('terrain-contour-lines')),
    'the tile turns the lines on',
  );
  await check(
    (await pressed('relief', 'contours')) === 'true' && (await pressed('relief', 'hillshade')) === 'true',
    'contours press alongside the hillshade, not instead of it',
  );
  await check(
    await page.evaluate(() => location.hash.includes('contours=1')),
    'the toggle lands in the hash',
  );
  await check(
    await page.isEnabled('#contour-labels'),
    'the labels checkbox enables with the lines',
  );

  // A ramp joins underneath; the relief stays as it was.
  await page.click('#colour-thumbs .tile[data-key="heatmap"]');
  await check(
    await page.evaluate(
      () =>
        !!window.map.getLayer('terrain-ramp') &&
        !!window.map.getLayer('terrain-hillshade') &&
        !!window.map.getLayer('terrain-contour-lines'),
    ),
    'a colour choice composes with both relief toggles',
  );
  await check(
    (await pressed('colour', 'heatmap')) === 'true' && (await pressed('colour', 'none')) === 'false',
    'the colour line moves its one pressed tile',
  );
  // Over a ramp the hillshade drops the basemap's tinted highlight for a neutral one.
  await check(
    await page.evaluate(
      () => window.map.getPaintProperty('terrain-hillshade', 'hillshade-highlight-color') === '#ffffff',
    ),
    'the hillshade goes neutral over the ramp',
  );

  // The relief "none" clears both toggles and leaves the colour alone.
  await page.click('#relief-thumbs .tile[data-key="none"]');
  await check(
    await page.evaluate(
      () =>
        !window.map.getLayer('terrain-contour-lines') &&
        !window.map.getLayer('terrain-hillshade') &&
        !!window.map.getLayer('terrain-ramp'),
    ),
    'the none tile clears hillshade and contours together, the ramp stays',
  );
  await check((await pressed('relief', 'none')) === 'true', 'and claims the line');
  await page.close();
});
