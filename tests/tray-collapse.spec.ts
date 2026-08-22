import { test } from '@playwright/test';
import { open, check } from './helpers';

test('the tray folds down to the settings tile on a phone', async ({ browser }) => {
  const phone = await open(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await check(await phone.locator('#tray-tile').isVisible(), 'the settings tile shows on a phone');
  await check(!(await phone.locator('#tray').isVisible()), 'the tray starts folded on a phone');
  await phone.click('#tray-tile');
  await check(await phone.locator('#tray').isVisible(), 'the settings tile opens the tray');
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
  await check(!(await phone.locator('#tray').isVisible()), 'the X folds the tray again');
  await phone.close();
});

test('desktop starts expanded and the X folds it', async ({ browser }) => {
  const page = await open(browser);
  await check(await page.locator('#tray').isVisible(), 'the tray starts open on desktop');
  await check(!(await page.locator('#tray-tile').isVisible()), 'no settings tile while open');
  await page.click('#tray-close');
  await check(!(await page.locator('#tray').isVisible()), 'the X folds the tray on desktop');
  await check(await page.locator('#tray-tile').isVisible(), 'folding leaves the settings tile');
  await page.click('#tray-tile');
  await check(await page.locator('#tray').isVisible(), 'the settings tile brings the tray back');
  await page.close();
});

test('#collapsed=1 forces the fold on desktop', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  await check(await page.locator('#tray-tile').isVisible(), 'the settings tile shows when forced');
  await check(!(await page.locator('#tray').isVisible()), 'the tray starts folded when forced');
  await page.click('#tray-tile');
  await check(await page.locator('#tray').isVisible(), 'the settings tile still opens the tray');
  await page.close();
});
