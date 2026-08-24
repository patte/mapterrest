import { test, expect, chromium } from '@playwright/test';
import { glLaunchOptions } from '../scripts/browser.mjs';

/* A browser without WebGL2 gets the gate, not a crash */

// The shared fixture (and the resident server) run with the suite's launch args, so a
// WebGL2-less browser has to be launched here: same GL mode, one flag on top.
test('the gate shows and setup stops when no WebGL2 context comes up', async ({ baseURL }) => {
  const gl = glLaunchOptions();
  const browser = await chromium.launch({
    channel: gl.channel,
    args: [...gl.args, '--disable-webgl2'],
    timeout: 60_000,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(baseURL!);

    await expect(page.locator('#webgl-gate')).toBeVisible();
    // Exactly the deliberate stop — none of the TypeErrors a half-built map used to throw.
    expect(errors).toEqual(['WebGL2 unavailable: the browser did not provide a context']);
  } finally {
    await browser.close();
  }
});
