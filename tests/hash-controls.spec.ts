import { test } from '@playwright/test';
import { open, check } from './helpers';

test('controls write themselves into the hash', async ({ browser }) => {
  const page = await open(browser, { hash: '#exaggeration=1' });

  await page.selectOption('#shading', 'heatmap');
  await page.uncheck('#basemap-visible');
  await page.uncheck('#auto-exposure');
  await page.fill('#exaggeration', '3.7');
  await page.dispatchEvent('#exaggeration', 'input');
  await page.waitForTimeout(500);

  const hash = await page.evaluate(() => location.hash);
  for (const part of ['shading=heatmap', 'basemapVisible=0', 'exaggeration=3.7', 'autoExposure=0']) {
    await check(hash.includes(part), `hash carries ${part}`);
  }
  await check(
    await page.evaluate(() => window.map.getLayer('terrain-shading')?.type === 'color-relief'),
    'heatmap swaps in the color-relief layer',
  );

  await page.uncheck('#shading-visible');
  await page.waitForTimeout(300);
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-shading')),
    'shading checkbox removes the layer',
  );
  await check(
    (await page.evaluate(() => location.hash)).includes('shadingVisible=0'),
    'hash carries shadingVisible=0',
  );
  await page.close();
});

test('the hash restores the controls', async ({ browser }) => {
  const restored = await open(browser, {
    hash: '#basemap=liberty&shading=heatmap&shadingVisible=0&exaggeration=2.5',
  });
  await restored.waitForTimeout(1500);
  await check(
    await restored.evaluate(() => (document.getElementById('basemap') as any).value === 'liberty'),
    'hash restores the basemap',
  );
  await check(
    await restored.evaluate(() => !window.map.getLayer('terrain-shading')),
    'hash restores shading off',
  );
  await check(
    await restored.evaluate(() => Math.abs(window.map.getTerrain().exaggeration - 2.5) < 1e-6),
    'hash restores exaggeration',
  );
  await restored.close();
});
