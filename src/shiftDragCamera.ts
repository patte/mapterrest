import { MercatorCoordinate, Point, type MapLibreMap } from 'maplibre-gl';

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
 * How far ahead the centre is allowed to sit. The centre is where the view axis meets
 * the gesture's elevation plane, which runs to infinity as the camera comes level; past
 * this the distance stops growing and the plane rises to meet it instead. MapLibre's own
 * maths gives up in the same place, at |cos(pitch)| < 0.1, and pins 10 km ahead.
 */
const MAX_CENTRE_DISTANCE = 10000;

/**
 * As far as the gesture will tilt, whatever the map's own maxPitch allows. A camera this
 * near level has no honest centre: MapLibre's model puts it where the axis meets the
 * ground, which for a level camera is nowhere, and the elevation it then pins the centre
 * to drags the camera a kilometre down to meet it. The last few degrees before flat are
 * left to the built-in gestures, which land in the same place but are not pretending to
 * hold anything still. A drag that starts up there can still tilt back down.
 */
const MAX_GESTURE_PITCH = 85;

const DEG = Math.PI / 180;

/** East, north, up in metres. */
type Vec3 = [number, number, number];

/** The camera's basis vectors, in metres east/north/up. Pitch is measured from straight down. */
function cameraFrame(bearing: number, pitch: number): { right: Vec3; up: Vec3; forward: Vec3 } {
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

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

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
/** The ground under a pixel, or null if that pixel is sky. */
const raycast = (map: MapLibreMap, x: number, y: number): MercatorCoordinate | null =>
  // z is the elevation in metres on what comes back, not a mercator z — toAltitude()
  // would be nonsense.
  map.terrain?.pointCoordinate(new Point(x, y)) ?? null;

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

type Pose = {
  camera: { lng: number; lat: number };
  altitude: number;
  bearing: number;
  pitch: number;
};

/** A point along the view axis: where it is on the ground, and how high the axis is there. */
function axisAt(o: Orbit, pose: Pose, distance: number) {
  const frame = cameraFrame(pose.bearing, pose.pitch);
  const cameraMercator = MercatorCoordinate.fromLngLat(pose.camera);
  return {
    distance,
    elevation: pose.altitude + frame.forward[2] * distance,
    centre: new MercatorCoordinate(
      cameraMercator.x + frame.forward[0] * distance * o.mercatorPerMetre,
      cameraMercator.y - frame.forward[1] * distance * o.mercatorPerMetre,
    ).toLngLat(),
  };
}

/** How far along the axis a given horizontal plane is. */
function distanceToPlane(pose: Pose, plane: number): number {
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
 * camera, which is the drop felt on letting go.
 *
 * Marched rather than solved. Stepping the plane toward the terrain and re-solving
 * diverges wherever the ground is steeper than the axis, which in the Alps is most of it:
 * one pass moved the plane 100 m the wrong way and left the pin 268 m to take back.
 * Steps grow geometrically, since the DEM coarsens with distance too.
 */
function axisCrossing(map: MapLibreMap, o: Orbit, pose: Pose, zoom: number): number | null {
  const clearance = (distance: number): number | null => {
    const at = axisAt(o, pose, distance);
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

/**
 * Put the camera where the gesture wants it, written the way MapLibre stores a camera: a
 * centre on the view axis, the elevation of the plane that centre sits on, and a zoom
 * that is really the distance to it.
 *
 * `calculateCameraOptionsFromCameraLngLatAltRotation` will do this too, but only against
 * the plane the centre is on at the time, and in the mountains that plane is often a
 * hair below the camera — at 46.086, 7.712 the camera flies 22 m over a wall the 1.4×
 * exaggeration has pushed up to 5199 m. The distance to the plane is that gap over
 * cos(pitch), so it collapses, and the zoom expressing it jumps to z18 on a z14 view,
 * taking the tile LOD with it. Naming the plane keeps the distance well behaved: the
 * gesture holds its own, so zoom stays put through a turn and slides evenly through a
 * tilt.
 */
/** The zoom that puts the centre this far down the axis. */
const zoomFor = (map: MapLibreMap, o: Orbit, distance: number): number => {
  const tr = map._camera.transform;
  return Math.log2(tr.cameraToCenterDistance / (distance * o.mercatorPerMetre) / tr.tileSize);
};

function applyPose(map: MapLibreMap, o: Orbit, pose: Pose, distance: number): void {
  const { centre, elevation } = axisAt(o, pose, distance);
  map.jumpTo({
    center: centre,
    elevation,
    zoom: zoomFor(map, o, distance),
    bearing: pose.bearing,
    pitch: pose.pitch,
    // roll is passed explicitly: jumpTo tests `'roll' in options`, so leaving it off
    // would set a roll of NaN.
    roll: 0,
  });
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

  const pose: Pose = { camera, altitude: o.pivot.elevation + axis(2), bearing, pitch };
  applyPose(map, o, pose, distanceToPlane(pose, o.planeElevation));
}

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

export function enableShiftDragCamera(map: MapLibreMap): () => void {
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
   * Hand the camera back in the terms MapLibre keeps it in: the centre on the terrain the
   * view axis actually meets. Every rendered frame it pins the centre's elevation to the
   * terrain under it, moving the camera by whatever the difference has become — over a
   * kilometre after a tilt in the Alps — so the gesture ends by making that difference
   * nothing: the centre goes where the axis meets the terrain, which is a point on the
   * axis, so adopting it moves no pixel, and its elevation is the one the pin will read.
   */
  const release = (): void => {
    if (!pivot) return;
    const orbited = pivot;
    pivot = null;
    camera.elevationFreeze = false;

    const tr = camera.transform;
    const pose: Pose = {
      camera: tr.getCameraLngLat(),
      altitude: tr.getCameraAltitude(),
      bearing: tr.bearing,
      pitch: tr.pitch,
    };

    const fallback = distanceToPlane(pose, orbited.planeElevation);
    let distance = axisCrossing(map, orbited, pose, tr.tileZoom) ?? fallback;
    // The pin will sample at whatever tile zoom the new distance implies. Where that is
    // not the one the march used, it is reading a different DEM level, and the camera
    // keeps the difference — a few metres of it. Marching again at that level closes it.
    const settled = Math.max(0, Math.floor(zoomFor(map, orbited, distance)));
    if (settled !== tr.tileZoom) {
      distance = axisCrossing(map, orbited, pose, settled) ?? distance;
    }
    applyPose(map, orbited, pose, distance);
  };

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
    release();
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
    // Every rendered frame MapLibre drops the centre onto the terrain
    // (`setElevation` at the centre), which slides the camera vertically with it. The
    // orbit moves the centre a long way, so that correction is large and lands as a
    // jump the moment the last frame stops overwriting it. Freeze it for the gesture,
    // as MapLibre's own terrain gestures do.
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
