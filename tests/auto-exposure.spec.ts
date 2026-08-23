import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

// The point of the exposure is that the ramp follows the view, so the test is that two
// views with different relief end up pinned to different metres.
test('auto-exposure pins the ramp to the view', async ({ browser }) => {
  const exposed = await open(browser, { hash: '#map=12.6/46.005/7.7/-135/0&shading=heightmap' });
  const ramp = () =>
    exposed.evaluate(() => {
      const stops = window.map.style
        .getLayer('terrain-shading')
        .getPaintProperty('color-relief-color');
      return [stops[3], stops[5]];
    });
  // The 2500ms grace is the exposure's own ease: tiles settle, then the ramp glides to
  // its new pin, and the read has to wait for the glide.
  await settled(exposed, 2500);
  const alpine = await ramp();
  await check(
    alpine[0] > 300 && alpine[1] > 4000,
    'the grey ramp is pinned to the alpine view',
    alpine.join('–'),
  );

  await exposed.evaluate(() => window.map.jumpTo({ center: [5.11, 52.09], zoom: 11, pitch: 0 }));
  await settled(exposed, 2500);
  const dutch = await ramp();
  await check(dutch[1] < 300, 'the ramp follows the view down to a flat one', dutch.join('–'));

  // Hillshade lights the gradient, so there is no exposure to offer at all.
  await exposed.click('#shading-thumbs .tile[data-key="hillshade"]');
  await exposed.waitForTimeout(500);
  await check(
    !(await exposed.locator('#auto-exposure-row').isVisible()),
    'auto-exposure is offered only to the ramps',
  );
  await check(
    (await exposed.textContent('#exposure-range')) === '',
    'the range read-out clears when nothing is exposed',
  );
  await exposed.close();
});

// Grey has nothing to lose by following the view; the heat ramp's absolute colours do —
// so an untouched toggle follows each ramp's default, and a hand-set one sticks.
test('exposure defaults follow the ramp until the box is toggled', async ({ browser }) => {
  const page = await open(browser, { hash: '#shading=heatmap' });
  await check(
    !(await page.isChecked('#auto-exposure')),
    'the heatmap starts with auto-exposure off',
  );
  const heat = await page.evaluate(() => {
    const stops = window.map.style
      .getLayer('terrain-shading')
      .getPaintProperty('color-relief-color');
    return [stops[3], stops[5]].join('–');
  });
  await check(heat === '0–250', 'the heat ramp sits on its own metres', heat);

  await page.click('#shading-thumbs .tile[data-key="heightmap"]');
  await check(
    await page.isChecked('#auto-exposure'),
    'switching to heightmap turns the untouched toggle on',
  );

  await page.uncheck('#auto-exposure');
  await page.click('#shading-thumbs .tile[data-key="heatmap"]');
  await page.click('#shading-thumbs .tile[data-key="heightmap"]');
  await check(
    !(await page.isChecked('#auto-exposure')),
    'a hand-set toggle sticks across ramps',
  );
  await page.close();
});

test('the ⓘ explains auto-exposure', async ({ browser }) => {
  const page = await open(browser, { hash: '#shading=heatmap' });
  const dialogOpen = () =>
    page.evaluate(() => (document.getElementById('exposure-dialog') as HTMLDialogElement).open);
  await page.click('#exposure-info');
  await check(await dialogOpen(), 'the ⓘ opens the explainer');
  await check(
    ((await page.textContent('#exposure-body')) ?? '').includes('Heightmapper'),
    'the explainer credits Heightmapper',
  );
  await page.click('#exposure-close');
  await check(!(await dialogOpen()), 'the X closes it');
  await page.close();
});
