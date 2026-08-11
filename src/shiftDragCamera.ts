import { MercatorCoordinate, Point, type MapLibreMap } from 'maplibre-gl';
import {
  applyPose,
  cameraFrame,
  distanceToPlane,
  dot,
  type CameraAnchor,
  type Pose,
  type Vec3,
} from './cameraAnchor';

/**
 * Google-Maps-style camera control: hold Shift and drag to rotate (horizontal)
 * and tilt (vertical).
 *
 * MapLibre bakes its modifier check into MouseMoveStateManager
 * (`LEFT && ctrlKey || RIGHT`) with no option to change it, so this is a separate
 * handler rather than a reconfiguration. It listens on the document in the capture
 * phase and stops propagation, so MapLibre's own drag handlers never see the
 * gesture and the map does not pan at the same time.
 *
 * Shift+drag is MapLibre's box-zoom gesture by default; that is given up for this.
 *
 * The camera orbits the terrain the gesture grabbed rather than the map centre. See
 * `grabPivot` for why that matters in the mountains.
 *
 * Some of what that needs is off MapLibre's public surface: the transform moved to
 * `map._camera` in 6.x, and the elevation freeze lives there with it. Both are typed, so
 * a version that moves them fails `pnpm typecheck` rather than the map.
 */

/**
 * Halved from MapLibre's own rotateSpeed/pitchSpeed. The orbit below already takes
 * roughly a factor of two out of how far a drag throws the frame, and these carry the
 * rest: a 10° turn moves the view 58 px where rotating about the centre moved it 164.
 */
const ROTATE_SPEED = 0.4;
const PITCH_SPEED = 0.25;

/**
 * Fractions of the viewport height to look for a pivot at, first hit wins. Below the
 * centre is nearer, and a nearer pivot is a tighter turn — over Zermatt at pitch 78 the
 * centre pixel sits on terrain 9.5 km out and 0.65 of the way down on terrain 7.3 km
 * out. The later entries only come into play when the middle of the frame is sky.
 */
const PIVOT_ANCHORS = [0.65, 0.8, 0.5, 0.92];

/**
 * As far as the gesture will tilt, whatever the map's own maxPitch allows. A camera this
 * near level has no honest centre: MapLibre's model puts it where the axis meets the
 * ground, which for a level camera is nowhere, and the elevation it then pins the centre
 * to drags the camera a kilometre down to meet it. The last few degrees before flat are
 * left to the built-in gestures, which land in the same place but are not pretending to
 * hold anything still. A drag that starts up there can still tilt back down.
 */
const MAX_GESTURE_PITCH = 85;

/**
 * How far above the ground under it the camera is kept. Turning about a pivot in front
 * swings the camera through whatever is behind, and at z15.6 on a valley side that is
 * 700 m inside the mountain — the near plane ends up under the surface and the frame
 * fills with the inside of the terrain. MapLibre lifts a buried camera itself, in
 * `_elevateCameraIfInsideTerrain`, but by rewriting pitch and zoom, which the next frame
 * of the gesture overwrites. Lifting it here instead costs the pivot its exact hold —
 * the alternative is flying through rock.
 */
const MIN_GROUND_CLEARANCE = 20;

/** Everything the gesture needs to rebuild the camera, frozen at mousedown. */
type Orbit = {
  /** Mercator x/y of the pivot, and its elevation in metres. */
  pivot: { x: number; y: number; elevation: number };
  mercatorPerMetre: number;
  /** The camera's offset from the pivot, in the camera's own basis. */
  offset: { right: number; up: number; forward: number };
  /** The plane the centre rides on, held for the gesture. See `applyPose`. */
  planeElevation: number;
};

/** The ground under a pixel, or null if that pixel is sky. */
const raycast = (map: MapLibreMap, x: number, y: number): MercatorCoordinate | null =>
  // z is the elevation in metres on what comes back, not a mercator z — toAltitude()
  // would be nonsense.
  map.terrain?.pointCoordinate(new Point(x, y)) ?? null;

/**
 * The terrain point the gesture turns around, found by raycasting the frame.
 *
 * MapLibre keeps `transform.center` on the horizontal plane at the centre's elevation,
 * not on the terrain, so at high pitch it lies well beyond the ridge the frame is
 * actually showing — 11.8 km out over Zermatt against 9.5 km for the visible ground.
 * Turning about the far point drags the whole frame with it. `pointCoordinate` reads
 * MapLibre's coords framebuffer for the ground under a pixel, which is the near point,
 * and orbiting that holds it still to under a pixel through a 30° swing.
 *
 * The readback is a GPU stall, so it happens once per gesture rather than once per frame.
 */
function grabPivot(map: MapLibreMap): Orbit | null {
  const tr = map._camera.transform;
  for (const fraction of PIVOT_ANCHORS) {
    const hit = raycast(map, tr.width / 2, tr.height * fraction);
    if (!hit) continue;

    const mercatorPerMetre = new MercatorCoordinate(hit.x, hit.y).meterInMercatorCoordinateUnits();
    const camera = tr.getCameraLngLat();
    const cameraMercator = MercatorCoordinate.fromLngLat(camera);
    const offset: Vec3 = [
      (cameraMercator.x - hit.x) / mercatorPerMetre,
      -(cameraMercator.y - hit.y) / mercatorPerMetre,
      tr.getCameraAltitude() - hit.z,
    ];
    const frame = cameraFrame(tr.bearing, tr.pitch);
    return {
      pivot: { x: hit.x, y: hit.y, elevation: hit.z },
      mercatorPerMetre,
      offset: {
        right: dot(offset, frame.right),
        up: dot(offset, frame.up),
        forward: dot(offset, frame.forward),
      },
      planeElevation: tr.elevation,
    };
  }
  return null;
}

/**
 * Rotate the camera rigidly about the pivot. Rebuilding the frozen offset in the new
 * basis keeps both the distance to the pivot and its angular position, so the pivot
 * holds the same pixel and the same apparent size however far the gesture goes.
 */
function orbit(map: MapLibreMap, o: Orbit, bearing: number, pitch: number): void {
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

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

export function enableShiftDragCamera(map: MapLibreMap, anchor: CameraAnchor): () => void {
  const container = map.getCanvasContainer();
  const camera = map._camera;
  map.boxZoom.disable();

  let dragging = false;
  let pivot: Orbit | null = null;
  let startX = 0;
  let startY = 0;
  let startBearing = 0;
  let startPitch = 0;
  let dx = 0;
  let dy = 0;
  let frame = 0;

  /**
   * Angles come from the total drag rather than the last increment, so nothing
   * accumulates over a long gesture and the pivot stays exact.
   */
  const apply = (): void => {
    frame = 0;
    const bearing = startBearing + dx * ROTATE_SPEED;
    const pitch = startPitch - dy * PITCH_SPEED;
    if (pivot) orbit(map, pivot, bearing, pitch);
    else map.jumpTo({ bearing, pitch });
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const maxPitch = Math.min(map.getMaxPitch(), Math.max(MAX_GESTURE_PITCH, startPitch));
    // Clamping the drag rather than the pitch it produces: clamping the angle alone
    // would leave a dead zone on the way back off the limit.
    dy = clamp(
      e.clientY - startY,
      (startPitch - maxPitch) / PITCH_SPEED,
      (startPitch - map.getMinPitch()) / PITCH_SPEED,
    );
    // One camera update per rendered frame; a trackpad reports moves faster than that.
    frame ||= requestAnimationFrame(apply);
  };

  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    if (frame) {
      cancelAnimationFrame(frame);
      apply();
    }
    pivot = null;
    camera.elevationFreeze = false;
    // Resuming settles the camera in the terms MapLibre keeps it in — the centre on the
    // terrain the view axis actually meets — so nothing is left for a later frame to
    // correct.
    anchor.resume();
    container.style.cursor = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stop);
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (!e.shiftKey || e.button !== 0) return;
    if (!(e.target instanceof Node) || !container.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startBearing = map.getBearing();
    startPitch = map.getPitch();
    dx = 0;
    dy = 0;
    pivot = grabPivot(map);
    // The gesture's own jumpTo fires moveend every frame; the anchor settling against
    // those would fight the orbit.
    anchor.suspend();
    // Hold off MapLibre's remaining elevation writers (terrain tile loads, easings) for
    // the gesture, as its own terrain gestures do — the orbit names the elevation plane
    // itself on every frame.
    if (pivot) camera.elevationFreeze = true;
    container.style.cursor = 'move';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', stop);
  };

  document.addEventListener('mousedown', onMouseDown, true);

  return () => {
    stop();
    document.removeEventListener('mousedown', onMouseDown, true);
    map.boxZoom.enable();
  };
}
