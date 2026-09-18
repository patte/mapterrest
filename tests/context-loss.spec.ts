import { test, expect } from '@playwright/test';
import { open } from './helpers';

/* A lost WebGL context gets a notice and a reload, not a dead map and a TypeError */

test('a lost context shows the notice and reloads onto the same view', async ({ browser }) => {
  const page = await open(browser, { hash: '#hillshade=0' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const reloaded = page.waitForEvent('load');
  // What the GPU process does to the page when it runs out of memory, on demand.
  await page.evaluate(() => {
    window.map.painter.context.gl.getExtension('WEBGL_lose_context').loseContext();
  });

  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toContainText(/graphics/i);
  // The range read the thumbnail walk makes against the dead style answers null, not a throw.
  expect(await page.evaluate(() => window.visibleRange(window.map, 'mapterhorn-dem'))).toBeNull();

  await reloaded;
  await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
  expect(await page.evaluate(() => location.hash)).toContain('hillshade=0');
  expect(errors).toEqual([]);
});
