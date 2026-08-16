import { test } from '@playwright/test';
import { open, check } from './helpers';

test('#debugPivot=1 draws a non-interactive overlay', async ({ browser }) => {
  const debug = await open(browser, {
    viewport: { width: 800, height: 600 },
    hash: '#debugPivot=1',
  });
  await debug.waitForTimeout(10000);
  const overlay = await debug.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.maplibregl-canvas-container canvas:last-child',
    );
    if (!canvas || canvas === document.querySelector('.maplibregl-canvas')) return null;
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
      () => document.querySelectorAll('.maplibregl-canvas-container canvas').length === 1,
    ),
    'without the param there is no overlay',
  );
  await plain.close();
});
