import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

test('#debugPivot=1 draws a non-interactive overlay', async ({ browser }) => {
  const debug = await open(browser, {
    viewport: { width: 800, height: 600 },
    hash: '#debugPivot=1',
  });
  await settled(debug, 500);
  const overlay = await debug.evaluate(() => {
    // Scoped to #map: the thumbnailer keeps its own maplibre canvas offscreen.
    const canvas = document.querySelector<HTMLCanvasElement>(
      '#map .maplibregl-canvas-container canvas:last-child',
    );
    if (!canvas || canvas === document.querySelector('#map .maplibregl-canvas')) return null;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let drawn = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) drawn++;
    return { drawn, pointerEvents: getComputedStyle(canvas).pointerEvents };
  });
  await check(!!overlay, '#debugPivot=1 adds an overlay canvas');
  await check((overlay?.drawn ?? 0) > 0, 'the overlay draws the pivot and its grid', `${overlay?.drawn} px`);
  await check(overlay?.pointerEvents === 'none', 'the overlay does not swallow the gesture');
  await debug.close();
});

test('without the param there is no overlay', async ({ browser }) => {
  const plain = await open(browser, { viewport: { width: 400, height: 300 } });
  await check(
    await plain.evaluate(
      () => document.querySelectorAll('#map .maplibregl-canvas-container canvas').length === 1,
    ),
    'without the param there is no overlay',
  );
  await plain.close();
});

test('#debugPerf=1 counts what the page holds on the GPU', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 800, height: 600 }, hash: '#debugPerf=1' });
  await settled(page, 1200);
  const line = await page.evaluate(
    () =>
      [...document.querySelectorAll('#map div')]
        .map((el) => el.textContent ?? '')
        .find((t) => t.includes('gpu ')) ?? '',
  );
  const m = /gpu (\d+) MiB in (\d+) textures/.exec(line);
  await check(!!m, 'the overlay has a gpu line', line.slice(0, 200));
  // A loaded terrain view is hundreds of MiB across hundreds of textures, never zero:
  // the counter was installed before the map so it saw every upload.
  await check(Number(m?.[1]) > 50 && Number(m?.[2]) > 20, 'the count is the map, not a late start', m?.[0] ?? '');
  await page.close();
});
