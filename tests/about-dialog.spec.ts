import { test } from '@playwright/test';
import { open, check } from './helpers';

test('the About dialog fits a phone screen and scrolls from the top', async ({ browser }) => {
  // Short enough that the essay outgrows the screen and the body must scroll.
  const phone = await open(browser, {
    viewport: { width: 390, height: 600 },
    hasTouch: true,
    isMobile: true,
    hash: '#about=1',
  });
  const g = await phone.evaluate(() => {
    const d = document.getElementById('about-dialog')!.getBoundingClientRect();
    const b = document.getElementById('about-body')!;
    return {
      top: d.top,
      bottom: d.bottom,
      viewportH: window.innerHeight,
      scrollTop: b.scrollTop,
      scrollable: b.scrollHeight > b.clientHeight,
    };
  });
  await check(
    g.top >= 0 && g.bottom <= g.viewportH,
    'the dialog stays inside the visible viewport',
    JSON.stringify(g),
  );
  await check(g.scrollTop === 0, 'the essay starts at its beginning');
  await check(g.scrollable, 'the body is a scrollport where the essay outgrows the screen');
  await check(
    await phone.locator('#about-body h1').isVisible(),
    'the title is on screen before any scrolling',
  );
  await phone.close();
});
