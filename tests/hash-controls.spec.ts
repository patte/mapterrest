import { test } from '@playwright/test';
import { open, check } from './helpers';

test('controls write themselves into the hash', async ({ browser }) => {
  const page = await open(browser, { hash: '#terrainScale=1' });

  await page.click('#colour-thumbs .tile[data-key="heatmap"]');
  await page.click('#basemap-thumbs .tile[data-key="none"]');
  await page.check('#auto-exposure');
  await page.fill('#terrain-scale', '3.7');
  await page.dispatchEvent('#terrain-scale', 'input');
  await page.waitForTimeout(500);

  const hash = await page.evaluate(() => location.hash);
  for (const part of ['ramp=heatmap', 'basemapVisible=0', 'terrainScale=3.7', 'autoExposure=1']) {
    await check(hash.includes(part), `hash carries ${part}`);
  }
  await check(
    await page.evaluate(() => window.map.getLayer('terrain-ramp')?.type === 'color-relief'),
    'heatmap adds the color-relief layer',
  );
  await check(
    await page.evaluate(() => !!window.map.getLayer('terrain-hillshade')),
    'the default hillshade stays up over it',
  );

  await page.click('#colour-thumbs .tile[data-key="heatmap"]');
  await page.waitForTimeout(300);
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-ramp')),
    'clicking the pressed ramp turns it off again',
  );
  await check(
    await page.evaluate(
      () =>
        document.querySelector('#colour-thumbs .tile[aria-pressed="true"]')?.getAttribute('data-key') ===
        'none',
    ),
    'and the none tile takes the line',
  );
  await check(
    (await page.evaluate(() => location.hash)).includes('ramp=none'),
    'hash carries ramp=none',
  );

  await page.click('#relief-thumbs .tile[data-key="hillshade"]');
  await check(
    await page.evaluate(() => !window.map.getLayer('terrain-hillshade')),
    'the pressed hillshade tile turns it off',
  );
  await check(
    (await page.evaluate(() => location.hash)).includes('hillshade=0'),
    'hash carries hillshade=0',
  );
  await page.close();
});

test('an edited hash applies without a reload', async ({ browser }) => {
  const page = await open(browser);
  // Editing only the fragment is a same-document navigation: the browser fires
  // hashchange and reloads nothing, so the marker has to survive the edit.
  await page.evaluate(() => {
    (window as any).__sameDocument = true;
    location.hash += '&ramp=heatmap&terrainScale=2.5&debugPivot=1';
  });
  // The terrain apply is coalesced to an animation frame; give it a beat.
  await page.waitForTimeout(500);
  await check(
    await page.evaluate(() => (window as any).__sameDocument === true),
    'the edit reloads nothing',
  );
  await check(
    await page.evaluate(() => window.map.getLayer('terrain-ramp')?.type === 'color-relief'),
    'an edited ramp applies live',
  );
  await check(
    await page.evaluate(
      () =>
        document
          .querySelector('#colour-thumbs .tile[aria-pressed="true"]')
          ?.getAttribute('data-key') === 'heatmap',
    ),
    'the pressed tile follows the hash',
  );
  await check(
    await page.evaluate(() => Math.abs(window.map.getTerrain().exaggeration - 2.5) < 1e-6),
    'an edited terrain scale applies live',
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
  // style.load — so the only honest apply is a reload. Ramp off first: the reloaded page
  // must fit the same 90s budget as any load, and a ramp under software GL spends most
  // of that converging its exposure.
  await page.evaluate(() => {
    location.hash = location.hash.replace('ramp=heatmap', 'ramp=none');
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
    hash: '#basemap=liberty&ramp=heightmap&hillshade=0&terrainScale=2.5',
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
    await restored.evaluate(
      () => !!window.map.getLayer('terrain-ramp') && !window.map.getLayer('terrain-hillshade'),
    ),
    'hash restores the ramp alone, hillshade off',
  );
  await check(
    await restored.evaluate(() => Math.abs(window.map.getTerrain().exaggeration - 2.5) < 1e-6),
    'hash restores the terrain scale',
  );
  await restored.close();
});

// Hillshade and the ramps were one exclusive `shading` choice once; links from then
// still render what they showed.
test('a legacy shading hash still renders as it did', async ({ browser }) => {
  const heat = await open(browser, { hash: '#shading=heatmap' });
  await heat.waitForTimeout(1000);
  await check(
    await heat.evaluate(
      () => !!window.map.getLayer('terrain-ramp') && !window.map.getLayer('terrain-hillshade'),
    ),
    'shading=heatmap is the heat ramp alone',
  );
  await heat.close();

  const off = await open(browser, { hash: '#shading=hillshade&shadingVisible=0' });
  await off.waitForTimeout(1000);
  await check(
    await off.evaluate(
      () => !window.map.getLayer('terrain-ramp') && !window.map.getLayer('terrain-hillshade'),
    ),
    'shadingVisible=0 is no overlay at all',
  );
  await check(
    await off.evaluate(
      () =>
        document.querySelector('#relief-thumbs .tile[aria-pressed="true"]')?.getAttribute('data-key') ===
        'none',
    ),
    'and the relief line shows its none tile pressed',
  );
  await off.close();
});
