// What a wander at high zoom and pitch leaves on the GPU, step by step.
//
// The failure this is for is the GPU process running out of memory over minutes of
// moving around — one view loads fine, the tenth kills the context. So the probe
// loads a view, jumps through a fixed loop of nearby cameras, settles each, and reads
// the page's own count of GPU bytes (src/glAccounting.ts, on under #debugPerf=1)
// beside the tile caches' slots and fill. Growth that returns to baseline when the
// loop returns to its start is budget; growth that does not is a leak.
//
// CACHE_LEVELS=n overrides maxTileCacheZoomLevels on every source after load, so two
// runs of the same loop compare the setting. GL=metal is the renderer this is about.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer } from './browser.mjs';

const PORT = Number(process.env.PORT || 5199);
const URL_ = process.env.URL || `http://localhost:${PORT}/`;
const CACHE_LEVELS = process.env.CACHE_LEVELS ? Number(process.env.CACHE_LEVELS) : null;
const LAPS = Number(process.env.LAPS || 2);
const STEPS = Number(process.env.STEPS || 7);
// LOD_LEVELS / LOD_RATIO re-run setSourceTileLodParams on the DEM source after load.
const LOD_LEVELS = process.env.LOD_LEVELS ? Number(process.env.LOD_LEVELS) : null;
const LOD_RATIO = Number(process.env.LOD_RATIO || 100);
// SHOTS=prefix writes a screenshot per step into shots/, for judging what the numbers cost.
const SHOTS = process.env.SHOTS || null;

// Up the Zermatt valley at z20, pitch 80, hillshade on — the view that died.
const START = { lng: 7.7242727, lat: 46.0176035, zoom: 19.07, bearing: 67.1, pitch: 80 };
const HASH = `#map=${START.zoom}/${START.lat}/${START.lng}/${START.bearing}/${START.pitch}&hillshade=1&debugPerf=1`;
// A loop of ~250 m steps along the valley and back, turning as it goes.
const LOOP = [
  { dlng: 0.002, dlat: 0.0005, bearing: 67 },
  { dlng: 0.004, dlat: 0.001, bearing: 90 },
  { dlng: 0.006, dlat: 0.0005, bearing: 120 },
  { dlng: 0.006, dlat: -0.001, bearing: 180 },
  { dlng: 0.004, dlat: -0.002, bearing: 240 },
  { dlng: 0.002, dlat: -0.001, bearing: 300 },
  { dlng: 0, dlat: 0, bearing: 67 },
];

const up = async () => {
  try {
    return (await fetch(URL_, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};
let server = null;
if (!(await up())) {
  server = spawn('pnpm', ['dev', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!(await up())) {
    if (Date.now() - t0 > 15000) throw new Error(`no dev server came up at ${URL_}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const gl = glLaunchOptions();
const resident = residentServer(gl.mode);
const browser = resident
  ? await chromium.connect(resident.wsEndpoint)
  : await chromium.launch({ channel: gl.channel, args: gl.args });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('crash', () => {
  console.log('  page crashed');
  process.exit(1);
});

await page.goto(URL_ + HASH, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.map?.loaded?.(), null, { timeout: 90000 });
if (LOD_LEVELS !== null) {
  // Braces: a bare `map.method()` returns the Map, and Playwright would serialise all of it.
  await page.evaluate(([levels, ratio]) => {
    window.map.setSourceTileLodParams(levels, ratio, 'mapterhorn-dem');
  }, [LOD_LEVELS, LOD_RATIO]);
}
if (CACHE_LEVELS !== null) {
  await page.evaluate((n) => {
    window.map._maxTileCacheZoomLevels = n;
    for (const tm of Object.values(window.map.style.tileManagers)) tm._maxTileCacheZoomLevels = n;
  }, CACHE_LEVELS);
}

const settle = async () => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  try {
    await page.waitForFunction(() => window.map.areTilesLoaded() && window.map.loaded(), null, { timeout: 60000 });
  } catch {
    // Which source is holding out, and whether the context is even alive.
    const why = await page.evaluate(() => {
      const map = window.map;
      const pending = {};
      for (const [id, tm] of Object.entries(map.style.tileManagers)) {
        const states = {};
        for (const tid of tm._inViewTiles.getAllIds()) {
          const st = tm._inViewTiles.getTileById(tid).state;
          states[st] = (states[st] ?? 0) + 1;
        }
        if (Object.keys(states).some((k) => k !== 'loaded' && k !== 'errored')) pending[id] = states;
      }
      return { lost: map.painter.context.gl.isContextLost(), pending };
    });
    console.log(`  settle timed out: ${JSON.stringify(why)}`);
  }
  await page.waitForTimeout(300);
};

/** Peak GPU bytes over a stretch of continuous motion — no frame at rest, so the RTT pool never clears. */
const wander = async (ms) => {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const map = window.map;
        const t0 = performance.now();
        let peak = 0;
        let peakTex = 0;
        const c0 = map.getCenter();
        const step = () => {
          const t = (performance.now() - t0) / 1000;
          if (t * 1000 > ms) return resolve({ peakMiB: Math.round(peak / 2 ** 20), peakTex });
          map.jumpTo({
            center: [c0.lng + 0.004 * Math.sin(t / 3), c0.lat + 0.002 * Math.cos(t / 5)],
            bearing: (map.getBearing() + 1.5) % 360,
          });
          const u = window.glUsageAll();
          peak = Math.max(peak, u.textureBytes + u.bufferBytes);
          peakTex = Math.max(peakTex, u.textures);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
};

const sample = () =>
  page.evaluate(() => {
    const map = window.map;
    const gpu = window.glUsageAll();
    const caches = Object.entries(map.style.tileManagers).map(([id, tm]) => ({
      id,
      inView: tm._inViewTiles.getAllIds().length,
      cached: tm._outOfViewCache.order.length,
      slots: tm._outOfViewCache.max,
    }));
    return {
      mib: Math.round((gpu.textureBytes + gpu.bufferBytes) / 2 ** 20),
      textures: gpu.textures,
      pool: map.painter._rttObjectRecyclePool.length,
      lost: map.painter.context.gl.isContextLost(),
      rtt: map.terrain?.tileManager._renderableTilesKeys.length ?? 0,
      heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6),
      caches,
    };
  });

const shoot = async (label) => {
  if (SHOTS) await page.screenshot({ path: `shots/${SHOTS}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`, timeout: 180000 });
};

const row = (label, s) => {
  const dem = s.caches.find((c) => c.id === 'mapterhorn-dem');
  const others = s.caches.filter((c) => c.id !== 'mapterhorn-dem');
  const cached = others.reduce((n, c) => n + c.cached, 0);
  const inView = others.reduce((n, c) => n + c.inView, 0);
  console.log(
    `${label.padEnd(12)} ${String(s.mib).padStart(5)} MiB ${String(s.textures).padStart(5)} tex pool ${String(s.pool).padStart(3)} ` +
      (s.lost ? 'CONTEXT LOST ' : '') +
      `rtt ${String(s.rtt).padStart(4)}  dem ${String(dem?.inView ?? 0).padStart(4)} view ${String(dem?.cached ?? 0).padStart(4)}/${String(dem?.slots ?? 0).padEnd(4)} cached ` +
      `others ${String(inView).padStart(4)} view ${String(cached).padStart(4)} cached  heap ${s.heap} MB`,
  );
};

console.log(
  `${gl.mode} · ${LAPS} laps · maxTileCacheZoomLevels ${CACHE_LEVELS ?? 'default (5)'} · lod ${LOD_LEVELS ?? 'app default'}/${LOD_RATIO}`,
);
await settle();
row('start', await sample());
await shoot('start');
for (let lap = 1; lap <= LAPS; lap++) {
  for (const [i, step] of LOOP.slice(0, STEPS).entries()) {
    await page.evaluate(
      ([lng, lat, zoom, bearing, pitch]) => {
        window.map.jumpTo({ center: [lng, lat], zoom, bearing, pitch });
      },
      [START.lng + step.dlng, START.lat + step.dlat, 20, step.bearing, START.pitch],
    );
    await settle();
    row(`lap ${lap} · ${i + 1}`, await sample());
    await shoot(`lap${lap}-${i + 1}`);
  }
}
const WANDER_MS = Number(process.env.WANDER_MS || 20000);
if (WANDER_MS > 0) {
  const w = await wander(WANDER_MS);
  console.log(`continuous motion ${WANDER_MS / 1000}s: peak ${w.peakMiB} MiB in ${w.peakTex} textures`);
  await settle();
  row('after', await sample());
}
// Back at the start: whatever is still held above the first row is what wandering costs.
await page.evaluate(
  ([lng, lat, zoom, bearing, pitch]) => {
    window.map.jumpTo({ center: [lng, lat], zoom, bearing, pitch });
  },
  [START.lng, START.lat, START.zoom, START.bearing, START.pitch],
);
await settle();
row('back', await sample());

await browser.close();
server?.kill();
