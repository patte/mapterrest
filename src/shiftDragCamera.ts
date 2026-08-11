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
 * Past this the camera maths MapLibre derives a centre and zoom with degenerates: both
 * `calculateCenterFromCameraLngLatAlt` and `recalculateZoomAndCenter` give up once
 * |cos(pitch)| < 0.1 (84.3°) and pin the centre 10 km ahead, which pins the zoom — and
 * with it the tile LOD — whatever the view was showing. Tilting past this hands the
 * camera back and finishes the drag turning about the centre, as everything did before.
 */
const ORBIT_MAX_PITCH = 82;

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
function grabPivot(map: MapLibreMap): Orbit | null {
  const tr = map._camera.transform;
  for (const fraction of PIVOT_ANCHORS) {
    // z is the elevation in metres here, not a mercator z — toAltitude() would be nonsense.
    const hit = map.terrain?.pointCoordinate(new Point(tr.width / 2, tr.height * fraction));
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
  const altitude = o.pivot.elevation + axis(2);

  // roll is passed explicitly: jumpTo tests `'roll' in options`, so leaving it off the
  // camera options would set a roll of NaN.
  map.jumpTo(
    map.calculateCameraOptionsFromCameraLngLatAltRotation(camera, altitude, bearing, pitch, 0),
  );
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
   * Hand the camera back on MapLibre's terms: same camera position, centre back on the
   * terrain, zoom recomputed to match. This is the documented partner to
   * elevationFreeze, and it leaves the view exactly where the orbit left it.
   */
  const release = (): void => {
    if (!pivot) return;
    pivot = null;
    camera.elevationFreeze = false;
    camera.transform.recalculateZoomAndCenter(map.terrain);
  };

  /**
   * Angles come from the total drag rather than the last increment, so nothing
   * accumulates over a long gesture and the pivot stays exact.
   */
  const apply = (): void => {
    frame = 0;
    const bearing = startBearing + dx * ROTATE_SPEED;
    const pitch = startPitch - dy * PITCH_SPEED;
    // Released before the new pitch is applied, so the handover happens while the
    // camera maths still works.
    if (pitch > ORBIT_MAX_PITCH) release();
    if (pivot) orbit(map, pivot, bearing, pitch);
    else map.jumpTo({ bearing, pitch });
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    dx = e.clientX - startX;
    // Clamping the drag rather than the pitch it produces: clamping the angle alone
    // would leave a dead zone on the way back off the limit.
    dy = clamp(
      e.clientY - startY,
      (startPitch - map.getMaxPitch()) / PITCH_SPEED,
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
    pivot = startPitch > ORBIT_MAX_PITCH ? null : grabPivot(map);
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
