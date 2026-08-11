import { MercatorCoordinate, Point, type MapLibreMap } from 'maplibre-gl';
import { cameraFrame, dot, type Vec3 } from './cameraAnchor';

/**
 * Which point the shift+drag gesture turns around.
 *
 * Anchoring on a fixed fraction of the frame — a ladder of raycasts down the centre
 * column, first hit wins — holds that pixel exactly but grabs whatever happens to be
 * under it. With the Matterhorn head-on and filling the view, 0.65 down the frame is the
 * glacier at its base, so a tilt swings the summit out of the frame and the turning
 * circle reads as being "way out"; pitched down at the same mountain the ladder happens
 * to land on the visible slope and it feels right.
 *
 * So the pivot is chosen by what the frame is *of*, not by where a pixel is: raycast a
 * grid, weight each hit toward the centre of attention, and put the pivot on the view
 * axis at the weighted median of their depths. A mountain filling the view owns most of
 * the weight and holds still wherever the drag starts; move forward until the terrain
 * around it dominates and the turn moves out to that. Google Maps 3D behaves this way —
 * shift+dragging far from the mountain still turns about the mountain — and click
 * independence falls out for free, since the mouse position never enters.
 *
 * Median, not mean: a distant valley seen through a col must not drag the pivot out past
 * the subject. Whichever surface owns the most weighted pixels wins outright.
 */

const GRID_COLUMNS = 7;
const GRID_ROWS = 5;
/** Fractions of the viewport the grid spans, inset from the edges. */
const GRID_X = [0.15, 0.85];
const GRID_Y = [0.15, 0.9];

/** Where attention sits, and how fast the weight falls off from it. */
const WEIGHT_CENTRE = [0.5, 0.5];
const WEIGHT_SIGMA = 0.25;

/** Below this the grid has found too little terrain to have an opinion. */
const MIN_HITS = 3;

/**
 * Fallback for a frame that is nearly all sky: fractions of the viewport height to look
 * for any terrain at, first hit wins. Below the centre is nearer, and a nearer pivot is a
 * tighter turn.
 */
const ANCHOR_LADDER = [0.65, 0.8, 0.5, 0.92];

/** Mercator x/y and an elevation in metres — a point in the world, on the terrain or above it. */
export type PivotPoint = { x: number; y: number; elevation: number };

export type PivotSample = {
  /** The viewport pixel this was cast from. */
  x: number;
  y: number;
  /** Where it hit, and how far along the view axis that is. Null where the pixel is sky. */
  point: PivotPoint | null;
  depth: number | null;
  weight: number;
};

export type Pivot = {
  point: PivotPoint;
  /** Metres along the view axis. */
  depth: number;
  from: 'subject' | 'anchor';
  samples: PivotSample[];
};

/** The camera as the raycasts see it: a position, a basis, and the scale to walk it in. */
type View = {
  camera: MercatorCoordinate;
  altitude: number;
  frame: ReturnType<typeof cameraFrame>;
  mercatorPerMetre: number;
  width: number;
  height: number;
};

function currentView(map: MapLibreMap): View {
  const tr = map._camera.transform;
  const camera = MercatorCoordinate.fromLngLat(tr.getCameraLngLat());
  return {
    camera,
    altitude: tr.getCameraAltitude(),
    frame: cameraFrame(tr.bearing, tr.pitch),
    mercatorPerMetre: camera.meterInMercatorCoordinateUnits(),
    width: tr.width,
    height: tr.height,
  };
}

/** From the camera to a world point, in metres east/north/up. */
const offsetTo = (v: View, p: PivotPoint): Vec3 => [
  (p.x - v.camera.x) / v.mercatorPerMetre,
  -(p.y - v.camera.y) / v.mercatorPerMetre,
  p.elevation - v.altitude,
];

/** The ground under a pixel, or null if that pixel is sky. */
function raycast(map: MapLibreMap, x: number, y: number): PivotPoint | null {
  // z is the elevation in metres on what comes back, not a mercator z — toAltitude()
  // would be nonsense.
  const hit = map.terrain?.pointCoordinate(new Point(x, y));
  return hit ? { x: hit.x, y: hit.y, elevation: hit.z } : null;
}

/** A point on the view axis, that many metres ahead. */
const alongAxis = (v: View, depth: number): PivotPoint => ({
  x: v.camera.x + v.frame.forward[0] * depth * v.mercatorPerMetre,
  y: v.camera.y - v.frame.forward[1] * depth * v.mercatorPerMetre,
  elevation: v.altitude + v.frame.forward[2] * depth,
});

function grid(map: MapLibreMap, v: View): PivotSample[] {
  const sigma = WEIGHT_SIGMA * Math.min(v.width, v.height);
  const samples: PivotSample[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      const x =
        v.width * (GRID_X[0] + ((GRID_X[1] - GRID_X[0]) * col) / (GRID_COLUMNS - 1));
      const y = v.height * (GRID_Y[0] + ((GRID_Y[1] - GRID_Y[0]) * row) / (GRID_ROWS - 1));
      const point = raycast(map, x, y);
      const away = Math.hypot(x - v.width * WEIGHT_CENTRE[0], y - v.height * WEIGHT_CENTRE[1]);
      samples.push({
        x,
        y,
        point,
        depth: point ? dot(offsetTo(v, point), v.frame.forward) : null,
        weight: Math.exp(-0.5 * (away / sigma) ** 2),
      });
    }
  }
  return samples;
}

/** The depth half the weight lies in front of. Sky weighs nothing. */
function weightedMedianDepth(samples: PivotSample[]): number | null {
  const hits = samples
    .filter((s) => s.depth !== null)
    .sort((a, b) => (a.depth as number) - (b.depth as number));
  if (hits.length < MIN_HITS) return null;
  const half = hits.reduce((sum, s) => sum + s.weight, 0) / 2;
  let seen = 0;
  for (const s of hits) {
    seen += s.weight;
    if (seen >= half) return s.depth;
  }
  return hits[hits.length - 1].depth;
}

/**
 * The pivot for the camera as it stands. The readbacks are a GPU stall, so this runs once
 * per gesture rather than once per frame.
 */
export function choosePivot(map: MapLibreMap): Pivot | null {
  if (!map.terrain) return null;
  const v = currentView(map);
  const samples = grid(map, v);

  const depth = weightedMedianDepth(samples);
  if (depth !== null) return { point: alongAxis(v, depth), depth, from: 'subject', samples };

  for (const fraction of ANCHOR_LADDER) {
    const point = raycast(map, v.width / 2, v.height * fraction);
    if (!point) continue;
    return { point, depth: dot(offsetTo(v, point), v.frame.forward), from: 'anchor', samples };
  }
  return null;
}

/**
 * Where a world point lands on screen. MapLibre's `project` takes a lng/lat and looks the
 * terrain up under it, which is no use for a pivot that sits in the air, so this projects
 * through the camera's own basis: metres across the axis over metres along it, times the
 * focal length `cameraToCenterDistance` already carries in pixels.
 *
 * Null for anything level with the camera or behind it.
 */
export function projectPoint(map: MapLibreMap, p: PivotPoint): { x: number; y: number } | null {
  const v = currentView(map);
  const offset = offsetTo(v, p);
  const forward = dot(offset, v.frame.forward);
  if (forward <= 0) return null;
  const focal = map._camera.transform.cameraToCenterDistance;
  return {
    x: v.width / 2 + (dot(offset, v.frame.right) / forward) * focal,
    y: v.height / 2 - (dot(offset, v.frame.up) / forward) * focal,
  };
}
