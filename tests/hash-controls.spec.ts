import { test } from '@playwright/test';
import { open, check } from './helpers';

test('controls write themselves into the hash', async ({ browser }) => {
  const page = await open(browser, { hash: '#exaggeration=1' });

  await page.click('#shading-thumbs .tile[data-key="heatmap"]');
  await page.click('#basemap-thumbs .tile[data-key="none"]');
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

  await page.click('#shading-thumbs .tile[data-key="none"]');
  await page.waitForTimeout(300);
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-shading')),
    'the no-shading tile removes the layer',
  );
  await check(
    (await page.evaluate(() => location.hash)).includes('shadingVisible=0'),
    'hash carries shadingVisible=0',
  );
  await page.close();
});

test('an edited hash applies without a reload', async ({ browser }) => {
  const page = await open(browser);
  // Editing only the fragment is a same-document navigation: the browser fires
  // hashchange and reloads nothing, so the marker has to survive the edit.
  await page.evaluate(() => {
    (window as any).__sameDocument = true;
    location.hash += '&shading=heatmap&exaggeration=2.5&debugPivot=1';
  });
  // The terrain apply is coalesced to an animation frame; give it a beat.
  await page.waitForTimeout(500);
  await check(
    await page.evaluate(() => (window as any).__sameDocument === true),
    'the edit reloads nothing',
  );
  await check(
    await page.evaluate(() => window.map.getLayer('terrain-shading')?.type === 'color-relief'),
    'an edited shading applies live',
  );
  await check(
    await page.evaluate(
      () =>
        document
          .querySelector('#shading-thumbs .tile[aria-pressed="true"]')
          ?.getAttribute('data-key') === 'heatmap',
    ),
    'the pressed tile follows the hash',
  );
  await check(
    await page.evaluate(() => Math.abs(window.map.getTerrain().exaggeration - 2.5) < 1e-6),
    'an edited exaggeration applies live',
  );
  // Scoped to #map: the thumbnailer keeps its own maplibre canvas offscreen.
  await check(
    await page.evaluate(
      () => document.querySelectorAll('#map .maplibregl-canvas-container canvas').length === 2,
    ),
    'debugPivot=1 adds the overlay live',
  );

  await page.evaluate(() => {
    location.hash = location.hash.replace('debugPivot=1', 'debugPivot=0');
  });
  await page.waitForTimeout(200);
  await check(
    await page.evaluate(
      () => document.querySelectorAll('#map .maplibregl-canvas-container canvas').length === 1,
    ),
    'debugPivot=0 removes it again',
  );

  // detail is a construction-time choice — tileSize only counts on a source declared at
  // style.load — so the only honest apply is a reload. Back on hillshade first: the
  // reloaded page must fit the same 90s budget as any load, and a ramp under software
  // GL spends most of that converging its exposure.
  await page.evaluate(() => {
    location.hash = location.hash.replace('shading=heatmap', 'shading=hillshade');
    location.hash += '&detail=low';
  });
  await page.waitForFunction(
    () => !(window as any).__sameDocument && (window as any).map?.loaded?.(),
    null,
    { timeout: 90000 },
  );
  await check(
    await page.evaluate(
      () => window.map.getSource('mapterhorn-dem').calculateTileZoom === undefined,
    ),
    'an edited detail reloads into the new mode',
  );
  await page.close();
});

test('the hash restores the controls', async ({ browser }) => {
  const restored = await open(browser, {
    hash: '#basemap=liberty&shading=heatmap&shadingVisible=0&exaggeration=2.5',
  });
  await restored.waitForTimeout(1500);
  await check(
    await restored.evaluate(
      () =>
        document
          .querySelector('#basemap-thumbs .tile[aria-pressed="true"]')
          ?.getAttribute('data-key') === 'liberty',
    ),
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
