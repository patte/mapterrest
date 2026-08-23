import type { MapLibreMap } from 'maplibre-gl';
import type { CameraAnchor } from './cameraAnchor';
import mapterhornLogo from './assets/mapterhorn.svg?raw';
import maptilerLogo from './assets/maptiler.svg?raw';

/** Long edge first; orientation decides which edge is horizontal. */
const PAPERS = {
  a2: { label: 'A2', mm: [594, 420] },
  a3: { label: 'A3', mm: [420, 297] },
  a4: { label: 'A4', mm: [297, 210] },
  a5: { label: 'A5', mm: [210, 148] },
  a6: { label: 'A6', mm: [148, 105] },
  letter: { label: 'Letter', mm: [279.4, 215.9] },
  legal: { label: 'Legal', mm: [355.6, 215.9] },
  tabloid: { label: 'Tabloid', mm: [431.8, 279.4] },
} as const;
type PaperKey = keyof typeof PAPERS;

/** Print density the export targets; the GPU's canvas limit may cap it on the way. */
const DPI = 300;
const px = (mm: number): number => Math.round((mm / 25.4) * DPI);

/**
 * How far the capture grows the real viewport, at most — two zoom levels deeper than
 * the screen. Tile selection follows CSS size, so this is the lever that makes tiles
 * actually load at print resolution; past the cap, tile count and memory grow
 * quadratically for detail a print no longer shows, and the pixel-ratio remainder
 * merely densifies what the deeper tiles already carry. Lifting the cap was tried
 * and does not survive contact with the engine: an uncapped A2 (grow ~6) renders
 * blank or throws inside MapLibre and can wedge the session — 4 is the measured
 * ceiling on a strong GPU, not a taste choice.
 */
const MAX_VIEWPORT_SCALE = 4;

/**
 * The camera pill and the framing mode behind it: a screen-fixed paper-aspect
 * rectangle the map stays live under, and a capture that re-renders the same frame at
 * print density and crops the rectangle out of it. The export carries only the map,
 * the attribution line, and whichever provider logos the frame currently owes.
 */
export function setupScreenshot(map: MapLibreMap, anchor: CameraAnchor | null): void {
  const frame = document.getElementById('shot-frame') as HTMLElement;
  const rect = document.getElementById('shot-rect') as HTMLElement;
  const veil = document.getElementById('shot-veil') as HTMLElement;
  const format = document.getElementById('shot-format') as HTMLSelectElement;
  const openButton = document.getElementById('shot-open') as HTMLButtonElement;
  const rotateButton = document.getElementById('shot-rotate') as HTMLButtonElement;
  const captureButton = document.getElementById('shot-capture') as HTMLButtonElement;
  const closeButton = document.getElementById('shot-close') as HTMLButtonElement;

  for (const key of Object.keys(PAPERS) as PaperKey[]) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = PAPERS[key].label;
    format.appendChild(option);
  }
  format.value = 'a4' satisfies PaperKey;

  let landscape = true;

  /** Target pixel size of the export, oriented. */
  function paperPx(): [number, number] {
    const [long, short] = PAPERS[format.value as PaperKey].mm;
    return landscape ? [px(long), px(short)] : [px(short), px(long)];
  }

  function applyAspect(): void {
    const [w, h] = paperPx();
    frame.style.setProperty('--shot-aspect', String(w / h));
  }
  applyAspect();
  format.addEventListener('change', applyAspect);
  rotateButton.addEventListener('click', () => {
    landscape = !landscape;
    applyAspect();
  });

  function setOpen(open: boolean): void {
    frame.hidden = !open;
    document.body.classList.toggle('shot', open);
  }
  openButton.addEventListener('click', () => setOpen(true));
  closeButton.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !frame.hidden) setOpen(false);
  });

  captureButton.addEventListener('click', (e) => {
    captureButton.disabled = true;
    veil.hidden = false;
    const note = veil.querySelector('p')!;
    // Shift is the hidden clean shot: no attribution, no logos, just the map.
    capture(map, anchor, rect, paperPx(), !e.shiftKey)
      .catch(() => {
        // Past the renderer's limits MapLibre itself gives out; the finally above
        // already put the map back — tell the user which lever helps.
        note.textContent = 'capture failed — try a smaller format';
        return new Promise((r) => setTimeout(r, 3000));
      })
      .finally(() => {
        veil.hidden = true;
        note.textContent = 'rendering the print…';
        captureButton.disabled = false;
      });
  });
}

async function capture(
  map: MapLibreMap,
  anchor: CameraAnchor | null,
  rect: HTMLElement,
  [tw, th]: [number, number],
  credits: boolean,
): Promise<void> {
  const container = map.getContainer();
  const view = rect.getBoundingClientRect();
  const base = container.getBoundingClientRect();
  const ratio = tw / view.width;
  // Growing the container k× while adding log2(k) zoom reproduces the exact same view
  // (~1px over the frame, probed) with tiles selected for the print's true size; the
  // remainder of the ratio is pixel density on top. The final canvas is the same size
  // either way — the split only decides how much of it is real tile detail.
  const grow = Math.min(ratio, MAX_VIEWPORT_SCALE);
  const cssWidth = container.clientWidth;
  const cssHeight = container.clientHeight;

  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const ctx = out.getContext('2d')!;

  // The anchor re-settles the camera on programmatic zoom and would drag the framing
  // hundreds of pixels off; it is built to sit out a gesture, and this is one.
  anchor?.suspend();
  // The full representation, elevation included: the clamp rewrites elevation and what
  // the numbers mean, so handing the view back takes a jump to all of them at once.
  const saved = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    elevation: (map as unknown as { _camera: { transform: { elevation: number } } })._camera
      .transform.elevation,
  };
  // The pivot stack drives the camera unclamped (centre elevation 0); rendered from
  // that representation, the grown deep-zoom frame comes out with drapeless smears —
  // the clamped representation of the same view survives it, and MapLibre preserves
  // the apparent view when the clamp toggles. The anchor re-settles on resume.
  if (anchor) map.setCenterClampedToGround(true);
  document.body.classList.add('capturing');
  try {
    container.style.width = `${cssWidth * grow}px`;
    container.style.height = `${cssHeight * grow}px`;
    map.setPixelRatio(ratio / grow);
    map.setZoom(saved.zoom + Math.log2(grow));
    await tilesSettled(map);
    // Redraw synchronously and copy in the same task — the WebGL buffer is only valid
    // until the browser composites, so there is no preserveDrawingBuffer to pay for.
    map.redraw();
    const gl = map.getCanvas();
    // MapLibre clamps the ratio to the GPU's canvas limit; the canvas knows what stuck.
    const scale = gl.width / container.clientWidth;
    ctx.drawImage(
      gl,
      (view.left - base.left) * grow * scale,
      (view.top - base.top) * grow * scale,
      view.width * grow * scale,
      view.height * grow * scale,
      0,
      0,
      tw,
      th,
    );
  } finally {
    container.style.width = '';
    container.style.height = '';
    // Undefined hands the ratio back to devicePixelRatio tracking; the signature only
    // admits numbers but the implementation is `?? devicePixelRatio`.
    map.setPixelRatio(undefined as unknown as number);
    if (anchor) map.setCenterClampedToGround(false);
    map.jumpTo(saved);
    document.body.classList.remove('capturing');
    anchor?.resume();
  }

  if (credits) await drawCredits(ctx, tw, th);

  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) return;
  const png = withDpi(new Uint8Array(await blob.arrayBuffer()), DPI);
  const stamp = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const name =
    `mapterrest-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
    `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/**
 * Stamps the PNG's pHYs chunk with `dpi`: toBlob writes no physical size, viewers
 * then assume 72 dpi, and a print dialog sizes an A4 export as a metre-wide poster.
 * The chunk goes right behind IHDR, which the signature pins to the first 33 bytes.
 */
function withDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  const perMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, perMetre);
  view.setUint32(12, perMetre);
  chunk[16] = 1; // unit: the metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, 33));
  out.set(chunk, 33);
  out.set(png.subarray(33), 33 + chunk.length);
  return out;
}

/** CRC-32 as PNG chunks want it. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The tests' `settled()` from inside the page: two frames so the grown view's tile
 * requests exist — areTilesLoaded is vacuously true before then — then every tile,
 * then a short grace. The cap turns an offline or stalled source into a capture of
 * what arrived instead of a veil that never lifts.
 */
function tilesSettled(map: MapLibreMap): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    let frames = 0;
    const check = (): void => {
      frames += 1;
      let done: boolean;
      try {
        done = frames > 2 && map.areTilesLoaded() && map.loaded();
      } catch {
        // A map in trouble must not hang the veil: stop waiting and let the capture
        // run into the error properly.
        done = true;
      }
      if (done || performance.now() - start > 120000) setTimeout(resolve, 300);
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/**
 * The image's corner credit: the attribution line on its pill, and above it the
 * provider logos the print still owes — read from the live DOM, so the image follows
 * what the frame currently shows.
 */
async function drawCredits(ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
  const margin = 36;
  let y = h - margin;

  const line = document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent?.trim();
  // A print travels without its URL bar; the last entry says where it was made.
  const text = [line, 'mapterrest.com'].filter(Boolean).join(' | ');
  // ≈6.7pt on paper — legible in print, quiet on the page.
  ctx.font = '500 28px ui-sans-serif, system-ui, -apple-system, sans-serif';
  const textWidth = ctx.measureText(text).width;
  const padX = 18;
  const pillHeight = 52;
  const x = w - margin - textWidth - 2 * padX;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.roundRect(x, y - pillHeight, textWidth + 2 * padX, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.fillStyle = '#333';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y - pillHeight / 2);
  y -= pillHeight + 16;

  const shown = (cls: string): boolean => {
    const box = document.getElementById('logos');
    const a = document.querySelector<HTMLElement>(`#logos .${cls}`);
    return !!box && !box.hidden && !!a && !a.hidden;
  };
  // Mapterhorn only asks for the © text (their TileJSON attribution), so on paper the
  // wordmark stays off unless another provider's mark is due anyway — then the stack
  // keeps its screen shape. MapTiler's free tier does want the mark on the map.
  const maptiler = shown('maptiler');
  // Same stack as on screen: Mapterhorn holds the bottom spot, MapTiler above.
  if (maptiler && shown('mapterhorn')) {
    const img = await svgImage(mapterhornLogo, 38);
    // The wordmark rasterises black; the halo lifts it off dark ground, as on screen.
    ctx.shadowColor = 'rgba(255, 255, 255, 0.65)';
    ctx.shadowBlur = 8;
    ctx.drawImage(img, w - margin - img.width, y - img.height);
    ctx.shadowColor = 'transparent';
    y -= img.height + 10;
  }
  if (maptiler) {
    const img = await svgImage(maptilerLogo, 54);
    ctx.drawImage(img, w - margin - img.width, y - img.height);
  }
}

/** Rasterises an SVG at `height` device pixels — sized on the root, since an <img> draws at its declared size. */
async function svgImage(svg: string, height: number): Promise<HTMLImageElement> {
  const end = svg.indexOf('>');
  const root = svg.slice(0, end).replace(/\s(?:width|height)="[^"]*"/g, '');
  const viewBox = /viewBox="([^"]+)"/.exec(root)![1].trim().split(/[\s,]+/).map(Number);
  const width = Math.round((height * viewBox[2]) / viewBox[3]);
  const sized = root.replace('<svg', `<svg width="${width}" height="${height}"`) + svg.slice(end);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return img;
}
