import { MercatorCoordinate, type MapLibreMap } from 'maplibre-gl';
import { applyPose, cameraFrame, distanceToPlane, dot, type Pose, type Vec3 } from './cameraAnchor';
import type { PivotPoint } from './pivot';

/**
 * Turning the camera rigidly about a point on the terrain — the maths under the
 * shift+drag gesture and the orbit button. Which point, and why not the map centre, is
 * [pivot.ts](pivot.ts).
 */

/**
 * How far above the ground under it the camera is kept. Turning about a pivot in front
 * swings the camera through whatever is behind, and at z15.6 on a valley side that is
 * 700 m inside the mountain — the near plane ends up under the surface and the frame
 * fills with the inside of the terrain. MapLibre lifts a buried camera itself, in
 * `_elevateCameraIfInsideTerrain`, but by rewriting pitch and zoom, which the next frame
 * of the gesture overwrites. Lifting it here instead costs the pivot its exact hold —
 * the alternative is flying through rock.
 */
export const MIN_GROUND_CLEARANCE = 20;

/** Everything a turn needs to rebuild the camera, frozen when it starts. */
export type Orbit = {
  pivot: PivotPoint;
  mercatorPerMetre: number;
  /** The camera's offset from the pivot, in the camera's own basis. */
  offset: { right: number; up: number; forward: number };
  /** The plane the centre rides on, held for the turn. See `applyPose`. */
  planeElevation: number;
};

/**
 * Freeze the camera's position relative to the pivot, in the camera's own basis. Turning
 * is then a matter of rebuilding that offset in a new basis.
 *
 * MapLibre keeps `transform.center` on the horizontal plane at the centre's elevation,
 * not on the terrain, so at high pitch it lies well beyond the ridge the frame is
 * actually showing — 11.8 km out over Zermatt against 9.5 km for the visible ground.
 * Turning about the far point drags the whole frame with it; turning about the point
 * `choosePivot` returns holds it still to under a pixel through a 30° swing.
 */
export function orbitAbout(map: MapLibreMap, point: PivotPoint): Orbit {
  const tr = map._camera.transform;
  const mercatorPerMetre = new MercatorCoordinate(
    point.x,
    point.y,
  ).meterInMercatorCoordinateUnits();
  const cameraMercator = MercatorCoordinate.fromLngLat(tr.getCameraLngLat());
  const offset: Vec3 = [
    (cameraMercator.x - point.x) / mercatorPerMetre,
    -(cameraMercator.y - point.y) / mercatorPerMetre,
    tr.getCameraAltitude() - point.elevation,
  ];
  const frame = cameraFrame(tr.bearing, tr.pitch);
  return {
    pivot: point,
    mercatorPerMetre,
    offset: {
      right: dot(offset, frame.right),
      up: dot(offset, frame.up),
      forward: dot(offset, frame.forward),
    },
    planeElevation: tr.elevation,
  };
}

/**
 * Rotate the camera rigidly about the pivot. Rebuilding the frozen offset in the new
 * basis keeps both the distance to the pivot and its angular position, so the pivot
 * holds the same pixel and the same apparent size however far the turn goes.
 */
export function orbit(map: MapLibreMap, o: Orbit, bearing: number, pitch: number): void {
  const frame = cameraFrame(bearing, pitch);
  const axis = (k: 0 | 1 | 2): number =>
    o.offset.right * frame.right[k] + o.offset.up * frame.up[k] + o.offset.forward * frame.forward[k];

  const camera = new MercatorCoordinate(
    o.pivot.x + axis(0) * o.mercatorPerMetre,
    o.pivot.y - axis(1) * o.mercatorPerMetre,
  ).toLngLat();

  const ground = map.terrain?.getElevationForLngLatZoom(camera, map._camera.transform.tileZoom);
  const altitude = Math.max(
    o.pivot.elevation + axis(2),
    ground === undefined ? -Infinity : ground + MIN_GROUND_CLEARANCE,
  );

  const pose: Pose = { camera, altitude, bearing, pitch };
  applyPose(map, o.mercatorPerMetre, pose, distanceToPlane(pose, o.planeElevation));
}
