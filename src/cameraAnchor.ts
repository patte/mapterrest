import { MercatorCoordinate, type MapLibreMap, type MapSourceDataEvent } from 'maplibre-gl';
import { DEM_SOURCE } from './terrain';

/**
 * MapLibre stores a camera as a centre on the ground, the elevation of that centre and a
 * zoom that is really the distance to it. With `centerClampedToGround` (the default) it
 * re-pins the centre's elevation to the DEM every rendered frame and every terrain tile,
 * and moves the camera by whatever the difference has become. In the mountains that
 * difference is never zero: deeper tiles rewrite the ground mid-gesture (a wheel zoom at
 * pitch 78 teleported the centre 2.4 km), and the recalculation MapLibre runs when a
 * gesture ends re-derives zoom from a near-degenerate gap (a pan release jumped z12.8 to
 * z13.4 and pulled the centre back 2.2 km).
 *
 * So the pin is off (`centerClampedToGround: false` at construction) and this module
 * anchors the camera deliberately, in two regimes:
 *
 * - While the first view loads, the centre's elevation is re-anchored to the ground per
 *   terrain tile — what the pin did — so the zoom saved in the hash keeps meaning what
 *   it meant when it was written.
 * - From the first user movement on, the camera is settled once per finished movement:
 *   the centre goes to where the view axis meets the terrain, which is a point on the
 *   axis, so adopting it moves no pixel and leaves nothing for a later pin to correct.
 */

/**
 * How far ahead the centre is allowed to sit. The centre is where the view axis meets
 * the elevation plane, which runs to infinity as the camera comes level; past this the
 * distance stops growing and the plane rises to meet it instead. MapLibre's own maths
 * gives up in the same place, at |cos(pitch)| < 0.1, and pins 10 km ahead.
 */
const MAX_CENTRE_DISTANCE = 10000;

const DEG = Math.PI / 180;

/** East, north, up in metres. */
export type Vec3 = [number, number, number];

/** The camera's basis vectors, in metres east/north/up. Pitch is measured from straight down. */
export function cameraFrame(
  bearing: number,
  pitch: number,
): { right: Vec3; up: Vec3; forward: Vec3 } {
  const sb = Math.sin(bearing * DEG);
  const cb = Math.cos(bearing * DEG);
  const sp = Math.sin(pitch * DEG);
  const cp = Math.cos(pitch * DEG);
  return {
    right: [cb, -sb, 0],
    up: [sb * cp, cb * cp, sp],
    forward: [sp * sb, sp * cb, -cp],
  };
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export type Pose = {
  camera: { lng: number; lat: number };
  altitude: number;
  bearing: number;
  pitch: number;
};

/** A point along the view axis: where it is on the ground, and how high the axis is there. */
function axisAt(mercatorPerMetre: number, pose: Pose, distance: number) {
  const frame = cameraFrame(pose.bearing, pose.pitch);
  const cameraMercator = MercatorCoordinate.fromLngLat(pose.camera);
  return {
    distance,
    elevation: pose.altitude + frame.forward[2] * distance,
    centre: new MercatorCoordinate(
      cameraMercator.x + frame.forward[0] * distance * mercatorPerMetre,
      cameraMercator.y - frame.forward[1] * distance * mercatorPerMetre,
    ).toLngLat(),
  };
}

/** How far along the axis a given horizontal plane is. */
export function distanceToPlane(pose: Pose, plane: number): number {
  const down = -cameraFrame(pose.bearing, pose.pitch).forward[2];
  const above = pose.altitude - plane;
  return down > 0 && above > 0 ? Math.min(above / down, MAX_CENTRE_DISTANCE) : MAX_CENTRE_DISTANCE;
}

const MARCH_NEAR = 25;
const MARCH_FAR = 80000;
const MARCH_STEPS = 48;

/**
 * How far along the view axis the terrain first comes up to meet it, sampled the way the
 * elevation pin samples — a DEM read at the tile zoom, not the rendered mesh a raycast
 * hits. The two disagree by metres on a slope, and metres of elevation is metres of
 * camera.
 *
 * Marched rather than solved. Stepping the plane toward the terrain and re-solving
 * diverges wherever the ground is steeper than the axis, which in the Alps is most of it:
 * one pass moved the plane 100 m the wrong way and left the pin 268 m to take back.
 * Steps grow geometrically, since the DEM coarsens with distance too.
 */
function axisCrossing(
  map: MapLibreMap,
  mercatorPerMetre: number,
  pose: Pose,
  zoom: number,
): number | null {
  const clearance = (distance: number): number | null => {
    const at = axisAt(mercatorPerMetre, pose, distance);
    const ground = map.terrain?.getElevationForLngLatZoom(at.centre, zoom);
    return ground === undefined || !Number.isFinite(ground) ? null : at.elevation - ground;
  };

  const growth = (MARCH_FAR / MARCH_NEAR) ** (1 / MARCH_STEPS);
  let near = 0;
  for (let i = 0, d = MARCH_NEAR; i <= MARCH_STEPS; i++, d *= growth) {
    const gap = clearance(d);
    if (gap === null) return null;
    if (gap <= 0) {
      // Bisect: a metre of slack here is a metre the camera would move.
      let lo = near;
      let hi = d;
      for (let j = 0; j < 12; j++) {
        const mid = (lo + hi) / 2;
        const gapAt = clearance(mid);
        if (gapAt === null) break;
        if (gapAt <= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    near = d;
  }
  return null;
}

/** The zoom that puts the centre this far down the axis. */
const zoomFor = (map: MapLibreMap, mercatorPerMetre: number, distance: number): number => {
  const tr = map._camera.transform;
  return Math.log2(tr.cameraToCenterDistance / (distance * mercatorPerMetre) / tr.tileSize);
};

/**
 * Put the camera where the caller wants it, written the way MapLibre stores a camera: a
 * centre on the view axis, the elevation of the plane that centre sits on, and a zoom
 * that is really the distance to it.
 *
 * `calculateCameraOptionsFromCameraLngLatAltRotation` will do this too, but only against
 * the plane the centre is on at the time, and in the mountains that plane is often a
 * hair below the camera — at 46.086, 7.712 the camera flies 22 m over a wall the 1.4×
 * exaggeration has pushed up to 5199 m. The distance to the plane is that gap over
 * cos(pitch), so it collapses, and the zoom expressing it jumps to z18 on a z14 view,
 * taking the tile LOD with it. Naming the plane keeps the distance well behaved.
 */
export function applyPose(
  map: MapLibreMap,
  mercatorPerMetre: number,
  pose: Pose,
  distance: number,
): void {
  const { centre, elevation } = axisAt(mercatorPerMetre, pose, distance);
  map.jumpTo({
    center: centre,
    elevation,
    zoom: zoomFor(map, mercatorPerMetre, distance),
    bearing: pose.bearing,
    pitch: pose.pitch,
    // roll is passed explicitly: jumpTo tests `'roll' in options`, so spreading an
    // options object that carries roll: undefined would set a roll of NaN.
    roll: 0,
  });
}

/**
 * Re-anchor the camera without moving what it shows: the centre goes to where the view
 * axis meets the terrain, at the terrain's own elevation. Getting there wants care —
 * raycasting answers from the rendered mesh, which disagrees with the DEM by metres on a
 * slope, so the crossing is marched against the DEM instead (see `axisCrossing`).
 *
 * Returns whether a crossing was found; without one (a view of nothing but sky and
 * horizon) the current elevation plane is kept, which changes nothing.
 */
export function settle(map: MapLibreMap): boolean {
  if (!map.terrain) return false;
  const tr = map._camera.transform;
  const pose: Pose = {
    camera: tr.getCameraLngLat(),
    altitude: tr.getCameraAltitude(),
    bearing: tr.bearing,
    pitch: tr.pitch,
  };
  const mercatorPerMetre = MercatorCoordinate.fromLngLat(pose.camera).meterInMercatorCoordinateUnits();

  const crossed = axisCrossing(map, mercatorPerMetre, pose, tr.tileZoom);
  let distance = crossed ?? distanceToPlane(pose, tr.elevation);
  // The pin will sample at whatever tile zoom the new distance implies. Where that is
  // not the one the march used, it is reading a different DEM level, and the camera
  // keeps the difference — a few metres of it. Marching again at that level closes it.
  const settled = Math.max(0, Math.floor(zoomFor(map, mercatorPerMetre, distance)));
  if (settled !== tr.tileZoom) {
    distance = axisCrossing(map, mercatorPerMetre, pose, settled) ?? distance;
  }
  applyPose(map, mercatorPerMetre, pose, distance);
  return crossed !== null;
}

export type CameraAnchor = {
  /** Pause settling while a gesture owns the camera. Every suspend needs a resume. */
  suspend(): void;
  /** Settle the camera and let movement-end settling run again. */
  resume(): void;
  disable(): void;
};

export function enableCameraAnchor(map: MapLibreMap): CameraAnchor {
  let suspended = 0;
  let busy = false;

  /** Settling calls jumpTo, and jumpTo fires moveend synchronously — never re-enter. */
  const run = (fn: () => void): void => {
    if (busy) return;
    busy = true;
    try {
      fn();
    } finally {
      busy = false;
    }
  };

  /**
   * The camera restored from the hash sits on elevation 0 — in the Alps, inside a
   * mountain — and the hash carries no elevation to fix that with. Until the user first
   * moves, each arriving terrain tile re-anchors the centre to the ground the way the
   * pin used to, so the saved zoom keeps meaning what it meant when it was written.
   */
  const trackLoad = (e: MapSourceDataEvent): void => {
    if (e.sourceId !== DEM_SOURCE || !e.tile) return;
    run(() => {
      const tr = map._camera.transform;
      const ground = map.terrain?.getElevationForLngLatZoom(tr.center, tr.tileZoom);
      if (ground !== undefined && Number.isFinite(ground)) map.jumpTo({ elevation: ground });
    });
  };
  const stopTracking = (): void => {
    map.off('sourcedata', trackLoad);
  };

  const onMoveEnd = (): void => {
    if (busy || suspended > 0) return;
    stopTracking();
    run(() => settle(map));
  };

  /** The view has loaded as deep as it goes: anchor once more, exactly, and let go. */
  const onIdle = (): void => {
    stopTracking();
    if (suspended === 0) run(() => settle(map));
  };

  /** Exaggeration and style changes move the terrain under a camera that should not move. */
  const onTerrain = (): void => {
    if (suspended === 0) run(() => settle(map));
  };

  map.on('sourcedata', trackLoad);
  map.once('idle', onIdle);
  map.on('moveend', onMoveEnd);
  map.on('terrain', onTerrain);

  return {
    suspend: () => {
      suspended += 1;
    },
    resume: () => {
      suspended -= 1;
      if (suspended === 0) {
        stopTracking();
        run(() => settle(map));
      }
    },
    disable: () => {
      stopTracking();
      map.off('moveend', onMoveEnd);
      map.off('terrain', onTerrain);
      map.off('idle', onIdle);
    },
  };
}
