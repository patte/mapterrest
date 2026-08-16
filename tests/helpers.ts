import { test, expect, type Browser, type Page } from '@playwright/test';

type OpenOpts = Parameters<Browser['newPage']>[0] & {
  hash?: string;
  appDefaultDetail?: boolean;
};

/**
 * A fresh page per case, so hash state and colour scheme never leak between them, and
 * every case runs at `detail=low`: none of them are testing the tuned LOD, and a pitched
 * frame at full detail pulls hundreds of tiles through a software GL.
 */
export async function open(browser: Browser, opts: OpenOpts = {}): Promise<Page> {
  const { hash: rawHash, appDefaultDetail, ...pageOpts } = opts;
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ...pageOpts });
  const hash =
    rawHash?.includes('detail=') || appDefaultDetail
      ? (rawHash ?? '')
      : rawHash
        ? `${rawHash}&detail=low`
        : '#detail=low';
  const base = test.info().project.use.baseURL ?? 'http://localhost:5199/';
  await page.goto(base + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).map?.loaded?.(), null, { timeout: 90000 });
  return page;
}

/**
 * The old suite's `check(ok, label, detail)`, kept verbatim at every call site: a soft
 * expect so one failure never hides the rest, wrapped in a step so the label lands in the
 * JSON report — that's what scripts/coverage-diff.mjs tallies against the manifest.
 */
export async function check(ok: unknown, label: string, detail = ''): Promise<void> {
  await test.step(label, async () => {
    expect.soft(!!ok, detail ? `${label}  ${detail}` : label).toBeTruthy();
  });
}
