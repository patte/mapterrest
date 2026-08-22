import { test } from '@playwright/test';
import { open, check } from './helpers';

test('the tray folds behind a chip on a phone', async ({ browser }) => {
  const phone = await open(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await check(await phone.locator('#tray-toggle').isVisible(), 'the chip shows on a phone');
  await check(!(await phone.locator('#tray').isVisible()), 'the tray starts folded on a phone');
  await phone.click('#tray-toggle');
  await check(await phone.locator('#tray').isVisible(), 'the chip opens the tray');
  await check(
    (await phone.getAttribute('#tray-toggle', 'aria-expanded')) === 'true',
    'the chip reports aria-expanded',
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
  await phone.click('#tray-toggle');
  await check(!(await phone.locator('#tray').isVisible()), 'the chip closes the tray again');
  await phone.close();
});

test('desktop tray needs no chip', async ({ browser }) => {
  const page = await open(browser);
  await check(!(await page.locator('#tray-toggle').isVisible()), 'the chip hides on desktop');
  await check(await page.locator('#tray').isVisible(), 'the tray is always open on desktop');
  await page.close();
});

test('#collapsed=1 forces the fold on desktop', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  await check(await page.locator('#tray-toggle').isVisible(), 'the chip shows when forced');
  await check(!(await page.locator('#tray').isVisible()), 'the tray starts folded when forced');
  await page.click('#tray-toggle');
  await check(await page.locator('#tray').isVisible(), 'the chip still opens the tray');
  await page.close();
});
