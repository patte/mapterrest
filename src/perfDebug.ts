import { type MapLibreMap } from 'maplibre-gl';
import { DEM_SOURCE } from './terrain';

/**
 * `#debugPerf=1`: what the frame in front of you is costing, updated once a second.
 *
 * Everything here is a real-GPU question. SwiftShader rasterises on the CPU and renders
 * every camera at roughly a second a frame, so a headless probe cannot tell a cheap frame
 * from an expensive one — the counts have to be read in the browser that has the problem.
 * Draw calls and readPixels are counted off the GL context rather than timed, so they mean
 * the same thing on any machine.
 */

/**
 * MapLibre identifies a terrain tile by one byte of alpha in the coords framebuffer, so
 * past this many rendered tiles the index wraps and `terrain.pointCoordinate` decodes a
 * real coordinate belonging to the wrong tile. Drag-pan reads exactly that to keep the
 * grabbed point under the cursor.
 */
const COORDS_INDEX_LIMIT = 255;

const WINDOW_MS = 1000;

export function enablePerfDebug(map: MapLibreMap): () => void {
  const box = document.createElement('div');
  // Top left: the corner the tile tray does not own.
  box.style.cssText =
    'position:absolute;top:8px;left:8px;z-index:3;pointer-events:none;white-space:pre;' +
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 10px;' +
    'border-radius:6px;background:rgba(12,16,22,0.82);color:#e6edf3;' +
    'text-shadow:0 1px 2px rgba(0,0,0,0.6)';
  const readout = document.createElement('div');
  // The numbers are worth nothing if they cannot leave the screen, and a HUD that took
  // the pointer would eat the drags being measured — so only the button takes it.
  const copy = document.createElement('button');
  copy.textContent = 'copy';
  copy.style.cssText =
    'pointer-events:auto;margin-top:6px;font:inherit;color:inherit;cursor:pointer;' +
    'background:rgba(255,255,255,0.12);border:0;border-radius:4px;padding:2px 8px';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${window.location.href}\n${readout.textContent}`);
    copy.textContent = 'copied';
    setTimeout(() => (copy.textContent = 'copy'), 1200);
  });
  box.append(readout, copy);
  map.getCanvasContainer().appendChild(box);

  // Overloaded GL entry points, counted through a signature TypeScript will accept.
  const gl = map.painter.context.gl as unknown as Record<string, (...args: never[]) => unknown>;
  let draws = 0;
  let reads = 0;
  const drawElements = gl.drawElements.bind(gl);
  const readPixels = gl.readPixels.bind(gl);
  gl.drawElements = (...args: never[]) => {
    draws++;
    return drawElements(...args);
  };
  gl.readPixels = (...args: never[]) => {
    reads++;
    return readPixels(...args);
  };

  // Tiles fetched per second: a cover that fits the cache settles to zero, one that
  // does not keeps re-fetching what it just evicted for as long as the hand moves.
  let fetched = 0;
  const tiles = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name.includes('tiles.mapterhorn.com')) fetched++;
  });
  tiles.observe({ type: 'resource', buffered: false });

  let frames = 0;
  let worst = 0;
  let renders = 0;
  let last = performance.now();
  let since = last;
  let raf = 0;

  const onRender = (): void => {
    renders++;
  };
  map.on('render', onRender);

  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const gap = now - last;
    last = now;
    frames++;
    worst = Math.max(worst, gap);
    if (now - since < WINDOW_MS) return;

    const tr = map._camera.transform;
    const rtt = map.terrain?.tileManager._renderableTilesKeys.length ?? 0;
    const dem = map.style.tileManagers[DEM_SOURCE];
    // Which DEM levels the frame is made of. The spread is the LOD's answer to this
    // camera: the deepest level is what the middle of the frame is being drawn from.
    const levels = new Map<number, number>();
    for (const id of dem?._inViewTiles.getAllIds() ?? []) {
      const z = dem._inViewTiles.getTileById(id)?.tileID.canonical.z;
      if (z !== undefined) levels.set(z, (levels.get(z) ?? 0) + 1);
    }
    const ground = map.terrain?.getElevationForLngLatZoom(tr.getCameraLngLat(), tr.tileZoom);
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory;

    const elapsed = now - since;
    readout.textContent = [
      `z${tr.zoom.toFixed(2)} tileZoom ${tr.tileZoom} · pitch ${tr.pitch.toFixed(1)}`,
      // Zoom is the distance to the centre, and the centre rides the elevation plane, so
      // the gap between the camera and that plane is what the derived zoom is made of.
      `camera ${Math.round(tr.getCameraAltitude())} m · ground under it ${Math.round(
        ground ?? 0,
      )} m · plane ${Math.round(tr.elevation)} m`,
      `frame ${Math.round(elapsed / frames)} ms · worst ${Math.round(worst)} ms · ` +
        `${Math.round((renders / elapsed) * 1000)} renders/s`,
      // Per rendered frame, not per animation frame: an idle map renders nothing.
      `${(draws / Math.max(1, renders)).toFixed(0)} draws/render · ${(
        reads / Math.max(1, renders)
      ).toFixed(1)} readPixels/render`,
      `terrain ${rtt} rtt tiles${rtt > COORDS_INDEX_LIMIT ? '  ← OVER 255, picking is wrong' : ''}`,
      `dem ${dem?._inViewTiles.getAllIds().length ?? 0} in view · ${
        dem?._outOfViewCache.max ?? 0
      } cache slots · ${Math.round((fetched / elapsed) * 1000)} fetched/s`,
      `levels ${[...levels]
        .sort((a, b) => a[0] - b[0])
        .map(([z, n]) => `z${z}:${n}`)
        .join(' ')}`,
      heap ? `heap ${Math.round(heap.usedJSHeapSize / 1e6)} MB` : '',
    ]
      .filter(Boolean)
      .join('\n');

    frames = 0;
    worst = 0;
    renders = 0;
    draws = 0;
    reads = 0;
    fetched = 0;
    since = now;
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    tiles.disconnect();
    map.off('render', onRender);
    gl.drawElements = drawElements;
    gl.readPixels = readPixels;
    box.remove();
  };
}
