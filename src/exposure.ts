import type { MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';

/** The endpoints of an elevation ramp, in metres. */
export type Range = { lo: number; hi: number };

/**
 * How far below the frame's own zoom a DEM tile still counts as near field.
 *
 * The tiles behind the shading run to the horizon, and a horizon tile is both coarse and
 * enormous. Taken raw, the Zermatt valley at pitch 78 spans −6 to 4772 m and the
 * Netherlands −299 to 990 m — a country with 10 m of relief would land inside one percent
 * of the ramp, which is the flat grey the exposure exists to cure. Terrain LOD hands the
 * coarse tiles to distant ground, so a floor on zoom is a cut on distance: at 1 those two
 * views read 1104–4622 m and −9 to 85 m.
 *
 * Measured against `tileZoom` rather than the deepest tile present, because the deepest
 * tile moves as tiles finish loading and would walk the exposure while a view settles.
 * Apparent screen size is the measure this approximates, and approximates because the
 * honest version needs each tile's quad clipped to the viewport.
 */
const NEAR_FIELD = 1;

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

/**
 * The elevation range the frame holds, or null while no tile near enough to count has
 * loaded — the caller keeps what it had rather than exposing against the horizon.
 *
 * `dem.min`/`dem.max` are the tile's own extremes, so this reads the exact range of the
 * data being drawn rather than sampling it: at world zoom Everest comes back as 5604 m,
 * which is what a z0 tile flattens it to and therefore what the ramp should end at.
 */
export function visibleRange(map: MapLibreMap, source: string): Range | null {
  const tiles = map.style.tileManagers[source];
  if (!tiles) return null;
  const floor = map._camera.transform.tileZoom - NEAR_FIELD;

  let lo = Infinity;
  let hi = -Infinity;
  for (const id of tiles.getRenderableIds()) {
    const tile = tiles.getTileByID(id);
    if (!tile?.dem || tile.tileID.overscaledZ < floor) continue;
    lo = Math.min(lo, tile.dem.min);
    hi = Math.max(hi, tile.dem.max);
  }
  if (lo === Infinity) return null;

  if (hi - lo >= MIN_SPAN) return { lo, hi };
  const mid = (lo + hi) / 2;
  return { lo: mid - MIN_SPAN / 2, hi: mid + MIN_SPAN / 2 };
}

/**
 * Follows the view, reporting an eased range.
 *
 * The measurement is a step function — tiles cross the near-field floor whole — so the
 * raw range jumps as the camera moves, and a ramp repainted from it makes the whole map
 * breathe. Easing spends those steps over a quarter second. The scan itself costs about
 * 0.3 ms, so the cadence is about smoothness rather than budget.
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
