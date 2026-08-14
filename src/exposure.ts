import type { MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';

/** The endpoints of an elevation ramp, in metres. */
export type Range = { lo: number; hi: number };

/**
 * Pixels on a side of the finest cell in a tile's elevation pyramid, and so the resolution
 * the visible range is answered at.
 *
 * A cell is cut whole, so whatever it holds beyond the frame's edge is counted: the error
 * is the relief inside one cell, and a cell is only as small as its tile is deep. The
 * horizon is where that bites, since LOD hands it the coarsest tiles — the Netherlands at
 * pitch 78 answers 22 m over its true 275 m top here, against 107 m at 16 px and 290 m at
 * 64. Held under MIN_SPAN, so the slop stays narrower than the narrowest range the ramp
 * will stretch, which costs 171 KB a tile against 11 KB at 16 px and buys the exact answer
 * at every zoom that fills the frame with one tile level.
 */
const CELL = 4;

/**
 * The narrowest range worth stretching, in metres. Across still water the visible relief
 * is zero and the endpoints would divide by it; a floor also keeps a dead-flat view from
 * spreading the DEM's own quantisation over the whole ramp.
 */
const MIN_SPAN = 40;

/** Seconds for the exposure to close most of a gap. */
const EASE_TAU = 0.25;

/** Metres of remaining travel below which the ease has arrived. */
const SETTLED = 0.5;

/** MapLibre's frustum verdict for a bounding box. */
const NONE = 0;
const FULL = 2;

/**
 * The parts of MapLibre's culling primitives used here. They are what `coveringTiles`
 * decides tile visibility with, and none of them are named in the public types.
 */
type Frustum = object;
type Plane = object | null;
type Box = {
  /** Halves the box in x and y, keeping its full elevation span. */
  quadrant(index: number): Box;
  intersectsFrustum(frustum: Frustum): number;
  intersectsPlane(plane: object): number;
};
type Dem = { dim: number; stride: number; min: number; max: number } & {
  getPixels(): { data: Uint8Array };
  getUnpackVector(): number[];
};

/** Elevation extremes per cell, coarsest level first; level i is 2^i cells a side. */
type Pyramid = { min: Float32Array; max: Float32Array }[];

/** Keyed on the DEM, whose interior never changes once the tile has decoded. */
const pyramids = new WeakMap<object, Pyramid>();

/**
 * A tile's elevation extremes at every scale from the whole tile down to `CELL` pixels.
 *
 * This is the same thing sub-tiles would report, computed rather than fetched: matching
 * a 16 px cell of a z4 tile with real tiles means z9, which is 1024 of them. MapLibre
 * already walks every pixel of a tile to fill `dem.min`/`dem.max`, so a downloaded
 * sub-tile carries the cost of this pass anyway — once each, plus a request and a decode.
 */
function pyramidFor(dem: Dem): Pyramid {
  const cached = pyramids.get(dem);
  if (cached) return cached;

  const { dim, stride } = dem;
  let n = 1;
  while (n * CELL < dim) n *= 2;

  // The bytes and the unpack factors directly: dem.get() re-resolves the byte view and
  // bounds-checks per pixel, which over a quarter of a million of them is most of the work.
  const px = dem.getPixels().data;
  const [red, green, blue, base] = dem.getUnpackVector();
  const min = new Float32Array(n * n).fill(Infinity);
  const max = new Float32Array(n * n).fill(-Infinity);
  for (let y = 0; y < dim; y++) {
    const row = (((y * n) / dim) | 0) * n;
    // The DEM has a one pixel border on every side, so the interior starts at (1, 1).
    let i = ((y + 1) * stride + 1) * 4;
    for (let x = 0; x < dim; x++, i += 4) {
      const v = px[i] * red + px[i + 1] * green + px[i + 2] * blue - base;
      const cell = row + (((x * n) / dim) | 0);
      if (v < min[cell]) min[cell] = v;
      if (v > max[cell]) max[cell] = v;
    }
  }

  const levels: Pyramid = [{ min, max }];
  for (let size = n; size > 1; size /= 2) {
    const fine = levels[0];
    const half = size / 2;
    const up = { min: new Float32Array(half * half), max: new Float32Array(half * half) };
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const a = y * 2 * size + x * 2;
        const b = a + size;
        up.min[y * half + x] = Math.min(fine.min[a], fine.min[a + 1], fine.min[b], fine.min[b + 1]);
        up.max[y * half + x] = Math.max(fine.max[a], fine.max[a + 1], fine.max[b], fine.max[b + 1]);
      }
    }
    levels.unshift(up);
  }
  pyramids.set(dem, levels);
  return levels;
}

/** MapLibre's own test, which pairs the frustum with the clipping plane when there is one. */
function seen(box: Box, frustum: Frustum, plane: Plane): number {
  const hit = box.intersectsFrustum(frustum);
  if (!plane || hit === NONE) return hit;
  const clipped = box.intersectsPlane(plane);
  if (clipped === NONE) return NONE;
  return hit === FULL && clipped === FULL ? FULL : 1;
}

/**
 * Widens `into` by the elevations one pyramid node holds, descending only where the
 * frustum cuts through it: a node fully in view answers from its stored extremes and a
 * node fully outside answers not at all, so the walk costs the frame's edge rather than
 * its area.
 */
function collect(
  box: Box,
  level: number,
  x: number,
  y: number,
  levels: Pyramid,
  frustum: Frustum,
  plane: Plane,
  into: Range,
): void {
  const cell = y * (1 << level) + x;
  const lo = levels[level].min[cell];
  const hi = levels[level].max[cell];
  // A node inside the range already found cannot widen it, and neither can anything under
  // it — every child's extremes sit inside its parent's. Most of the frame's edge is
  // ordinary ground somewhere between the summits and the valley floors, so this prunes
  // the descent long before the frustum does.
  if (lo >= into.lo && hi <= into.hi) return;

  const hit = seen(box, frustum, plane);
  if (hit === NONE) return;

  if (hit === FULL || level === levels.length - 1) {
    if (lo < into.lo) into.lo = lo;
    if (hi > into.hi) into.hi = hi;
    return;
  }
  // quadrant() splits x on the low bit of the index and y on the high one.
  for (let q = 0; q < 4; q++) {
    collect(box.quadrant(q), level + 1, x * 2 + (q & 1), y * 2 + (q >> 1), levels, frustum, plane, into);
  }
}

/**
 * The elevation range the frame holds, or null while nothing with a DEM is in frame — the
 * caller keeps what it had rather than exposing against an empty answer.
 *
 * Every elevation on screen counts and nothing else does, so the ramp spans what can be
 * seen and the endpoints need no distance to be argued about. Read off the DEM rather
 * than sampled, so at world zoom Everest comes back as 5604 m, which is what a z0 tile
 * flattens it to and therefore what the ramp should end at.
 *
 * A tile's own `dem.min`/`dem.max` answer for the whole tile though, and a coarse tile
 * reaches far past the frame: over Rybinsk at z5.45 the four z4 tiles drawn are a tenth
 * on screen each and carry Elbrus and the Karagiye Depression 1200 km south of the bottom
 * edge, for a range of −131 to 4839 m over ground that runs 0 to 340 m. So each tile is
 * cut to the frustum first, against the same boxes and the same test that chose the tile
 * for drawing.
 */
export function visibleRange(map: MapLibreMap, source: string): Range | null {
  const tiles = map.style.tileManagers[source];
  if (!tiles) return null;
  const transform = map._camera.transform;
  const frustum = transform.getCameraFrustum() as Frustum;
  const plane = transform.getClippingPlane() as Plane;
  const volumes = transform.getCoveringTilesDetailsProvider();

  const into: Range = { lo: Infinity, hi: -Infinity };
  const cut: { box: Box; dem: Dem }[] = [];
  for (const id of tiles.getRenderableIds()) {
    const tile = tiles.getTileByID(id);
    if (!tile?.dem) continue;

    // Terrain gives the box the tile's own elevation span; without it the box is flat at
    // the camera's plane and a mountain leaves the frustum before its ground does.
    const box = volumes.getTileBoundingVolume(tile.tileID.canonical, tile.tileID.wrap, transform.elevation, {
      terrain: map.terrain,
      tileSize: tiles.tileSize,
    }) as unknown as Box;

    const hit = seen(box, frustum, plane);
    if (hit === NONE) continue;
    if (hit === FULL) {
      if (tile.dem.min < into.lo) into.lo = tile.dem.min;
      if (tile.dem.max > into.hi) into.hi = tile.dem.max;
    } else {
      cut.push({ box, dem: tile.dem as unknown as Dem });
    }
  }
  // The tiles wholly in frame cost one test each and are held whole, so taking them first
  // hands the descents below a range to prune against.
  for (const { box, dem } of cut) {
    collect(box, 0, 0, 0, pyramidFor(dem), frustum, plane, into);
  }
  if (into.lo === Infinity) return null;

  if (into.hi - into.lo >= MIN_SPAN) return into;
  const mid = (into.lo + into.hi) / 2;
  return { lo: mid - MIN_SPAN / 2, hi: mid + MIN_SPAN / 2 };
}

/**
 * Follows the view, reporting an eased range.
 *
 * The measurement is a step function — pyramid cells cross the frustum whole, and a tile
 * that finishes loading replaces a coarser one that answered differently — so the raw
 * range jumps as the camera moves, and a ramp repainted from it makes the whole map
 * breathe. Easing spends those steps over a quarter second. The scan itself costs a
 * fraction of a millisecond, so the cadence is about smoothness rather than budget.
 */
export function trackExposure(
  map: MapLibreMap,
  source: string,
  onChange: (range: Range) => void,
): () => void {
  let current: Range | null = null;
  let target: Range | null = null;
  let frame = 0;
  let last = 0;

  const gap = (a: Range, b: Range): number =>
    Math.max(Math.abs(a.lo - b.lo), Math.abs(a.hi - b.hi));

  // The clock is read here rather than taken from the frame timestamp, which is when the
  // frame began and so can predate the `performance.now()` that scheduled it. That makes
  // dt negative, and a negative dt inverts the ease: the range crawls away from its target
  // and never arrives, repainting the ramp forever.
  const step = (): void => {
    frame = 0;
    if (!current || !target) return;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (gap(current, target) <= SETTLED) {
      current = target;
    } else {
      const k = 1 - Math.exp(-dt / EASE_TAU);
      current = {
        lo: current.lo + (target.lo - current.lo) * k,
        hi: current.hi + (target.hi - current.hi) * k,
      };
      schedule();
    }
    onChange(current);
  };

  function schedule(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  }

  const measure = (): void => {
    const next = visibleRange(map, source);
    if (!next) return;
    target = next;
    // The first range is what the view already is, not somewhere to travel from.
    if (!current) {
      current = next;
      onChange(current);
      return;
    }
    // Only a range that has actually moved is worth a frame. Reporting an unchanged one
    // repaints the ramp, which dirties the style, which draws a frame, which fires
    // sourcedata, which lands back here — and a still map never reaches `loaded()`.
    if (gap(current, target) > SETTLED) schedule();
  };

  const onData = (e: MapSourceDataEvent): void => {
    if (e.sourceId === source) measure();
  };

  map.on('move', measure);
  map.on('sourcedata', onData);
  measure();

  return () => {
    map.off('move', measure);
    map.off('sourcedata', onData);
    if (frame) cancelAnimationFrame(frame);
  };
}
