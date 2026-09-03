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

// The steppers reshape the interval table: "lines" (density) scales every rung, so a
// step up must land more distinct elevations in the same view; both write the hash
// and default to absent.
test('the tuning steppers re-trace the lines', async ({ browser }) => {
  const page = await open(browser, { hash: '#contours=1&map=13/45.9764/7.6586/0/0' });
  await settled(page);
  const levels = () =>
    page.evaluate(
      () =>
        new Set(
          window.map
            .querySourceFeatures('mapterhorn-contours', { sourceLayer: 'contours' })
            .map((f: { properties: { ele: number } }) => f.properties.ele),
        ).size,
    );
  const before = await levels();
  await check(before > 0, 'the default tuning traces lines', `${before} levels`);
  await check(await page.isVisible('#contour-density-up'), 'the settings unfold with contours');
  await check(
    await page.isChecked('input[name="contour-density"][value="0"]'),
    'the middle dot marks the default',
  );

  await page.click('#contour-density-up');
  await page.click('#contour-density-up');
  await page.click('#contour-density-up');
  await check(
    await page.isDisabled('#contour-density-up'),
    'the top of the range greys its button',
  );
  await check(
    await page.isChecked('input[name="contour-density"][value="3"]'),
    'the dot follows the detent',
  );
  // Each press replaces the source; wait for the re-trace to land.
  await settled(page, 1500);
  const after = await levels();
  await check(after > before, 'three detents up traces finer intervals', `${before} → ${after}`);
  await check(
    await page.evaluate(() => location.hash.includes('contourDensity=3')),
    'the tuning lands in the hash',
  );
  await page.close();
});

// A z1 contour tile asks for the DEM two levels up, which patches/maplibre-contour-dem-zoom-floor.patch
// floors at z0; unpatched, the fetch fails and the zoom-out traces nothing.
test('the zoom-out traces lines from the z0 DEM', async ({ browser }) => {
  const page = await open(browser, { hash: '#contours=1&map=1/20/0/0/0' });
  await settled(page, 1500);
  const levels = await page.evaluate(
    () =>
      new Set(
        window.map
          .querySourceFeatures('mapterhorn-contours', { sourceLayer: 'contours' })
          .map((f: { properties: { ele: number } }) => f.properties.ele),
      ).size,
  );
  await check(levels > 1, 'z1 traces sea level and the high plateaus', `${levels} levels`);
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
    await page.isHidden('#contour-labels'),
    'the settings stay folded while contours are off',
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
    await page.isVisible('#contour-labels'),
    'the settings unfold with the lines',
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

  // The unfolded settings hide with the tray: an open fold must not out-vote an
  // ancestor's hidden. Framing is entered by dispatch, not pointer: with the settings
  // and a ramp the card is tall enough to push the camera pill under the geosearch box.
  await page.click('#relief-thumbs .tile[data-key="contours"]');
  await page.evaluate(() => document.getElementById('shot-open')!.click());
  await check(
    (await page.evaluate(() => getComputedStyle(document.getElementById('contour-labels')!).visibility)) === 'hidden',
    'framing mode hides the unfolded settings with the tray',
  );
  await page.close();
});
