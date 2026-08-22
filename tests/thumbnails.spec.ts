import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

test('tiles grow previews of the settled view', async ({ browser }) => {
  const page = await open(browser);
  await settled(page);
  // The hidden map walks every variant after the main map settles; each snapshot lands
  // as a data: URL on its tile. Wait for the full walk, then compare.
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.tile img')];
      return imgs.length > 0 && imgs.every((img) => img.src.startsWith('data:'));
    },
    null,
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
  await check(src.heatmap !== src.heightmap, 'the shading previews differ from each other');
  await check(src.dark !== src.light, 'the basemap previews differ from each other');
  await page.close();
});

test('a folded tray renders no previews', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  await settled(page, 2000);
  await check(
    await page.evaluate(() =>
      [...document.querySelectorAll('.tile img')].every((img) => !img.getAttribute('src')),
    ),
    'no preview renders while the tray is folded',
  );
  await page.click('#tray-toggle');
  await page.waitForFunction(
    () =>
      document
        .querySelector('#shading-thumbs .tile[data-key="hillshade"] img')
        ?.getAttribute('src'),
    null,
    { timeout: 90000 },
  );
  await check(true, 'opening the tray starts the walk');
  await page.close();
});
