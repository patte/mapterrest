import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Browser, type Page, type Route } from '@playwright/test';

// Tiles, styles, glyphs — everything the app pulls from the providers' CDNs — served from
// a disk cache shared across contexts, workers, and runs: isolation-by-fresh-context
// means the browser's own cache never survives a case, and re-downloading the same DEM
// every run is traffic the providers shouldn't have to carry. TILECACHE=0 bypasses it;
// `rm -rf .tile-cache` empties it — there is no invalidation.
const CACHE_DIR = fileURLToPath(new URL('../.tile-cache', import.meta.url));
const useTileCache = process.env.TILECACHE !== '0';
if (useTileCache) mkdirSync(CACHE_DIR, { recursive: true });

// route.fetch() hands back the decoded body, so the replayed headers must not re-declare
// an encoding or the original length.
const STRIP = ['content-encoding', 'content-length', 'transfer-encoding'];

async function fromCache(route: Route) {
  try {
    if (route.request().method() !== 'GET') return await route.continue();
    const key = createHash('sha256').update(route.request().url()).digest('hex');
    const bodyFile = join(CACHE_DIR, key);
    const metaFile = `${bodyFile}.json`;
    try {
      const stored = JSON.parse(readFileSync(metaFile, 'utf8'));
      return await route.fulfill({ ...stored, body: readFileSync(bodyFile) });
    } catch {
      // miss — go to the network
    }
    const res = await route.fetch();
    if (res.status() === 200) {
      const headers = { ...res.headers() };
      for (const h of STRIP) delete headers[h];
      // Body lands before meta, each atomically, so a reader that sees the meta file
      // always finds the body; losing a write race between workers is just a refetch.
      const tmp = `${bodyFile}.${process.pid}.tmp`;
      writeFileSync(tmp, await res.body());
      renameSync(tmp, bodyFile);
      writeFileSync(tmp, JSON.stringify({ status: 200, headers }));
      renameSync(tmp, metaFile);
    }
    return await route.fulfill({ response: res });
  } catch {
    // The page closed under an in-flight request; nobody is waiting for this response.
    await route.abort().catch(() => {});
  }
}

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
  const base = test.info().project.use.baseURL ?? 'http://localhost:5199/';
  // Everything not from the dev server is a provider asset.
  if (useTileCache) {
    const origin = new URL(base).origin;
    await page.route((u) => u.origin !== origin, fromCache);
  }
  const hash =
    rawHash?.includes('detail=') || appDefaultDetail
      ? (rawHash ?? '')
      : rawHash
        ? `${rawHash}&detail=low`
        : '#detail=low';
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
