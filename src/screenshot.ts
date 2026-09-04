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
/** The whole map at its device pixels, or a paper size at print density. */
type FormatKey = 'screen' | PaperKey;

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
 * The camera pill and the framing mode behind it: a screen-fixed rectangle the map
 * stays live under — the whole map, or a paper aspect — and a capture that re-renders
 * the same frame at the export's density and crops the rectangle out of it. The export
 * carries only the map, the attribution line, and whichever provider logos the frame
 * currently owes.
 */
export function setupScreenshot(map: MapLibreMap, anchor: CameraAnchor | null): void {
  const frame = document.getElementById('shot-frame') as HTMLElement;
  const rect = document.getElementById('shot-rect') as HTMLElement;
  const veil = document.getElementById('shot-veil') as HTMLElement;
  const format = document.getElementById('shot-format') as HTMLSelectElement;
  const openButton = document.getElementById('shot-open') as HTMLButtonElement;
  const rotateButton = document.getElementById('shot-rotate') as HTMLButtonElement;
  const detailButton = document.getElementById('shot-detail') as HTMLButtonElement;
  const captureButton = document.getElementById('shot-capture') as HTMLButtonElement;
  const closeButton = document.getElementById('shot-close') as HTMLButtonElement;

  const addOption = (value: FormatKey, label: string): void => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    format.appendChild(option);
  };
  addOption('screen', 'screen');
  for (const key of Object.keys(PAPERS) as PaperKey[]) addOption(key, PAPERS[key].label);
  format.value = 'screen' satisfies FormatKey;

  let landscape = true;
  const isScreen = (): boolean => format.value === 'screen';

  /** Target pixel size of the export: the canvas as is, or the paper, oriented. */
  function targetPx(): [number, number] {
    if (isScreen()) {
      const gl = map.getCanvas();
      return [gl.width, gl.height];
    }
    const [long, short] = PAPERS[format.value as PaperKey].mm;
    return landscape ? [px(long), px(short)] : [px(short), px(long)];
  }

  // A select is as wide as its widest option, which leaves "A4" swimming in the room
  // "Tabloid" needs; the pill fits the chosen label instead, measured in its own font.
  const measure = document.createElement('canvas').getContext('2d')!;
  function fitFormat(): void {
    const style = getComputedStyle(format);
    measure.font = style.font;
    const label = format.selectedOptions[0]?.textContent ?? '';
    // A select's box is border-box by default: the padding lives inside the width.
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    format.style.width = `${Math.ceil(measure.measureText(label).width + padding)}px`;
  }

  function applyFormat(): void {
    fitFormat();
    const screen = isScreen();
    document.body.classList.toggle('shot-screen', screen);
    // Orientation and ultra quality are paper affairs: the screen has one orientation,
    // and it already shows the tiles a screen capture gets.
    rotateButton.hidden = screen;
    detailButton.disabled = screen;
    if (screen) return;
    const [w, h] = targetPx();
    frame.style.setProperty('--shot-aspect', String(w / h));
  }
  applyFormat();
  format.addEventListener('change', applyFormat);
  rotateButton.addEventListener('click', () => {
    landscape = !landscape;
    applyFormat();
  });
  detailButton.addEventListener('click', () => {
    detailButton.setAttribute(
      'aria-pressed',
      detailButton.getAttribute('aria-pressed') === 'true' ? 'false' : 'true',
    );
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
    capture(map, anchor, rect, {
      size: targetPx(),
      dpi: isScreen() ? null : DPI,
      detail: !isScreen() && detailButton.getAttribute('aria-pressed') === 'true',
      credits: !e.shiftKey,
    })
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

type Export = {
  /** Pixel size of the image. */
  size: [number, number];
  /** Density the file declares; null for a screen capture, which has no paper size. */
  dpi: number | null;
  /**
   * Load tiles for the export's true size instead of densifying the screen's: deeper
   * tiles, so finer contour rungs and sharper relief than the screen shows.
   */
  detail: boolean;
  credits: boolean;
};

async function capture(
  map: MapLibreMap,
  anchor: CameraAnchor | null,
  rect: HTMLElement,
  { size: [tw, th], dpi, detail, credits }: Export,
): Promise<void> {
  const container = map.getContainer();
  const view = rect.getBoundingClientRect();
  const base = container.getBoundingClientRect();
  const ratio = tw / view.width;
  // Growing the container k× while adding log2(k) zoom reproduces the exact same view
  // (~1px over the frame, probed) with tiles selected for the print's true size; the
  // remainder of the ratio is pixel density on top. The final canvas is the same size
  // either way — the split only decides how much of it is real tile detail. Without
  // detail the whole ratio is density: the screen's own tiles, rendered denser.
  const grow = detail ? Math.min(ratio, MAX_VIEWPORT_SCALE) : 1;
  const grown = grow > 1;
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
  if (anchor && grown) map.setCenterClampedToGround(true);
  document.body.classList.add('capturing');
  try {
    if (grown) {
      container.style.width = `${cssWidth * grow}px`;
      container.style.height = `${cssHeight * grow}px`;
      map.setZoom(saved.zoom + Math.log2(grow));
    }
    map.setPixelRatio(ratio / grow);
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
    if (grown) {
      if (anchor) map.setCenterClampedToGround(false);
      map.jumpTo(saved);
    }
    document.body.classList.remove('capturing');
    anchor?.resume();
  }

  if (credits) await drawCredits(ctx, tw, th);

  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) return;
  const png = withMetadata(new Uint8Array(await blob.arrayBuffer()), saved.center, dpi);
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
 * The export's metadata, spliced in right behind IHDR (which the signature pins to
 * the first 33 bytes) — toBlob writes none of it:
 *
 * - pHYs declares the print density; without it viewers assume 72 dpi and a print
 *   dialog sizes an A4 export as a metre-wide poster. A screen capture has no paper
 *   size and declares nothing.
 * - Comment holds the view's permalink — the hash carries camera and layers, so any
 *   export leads back to the exact view that produced it.
 * - Copyright carries the credits even when the clean shot leaves them off the pixels.
 * - eXIf pins the view's centre as a GPS position for photo libraries.
 */
function withMetadata(
  png: Uint8Array,
  center: { lat: number; lng: number },
  dpi: number | null,
): Uint8Array<ArrayBuffer> {
  const chunks = [
    ...(dpi === null ? [] : [pHYs(dpi)]),
    textChunk('Software', 'Mapterrest (mapterrest.com)'),
    textChunk('Creation Time', new Date().toUTCString()),
    textChunk('Copyright', creditsLine()),
    textChunk('Comment', location.href),
    pngChunk('eXIf', exifGps(center.lat, center.lng)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + total);
  out.set(png.subarray(0, 33));
  let at = 33;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  out.set(png.subarray(33), at);
  return out;
}

/** One PNG chunk: length, type, data, CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * ASCII rides in tEXt; anything richer in iTXt, which is UTF-8 by definition — tEXt
 * is Latin-1, and viewers that assume UTF-8 turn its bare © into a '?'.
 */
function textChunk(keyword: string, text: string): Uint8Array<ArrayBuffer> {
  if ([...text].every((c) => c.charCodeAt(0) <= 127)) {
    return pngChunk('tEXt', Uint8Array.from(`${keyword}\0${text}`, (c) => c.charCodeAt(0)));
  }
  // keyword, separator, then: uncompressed flag, method 0, empty language tag and
  // empty translated keyword with their terminators — five zero bytes in a row.
  const head = Uint8Array.from(`${keyword}\0\0\0\0\0`, (c) => c.charCodeAt(0));
  const utf8 = new TextEncoder().encode(text);
  const data = new Uint8Array(head.length + utf8.length);
  data.set(head);
  data.set(utf8, head.length);
  return pngChunk('iTXt', data);
}

function pHYs(dpi: number): Uint8Array<ArrayBuffer> {
  const perMetre = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const view = new DataView(data.buffer);
  view.setUint32(0, perMetre);
  view.setUint32(4, perMetre);
  data[8] = 1; // unit: the metre
  return pngChunk('pHYs', data);
}

/**
 * A minimal EXIF block — little-endian TIFF, one IFD0 entry pointing at a GPS IFD
 * with the position in degree/minute/second rationals. The PNG eXIf chunk carries
 * the TIFF structure bare, without JPEG's "Exif\0\0" prefix.
 */
function exifGps(lat: number, lng: number): Uint8Array {
  // MapLibre hands back a longitude that may have wrapped past the antimeridian.
  const lon = ((lng + 540) % 360) - 180;
  const data = new Uint8Array(140);
  const view = new DataView(data.buffer);
  data[0] = 0x49; // "II": little-endian
  data[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // IFD0 at 8
  view.setUint16(8, 1, true); // one entry: the GPS IFD pointer
  view.setUint16(10, 0x8825, true);
  view.setUint16(12, 4, true); // LONG
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true); // GPS IFD at 26
  view.setUint32(22, 0, true); // no next IFD

  view.setUint16(26, 5, true); // five entries, in tag order
  const entry = (i: number, tag: number, type: number, count: number): number => {
    const at = 28 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    return at + 8; // where the inline value or offset goes
  };
  data[entry(0, 0x0000, 1, 4)] = 2; // GPSVersionID 2.3.0.0
  data[entry(0, 0x0000, 1, 4) + 1] = 3;
  data[entry(1, 0x0001, 2, 2)] = (lat >= 0 ? 'N' : 'S').charCodeAt(0);
  view.setUint32(entry(2, 0x0002, 5, 3), 92, true); // latitude rationals at 92
  data[entry(3, 0x0003, 2, 2)] = (lon >= 0 ? 'E' : 'W').charCodeAt(0);
  view.setUint32(entry(4, 0x0004, 5, 3), 116, true); // longitude rationals at 116
  view.setUint32(88, 0, true); // no next IFD

  const dms = (at: number, deg: number): void => {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = Math.round(((deg - d) * 60 - m) * 60 * 10000);
    for (const [i, [num, den]] of [
      [d, 1],
      [m, 1],
      [s, 10000],
    ].entries()) {
      view.setUint32(at + i * 8, num, true);
      view.setUint32(at + i * 8 + 4, den, true);
    }
  };
  dms(92, Math.abs(lat));
  dms(116, Math.abs(lon));
  return data;
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

/** The attribution as one line — the pill's text, and the file's Copyright field. */
function creditsLine(): string {
  const line = document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent?.trim();
  // A print travels without its URL bar; the last entry says where it was made.
  return [line, 'mapterrest.com'].filter(Boolean).join(' | ');
}

/**
 * The image's corner credit: the attribution line on its pill, and above it the
 * provider logos the print still owes — read from the live DOM, so the image follows
 * what the frame currently shows.
 */
async function drawCredits(ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
  const margin = 36;
  let y = h - margin;

  const text = creditsLine();
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
  // keeps its screen shape. MapTiler's free tier does want the mark on the map — but
  // only where the image shows their style: a mark up only for geosearch (searchOnly)
  // credits nothing in the export.
  const maptiler =
    shown('maptiler') &&
    document.querySelector<HTMLElement>('#logos .maptiler')?.dataset.searchOnly !== 'true';
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
