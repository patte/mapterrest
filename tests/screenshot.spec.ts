import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { open, check, settled } from './helpers';

/** Width and height straight from the IHDR chunk. */
function pngSize(file: string): [number, number] {
  const bytes = readFileSync(file);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('framing mode captures print-density paper crops', async ({ browser }) => {
  const page = await open(browser);
  await settled(page);

  await check(await page.isVisible('#shot-open'), 'camera pill shows beside the hint');

  await page.click('#shot-open');
  await check(await page.isVisible('#shot-frame'), 'camera opens framing mode');
  const visibility = (sel: string) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s)!).visibility, sel);
  await check((await visibility('#tray')) === 'hidden', 'framing hides the tray');
  await check(
    (await visibility('.maplibregl-ctrl-bottom-right')) === 'visible',
    'the credited corner stays on screen',
  );

  const aspect = async (): Promise<number> => {
    const box = (await page.locator('#shot-rect').boundingBox())!;
    return box.width / box.height;
  };
  await check(Math.abs((await aspect()) - 297 / 210) < 0.01, 'the rectangle starts A4 landscape');

  // The capture reshapes the live camera (clamp toggle, viewport growth, zoom shift)
  // and must hand back the exact view; measured as the Matterhorn's screen position.
  const peak = (): Promise<[number, number]> =>
    page.evaluate(() => {
      const p = window.map.project([7.6586, 45.9763]);
      return [p.x, p.y];
    });
  const peakBefore = await peak();
  await check(
    (await page.locator('#shot-format option').allTextContents()).join(' ') ===
      'A2 A3 A4 A5 A6 Letter Legal Tabloid',
    'the dropdown offers the A series and the US trio',
  );

  const a4Download = page.waitForEvent('download');
  await page.click('#shot-capture');
  // saveAs, not path(): against the resident browser the page is a remote connection,
  // and there a download's temp path is not exposed.
  const a4 = test.info().outputPath('a4.png');
  await (await a4Download).saveAs(a4);
  const [w, h] = pngSize(a4);
  await check(w === 3508 && h === 2480, 'A4 landscape exports at 300 dpi', `${w}×${h}`);

  // Decode the export in the page: a grid sample proves a real map landed (a failed
  // copy is one flat colour), and the corner shows the burned-in attribution pill.
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const colors = new Set<number>();
    for (let y = 0; y < img.height; y += 97) {
      for (let x = 0; x < img.width; x += 97) {
        const i = (y * img.width + x) * 4;
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    }
    // Inside the attribution pill: 36px margin, 52px tall, hugging the right edge.
    const p = ((img.height - 62) * img.width + (img.width - 60)) * 4;
    return { colors: colors.size, pill: [data[p], data[p + 1], data[p + 2]] };
  }, readFileSync(a4).toString('base64'));
  await check(stats.colors > 50, 'the export shows the map, not a blank', `${stats.colors} colours`);
  await check(
    stats.pill.every((v) => v > 150),
    'the attribution pill is burned into the corner',
    stats.pill.join(','),
  );

  await page.click('#shot-rotate');
  await check(Math.abs((await aspect()) - 210 / 297) < 0.01, 'rotate flips to portrait');

  await page.selectOption('#shot-format', 'letter');
  await check(
    Math.abs((await aspect()) - 215.9 / 279.4) < 0.01,
    'the format dropdown reshapes the rectangle',
  );
  const letterDownload = page.waitForEvent('download');
  await page.click('#shot-capture');
  const letter = test.info().outputPath('letter.png');
  await (await letterDownload).saveAs(letter);
  const [lw, lh] = pngSize(letter);
  await check(lw === 2550 && lh === 3300, 'Letter portrait exports at 300 dpi', `${lw}×${lh}`);

  await page.keyboard.press('Escape');
  await check(await page.isHidden('#shot-frame'), 'Escape leaves framing mode');
  await check((await visibility('#tray')) === 'visible', 'the tray returns');
  const peakAfter = await peak();
  const drift = Math.hypot(peakAfter[0] - peakBefore[0], peakAfter[1] - peakBefore[1]);
  await check(drift < 5, 'the captures hand the view back', `${drift.toFixed(1)}px drift`);
  await page.close();
});

test('the camera pill survives the fold', async ({ browser }) => {
  const page = await open(browser, { hash: '#collapsed=1' });
  await check(await page.isVisible('#shot-open'), 'pill shows above the settings tile');
  await page.close();
});
