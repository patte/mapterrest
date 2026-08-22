import { test } from '@playwright/test';
import { open, check } from './helpers';

test('the tray folds down to the settings tile on a phone', async ({ browser }) => {
  const phone = await open(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await check(await phone.locator('#tray-tile').isVisible(), 'the settings tile shows on a phone');
  await check(!(await phone.locator('#card').isVisible()), 'the card starts folded on a phone');
  await phone.click('#tray-tile');
  await check(await phone.locator('#card').isVisible(), 'the settings tile opens the tray');
  await check(
    (await phone.getAttribute('#tray-tile', 'aria-expanded')) === 'true',
    'the settings tile reports aria-expanded',
  );
  const overflow = await phone.evaluate(() => {
    const r = document.getElementById('tray')!.getBoundingClientRect();
    return { left: r.left, right: r.right, width: window.innerWidth };
  });
  await check(
    overflow.right <= overflow.width,
    'the open tray stays inside the viewport',
    JSON.stringify(overflow),
  );
  await phone.click('#tray-close');
  await check(!(await phone.locator('#card').isVisible()), 'the X folds the card again');
  await phone.close();
});

test('desktop starts expanded and the X folds it', async ({ browser }) => {
  const page = await open(browser);
  await check(await page.locator('#card').isVisible(), 'the card starts open on desktop');
  await check(!(await page.locator('#tray-tile').isVisible()), 'no settings tile while open');
  await page.click('#tray-close');
  await check(!(await page.locator('#card').isVisible()), 'the X folds the card on desktop');
  await check(await page.locator('#tray-tile').isVisible(), 'folding leaves the settings tile');
  await check(await page.locator('#about').isVisible(), 'the About pill outlives the fold');
  await page.click('#tray-tile');
  await check(await page.locator('#card').isVisible(), 'the settings tile brings the card back');
  await page.close();
});

test('a tight corner folds one of card and attribution', async ({ browser }) => {
  // 800px: too narrow for the open card and the expanded attribution side by side.
  const page = await open(browser, { viewport: { width: 800, height: 600 } });
  const expanded = () =>
    page.evaluate(() =>
      document.querySelector('.maplibregl-ctrl-attrib')!.classList.contains('maplibregl-compact-show'),
    );
  await check(!(await expanded()), 'at load the open card wins the tight corner');
  // Until every source has landed its credit the strip can be short enough to fit
  // beside the card — no conflict, nothing to fold. Wait for the full line.
  await page.waitForFunction(
    () => document.querySelector('.maplibregl-ctrl-attrib')?.textContent?.includes('OpenStreetMap'),
    null,
    { timeout: 90000 },
  );
  await page.click('.maplibregl-ctrl-attrib-button');
  // The fold lands one animation frame after the click — the geometry is unreadable
  // inside the click itself — so poll for it rather than glancing.
  const folded = await page
    .waitForFunction(() => document.body.classList.contains('tray-closed'), null, { timeout: 5000 })
    .then(() => true, () => false);
  await check(folded, 'expanding the attribution folds the card');
  await check(await expanded(), 'the attribution stays expanded');
  await page.click('#tray-tile');
  await check(await page.locator('#card').isVisible(), 'reopening the card takes the corner back');
  await check(!(await expanded()), 'and collapses the attribution again');
  await page.close();
});

test('#collapsed=1 forces the fold on desktop', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  await check(await page.locator('#tray-tile').isVisible(), 'the settings tile shows when forced');
  await check(!(await page.locator('#card').isVisible()), 'the card starts folded when forced');
  await page.click('#tray-tile');
  await check(await page.locator('#card').isVisible(), 'the settings tile still opens the tray');
  await page.close();
});
