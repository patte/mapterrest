import { MercatorCoordinate, type MapLibreMap } from 'maplibre-gl';
import { cameraFrame, dot, rayCrossing, type Ray, type Vec3 } from './cameraAnchor';

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
 * they came from, and pivot on the one a turn would hold the frame stillest around — see
 * `stillestSurface`. A mountain filling the view holds still wherever the drag starts;
 * move forward until the terrain around it dominates and the turn moves out to that.
 * Google Maps 3D behaves this way — shift+dragging far from the mountain still turns about
 * the mountain — and click independence falls out for free, since the mouse position never
 * enters.
 *
 * Surfaces rather than a statistic over all the depths. Head-on at the Matterhorn the
 * grid sees four of them — the face at 2.2–2.7 km, a ridge at 9–12 km, the horizon at
 * 39–46 km — and a median over that lot is a step function: the face slipping from 51 % to
 * 49 % of the weight teleports the pivot from the mountain out to the ridge.
 *
 * The pivot is a point on that surface, not a depth on the view axis, so a subject the
 * frame is not centred on is still what turns — at the view above the face's centre of
 * mass is 96 px below and right of the middle of the window.
 */

/**
 * Enough rays that a subject narrower than the spacing between them cannot slip through.
 * Over a 1900 px frame 7 columns leave 222 px between samples, which a peak at 15 km is
 * comfortably narrower than; 13 leave 111 px. The count is affordable because the rays are
 * marched against the DEM rather than read back from the GPU — 117 of them cost about as
 * much as 36 readbacks did.
 */
export const GRID_COLUMNS = 13;
const GRID_ROWS = 9;
/** Fractions of the viewport the grid spans, inset from the edges. */
const GRID_X = [0.15, 0.85];
const GRID_Y = [0.15, 0.9];

/** Where attention sits, and how fast the weight falls off from it. */
const WEIGHT_CENTRE = [0.5, 0.5];
const WEIGHT_SIGMA = 0.25;

/** Below this the grid has found too little terrain to have an opinion. */
const MIN_HITS = 3;

/**
 * How deep a surface reaches either side of its centre, in octaves. Wide enough that a
 * face slanting away from the camera stays one thing, narrow enough to keep the ridge
 * behind it separate.
 */
const SURFACE_BAND = 0.35;

/**
 * The most apparent motion one sample is allowed to complain about, in frame-widths per
 * radian of turn. Uncapped, a scrap of ground running under the camera outvotes a mountain
 * filling the frame: its term in the cost below grows without bound as the pivot moves
 * away from it, so a strip at 250 m took the pivot off a mountain at 4.5 km. A sample can
 * be badly held; it cannot be infinitely badly held. Anything from 1.5 to 6 holds every
 * view measured so far.
 */
const MOTION_CAP = 3;

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

/** The ray out through a viewport pixel: the view axis, tilted by how far off centre it is. */
function rayThrough(v: View, x: number, y: number): Ray {
  const across = (x - v.width / 2) / v.focal;
  const up = -(y - v.height / 2) / v.focal;
  const direction = v.frame.forward.map(
    (f, k) => f + v.frame.right[k] * across + v.frame.up[k] * up,
  ) as Vec3;
  const length = Math.hypot(...direction);
  return {
    origin: v.camera,
    altitude: v.altitude,
    direction: direction.map((c) => c / length) as Vec3,
  };
}

/**
 * The ground under a pixel, or null if that pixel is sky.
 *
 * Marched against the DEM rather than read back from MapLibre's coords framebuffer.
 * `terrain.pointCoordinate` is the obvious call and it is quietly wrong on a big frame:
 * the tile a pixel belongs to is encoded in one byte, so past 255 rendered terrain tiles
 * the index wraps and the answer is a real coordinate from the wrong tile. A 1900×1532
 * window at pitch 85 draws 306 of them and every sample came back 200–350 km out, on a
 * mountain 3 km away. Marching also reads the same DEM the camera anchor settles against,
 * so the pivot and the settle no longer disagree by the metres that mesh and DEM do.
 */
function raycast(map: MapLibreMap, v: View, x: number, y: number): PivotPoint | null {
  const ray = rayThrough(v, x, y);
  const distance = rayCrossing(
    map,
    v.mercatorPerMetre,
    ray,
    map._camera.transform.tileZoom,
  );
  if (distance === null) return null;
  return {
    x: v.camera.x + ray.direction[0] * distance * v.mercatorPerMetre,
    y: v.camera.y - ray.direction[1] * distance * v.mercatorPerMetre,
    elevation: v.altitude + ray.direction[2] * distance,
  };
}

function grid(map: MapLibreMap, v: View): PivotSample[] {
  const sigma = WEIGHT_SIGMA * Math.min(v.width, v.height);
  const samples: PivotSample[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLUMNS; col++) {
      const x =
        v.width * (GRID_X[0] + ((GRID_X[1] - GRID_X[0]) * col) / (GRID_COLUMNS - 1));
      const y = v.height * (GRID_Y[0] + ((GRID_Y[1] - GRID_Y[0]) * row) / (GRID_ROWS - 1));
      const point = raycast(map, v, x, y);
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

type Hit = PivotSample & { point: PivotPoint; depth: number };
type Surface = { members: Hit[]; weight: number; share: number };

/**
 * The surface a turn would hold the frame stillest around.
 *
 * Turning by θ about a pivot D away swings the camera through an arc of about D·θ, and a
 * point at depth d then slides across the screen by roughly `focal · θ · |D/d − 1|` —
 * nothing at d = D, and more the further its depth is from the pivot's. Summed over the
 * frame that is what a choice of pivot costs:
 *
 *     cost(D) = Σ weight · |D/d − 1|
 *
 * so the surface to pivot on is the one that minimises it. The preference for the near
 * thing falls out of the geometry rather than being dialled in: a far point's term
 * saturates at its weight (a pivot at no distance means the camera never translates, so
 * nothing moves much) while a near point's grows without bound, which is why the cap
 * above exists at all.
 *
 * Scoring surfaces by the weight they own instead — the share of the screen they cover —
 * reads well and breaks on the near, deep subject. Depth measured in octaves means the
 * closer a thing is, the more of them it spans: at z16.14 the Matterhorn's samples spread
 * over 0.17 octaves and it won, and half a zoom level closer the same mountain spread over
 * 0.65, split across two bands, and lost to the plain 4 km behind it holding 47 %.
 *
 * The band still says what a surface *is*; it no longer says which one wins. Sky weighs
 * nothing.
 */
function stillestSurface(samples: PivotSample[]): Surface | null {
  const hits = samples.filter((s): s is Hit => s.depth !== null);
  if (hits.length < MIN_HITS) return null;
  const total = hits.reduce((sum, s) => sum + s.weight, 0);

  const around = (depth: number): Surface => {
    const members = hits.filter((s) => Math.abs(Math.log2(s.depth / depth)) <= SURFACE_BAND);
    const weight = members.reduce((sum, s) => sum + s.weight, 0);
    return { members, weight, share: weight / total };
  };
  const centreOf = (surface: Surface): number =>
    surface.members.reduce((sum, s) => sum + s.depth * s.weight, 0) / surface.weight;
  const cost = (depth: number): number =>
    hits.reduce(
      (sum, s) => sum + s.weight * Math.min(Math.abs(depth / s.depth - 1), MOTION_CAP),
      0,
    );

  // Every hit stands for the surface around it; the frame is small enough to score them all.
  return hits
    .map((s) => around(s.depth))
    .reduce((a, b) => (cost(centreOf(b)) < cost(centreOf(a)) ? b : a));
}

/**
 * A point on the surface, which is what the gesture wants to hold — the centre of mass of
 * a curved one is not on it, and across a ridge it lands inside the mountain. So the
 * centroid is projected back to a pixel and re-cast from there; the sample nearest it
 * stands in when that pixel misses or answers from something else. Either way the pivot
 * is a raycast hit, so it is always on the terrain.
 */
function onSurface(map: MapLibreMap, v: View, surface: Surface): PivotPoint {
  const { members } = surface;
  const mean = (of: (p: PivotPoint) => number): number =>
    members.reduce((sum, s) => sum + of(s.point) * s.weight, 0) / surface.weight;
  const centroid = { x: mean((p) => p.x), y: mean((p) => p.y), elevation: mean((p) => p.elevation) };

  const at = projectFrom(v, centroid);
  if (at && at.x >= 0 && at.x < v.width && at.y >= 0 && at.y < v.height) {
    const hit = raycast(map, v, at.x, at.y);
    const depth = hit && dot(offsetTo(v, hit), v.frame.forward);
    const centroidDepth = dot(offsetTo(v, centroid), v.frame.forward);
    if (hit && depth && Math.abs(Math.log2(depth / centroidDepth)) <= SURFACE_BAND) return hit;
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

  const surface = stillestSurface(samples);
  if (surface) {
    for (const s of surface.members) s.chosen = true;
    const point = onSurface(map, v, surface);
    return {
      point,
      depth: dot(offsetTo(v, point), v.frame.forward),
      from: 'subject',
      share: surface.share,
      samples,
    };
  }

  for (const fraction of ANCHOR_LADDER) {
    const point = raycast(map, v, v.width / 2, v.height * fraction);
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
