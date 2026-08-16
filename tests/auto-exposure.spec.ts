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

  // Hillshade lights the gradient, so there is no exposure for the checkbox to set.
  await exposed.selectOption('#shading', 'hillshade');
  await exposed.waitForTimeout(500);
  await check(await exposed.isDisabled('#auto-exposure'), 'auto-exposure is offered only to the ramps');
  await check(
    (await exposed.textContent('#exposure-range')) === '',
    'the range read-out clears when nothing is exposed',
  );
  await exposed.close();
});
