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
 * grid, weight each hit toward the centre of attention, group the hits into the surfaces
 * they came from, and pivot on the surface holding the most weight. A mountain filling
 * the view owns it and holds still wherever the drag starts; move forward until the
 * terrain around it dominates and the turn moves out to that. Google Maps 3D behaves this
 * way — shift+dragging far from the mountain still turns about the mountain — and click
 * independence falls out for free, since the mouse position never enters.
 *
 * Surfaces rather than a statistic over all the depths. Head-on at the Matterhorn the
 * grid sees four of them — the face at 2.2–2.7 km with 59 % of the weight, a ridge at
 * 9–12 km, the horizon at 39–46 km — and a median over that lot is a step function: the
 * face slipping from 51 % to 49 % of the weight teleports the pivot from the mountain out
 * to the ridge. A surface losing a few percent still wins.
 *
 * The pivot is a point on that surface, not a depth on the view axis, so a subject the
 * frame is not centred on is still what turns — at the view above the face's centre of
 * mass is 96 px below and right of the middle of the window.
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
 * How big a jump in depth starts a new surface, in octaves. Wide enough that a face
 * slanting away from the camera stays one thing, narrow enough to keep the ridge behind
 * it separate.
 */
const SURFACE_GAP = 0.35;

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
  /** Whether this hit is part of the surface that won. */
  chosen: boolean;
};

export type Pivot = {
  point: PivotPoint;
  /** Metres along the view axis. */
  depth: number;
  from: 'subject' | 'anchor';
  /** How much of the grid's weight the chosen surface holds. */
  share: number;
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
  /** Focal length in pixels, which is what cameraToCenterDistance is. */
  focal: number;
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
    focal: tr.cameraToCenterDistance,
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
        chosen: false,
      });
    }
  }
  return samples;
}

type Surface = { members: PivotSample[]; weight: number };

/** The hits grouped into the surfaces they came from: runs of similar depth. Sky weighs nothing. */
function surfaces(samples: PivotSample[]): Surface[] {
  const hits = samples
    .filter((s) => s.depth !== null)
    .sort((a, b) => (a.depth as number) - (b.depth as number));
  const found: Surface[] = [];
  for (const s of hits) {
    const open = found[found.length - 1];
    const previous = open?.members[open.members.length - 1];
    if (previous && Math.log2((s.depth as number) / (previous.depth as number)) <= SURFACE_GAP) {
      open.members.push(s);
    } else {
      found.push({ members: [s], weight: 0 });
    }
  }
  for (const surface of found) {
    surface.weight = surface.members.reduce((sum, s) => sum + s.weight, 0);
  }
  return found;
}

/**
 * A point on the surface, which is what the gesture wants to hold — the centre of mass of
 * a curved one is not on it, and across a ridge it lands inside the mountain. So the
 * centroid is projected back to a pixel and re-cast from there; the sample nearest it
 * stands in when that pixel misses or answers from something else. Either way the pivot
 * is a raycast hit, so it is always on the terrain.
 */
function onSurface(map: MapLibreMap, v: View, surface: Surface): PivotPoint {
  const members = surface.members as (PivotSample & { point: PivotPoint })[];
  const mean = (of: (p: PivotPoint) => number): number =>
    members.reduce((sum, s) => sum + of(s.point) * s.weight, 0) / surface.weight;
  const centroid = { x: mean((p) => p.x), y: mean((p) => p.y), elevation: mean((p) => p.elevation) };

  const at = projectFrom(v, centroid);
  if (at && at.x >= 0 && at.x < v.width && at.y >= 0 && at.y < v.height) {
    const hit = raycast(map, at.x, at.y);
    const depth = hit && dot(offsetTo(v, hit), v.frame.forward);
    const centroidDepth = dot(offsetTo(v, centroid), v.frame.forward);
    if (hit && depth && Math.abs(Math.log2(depth / centroidDepth)) <= SURFACE_GAP) return hit;
  }

  const squared = (p: PivotPoint): number =>
    ((p.x - centroid.x) / v.mercatorPerMetre) ** 2 +
    ((p.y - centroid.y) / v.mercatorPerMetre) ** 2 +
    (p.elevation - centroid.elevation) ** 2;
  return members.reduce((a, b) => (squared(b.point) < squared(a.point) ? b : a)).point;
}

/**
 * The pivot for the camera as it stands. The readbacks are a GPU stall, so this runs once
 * per gesture rather than once per frame.
 */
export function choosePivot(map: MapLibreMap): Pivot | null {
  if (!map.terrain) return null;
  const v = currentView(map);
  const samples = grid(map, v);

  const found = surfaces(samples);
  const hits = found.reduce((sum, s) => sum + s.members.length, 0);
  if (hits >= MIN_HITS) {
    const chosen = found.reduce((a, b) => (b.weight > a.weight ? b : a));
    for (const s of chosen.members) s.chosen = true;
    const point = onSurface(map, v, chosen);
    return {
      point,
      depth: dot(offsetTo(v, point), v.frame.forward),
      from: 'subject',
      share: chosen.weight / found.reduce((sum, s) => sum + s.weight, 0),
      samples,
    };
  }

  for (const fraction of ANCHOR_LADDER) {
    const point = raycast(map, v.width / 2, v.height * fraction);
    if (!point) continue;
    return {
      point,
      depth: dot(offsetTo(v, point), v.frame.forward),
      from: 'anchor',
      share: 0,
      samples,
    };
  }
  return null;
}

function projectFrom(v: View, p: PivotPoint): { x: number; y: number } | null {
  const offset = offsetTo(v, p);
  const forward = dot(offset, v.frame.forward);
  if (forward <= 0) return null;
  return {
    x: v.width / 2 + (dot(offset, v.frame.right) / forward) * v.focal,
    y: v.height / 2 - (dot(offset, v.frame.up) / forward) * v.focal,
  };
}

/**
 * Where a world point lands on screen. MapLibre's `project` takes a lng/lat and looks the
 * terrain up under it, which answers for the ground rather than for the point, so this
 * projects through the camera's own basis instead: metres across the axis over metres
 * along it, times the focal length `cameraToCenterDistance` already carries in pixels.
 *
 * Null for anything level with the camera or behind it.
 */
export const projectPoint = (map: MapLibreMap, p: PivotPoint): { x: number; y: number } | null =>
  projectFrom(currentView(map), p);
