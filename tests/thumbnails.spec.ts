import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

const ROW_TILES = '#shading-thumbs .tile, #basemap-thumbs .tile';

test('a default load answers every preview from the bake, without a walk', async ({ browser }) => {
  const page = await open(browser);
  await settled(page);
  // The walk consults the baked manifest per variant; delivery through onImage is the
  // sign it ran and chose the bake.
  await page.waitForFunction(
    (sel) => (window.__thumbImages?.size ?? 0) >= document.querySelectorAll(sel).length,
    ROW_TILES,
    { timeout: 90000 },
  );
  await check(
    await page.evaluate(() => !window.__mini),
    'no mini map exists — nothing rendered, no tile requests spent',
  );
  await check(
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>('#shading-thumbs .tile img, #basemap-thumbs .tile img')].every(
        (img) => img.src.length > 0,
      ),
    ),
    'every row tile shows a preview',
  );
  // A moved camera invalidates the bake: previews grow live again, from a mini map.
  await page.evaluate(() => window.map.jumpTo({ center: [6.8652, 45.8326], zoom: 11 }));
  await settled(page);
  await page.waitForFunction(
    (sel) =>
      [...document.querySelectorAll<HTMLImageElement>(sel)].every((tile) =>
        tile.querySelector('img')!.src.startsWith('data:'),
      ),
    ROW_TILES,
    { timeout: 90000 },
  );
  const src = await page.evaluate(() => {
    const at = (sel: string) => document.querySelector<HTMLImageElement>(`${sel} img`)!.src;
    return {
      heatmap: at('#shading-thumbs .tile[data-key="heatmap"]'),
      heightmap: at('#shading-thumbs .tile[data-key="heightmap"]'),
      dark: at('#basemap-thumbs .tile[data-key="carto-dark"]'),
      light: at('#basemap-thumbs .tile[data-key="carto-light"]'),
    };
  });
  await check(src.heatmap !== src.heightmap, 'the live shading previews differ from each other');
  await check(src.dark !== src.light, 'the live basemap previews differ from each other');
  await page.close();
});

test('a folded tray costs no walk, and opening it finds the bake in place', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  // The settings tile previews the view itself, cut from the main map's own frame.
  await page.waitForFunction(
    () => document.querySelector('#tray-tile img')?.getAttribute('src')?.startsWith('data:'),
    null,
    { timeout: 90000 },
  );
  await settled(page, 2000);
  await check(
    await page.evaluate(() => !window.__mini),
    'the settings preview never spends a mini map',
  );
  await page.click('#tray-tile');
  await page.waitForFunction(
    (sel) => (window.__thumbImages?.size ?? 0) >= document.querySelectorAll(sel).length,
    ROW_TILES,
    { timeout: 90000 },
  );
  await check(
    await page.evaluate(() => !window.__mini),
    'opening the tray needs no walk either — the bake covers the default view',
  );
  await page.close();
});
