import { test } from '@playwright/test';
import { open, check } from './helpers';

test('the browser colour scheme picks the basemap', async ({ browser }) => {
  for (const [colorScheme, expected] of [
    ['dark', 'carto-dark'],
    ['light', 'carto-light'],
  ] as const) {
    const themed = await open(browser, { colorScheme });
    const picked = await themed.evaluate(() =>
      document
        .querySelector('#basemap-thumbs .tile[aria-pressed="true"]')
        ?.getAttribute('data-key'),
    );
    const body = await themed.evaluate(() => document.body.dataset.theme);
    await check(picked === expected, `${colorScheme} browser picks ${expected}`, `got ${picked}`);
    await check(body === colorScheme, `panel follows the ${colorScheme} scheme`);
    await themed.close();
  }
});

test('an explicit basemap beats the scheme', async ({ browser }) => {
  const chosen = await open(browser, { colorScheme: 'dark', hash: '#basemap=carto-light' });
  await check(
    await chosen.evaluate(
      () =>
        document
          .querySelector('#basemap-thumbs .tile[aria-pressed="true"]')
          ?.getAttribute('data-key') === 'carto-light',
    ),
    'an explicit basemap in the hash beats the browser scheme',
  );
  await chosen.close();
});
