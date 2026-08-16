import { test } from '@playwright/test';
import { open, check } from './helpers';

test('mobile panel folds away', async ({ browser }) => {
  const phone = await open(browser, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await check(await phone.locator('#panel-toggle').isVisible(), 'toggle button shows on a phone');
  await check(!(await phone.locator('#panel').isVisible()), 'panel starts folded on a phone');
  await phone.click('#panel-toggle');
  await check(await phone.locator('#panel').isVisible(), 'toggle opens the panel');
  await check(
    (await phone.getAttribute('#panel-toggle', 'aria-expanded')) === 'true',
    'toggle reports aria-expanded',
  );
  const overflow = await phone.evaluate(() => {
    const r = document.getElementById('panel')!.getBoundingClientRect();
    return { left: r.left, right: r.right, width: window.innerWidth };
  });
  await check(
    overflow.right <= overflow.width,
    'open panel stays inside the viewport',
    JSON.stringify(overflow),
  );
  await phone.click('#panel-toggle');
  await check(!(await phone.locator('#panel').isVisible()), 'toggle closes the panel again');
  await phone.close();
});

test('desktop panel needs no toggle', async ({ browser }) => {
  const page = await open(browser);
  await check(!(await page.locator('#panel-toggle').isVisible()), 'toggle button hides on desktop');
  await check(await page.locator('#panel').isVisible(), 'panel always open on desktop');
  await page.close();
});
