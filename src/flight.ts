import { MercatorCoordinate, type MapLibreMap } from 'maplibre-gl';
import { applyPose, cameraFrame, distanceToPlane, type CameraAnchor, type Pose } from './cameraAnchor';
import { MIN_GROUND_CLEARANCE, orbit, orbitAbout, type Orbit } from './orbit';
import { choosePivot, type Pivot } from './pivot';

/**
 * Two self-driving camera moves behind the buttons beside the magnifier, each a toggle:
 *
 * - forward: the camera slides ahead along its bearing at constant altitude, like an
 *   aircraft in level flight. Pitch is where the passenger looks, not the direction of
 *   travel, so it stays put; the ground ahead rising into the camera lifts it (and it
 *   never comes back down — an aircraft, not a terrain-follower).
 * - orbit: a slow turn about the subject of the frame, the same pivot and the same rigid
 *   turn as shift+drag. Every stop reverses it — the arrow shows which way the next one
 *   goes — so a second press swings back through what the first one showed.
 *
 * Either flies in legs. A camera rewritten every frame never gives the map a still
 * moment: tiles keep arriving for a view already gone, the anchor never settles the
 * centre onto the terrain, the LOD never catches up. So after each leg the flight holds
 * still, hands the camera back to the anchor, waits for the map to go idle, and takes off
 * again from wherever that left the camera. Each leg eases out into the still moment and
 * back in out of it, so it reads as a breath rather than a stutter.
 *
 * Starting one stops the other. The user's hand does not stop a flight, it yields to it:
 * input on the map — mouse, wheel, touch, keys — and any camera move that is not the
 * flight's own (a search flight, a resize) pause it, and once the hand is off the map and
 * it has been quiet for a moment the flight takes off again from the camera the user
 * left, with a fresh heading, speed and pivot. The input has to be caught raw: every
 * jumpTo of the flight resets MapLibre's gesture handlers, so a drag never gets far
 * enough to fire `movestart` on its own.
 */

export const FLIGHT_MODES = ['forward', 'orbit'] as const;
export type FlightMode = (typeof FLIGHT_MODES)[number];
/** +1 clockwise, -1 counter-clockwise. */
export type Spin = 1 | -1;

export type Flight = {
  /** Start the mode, or stop it if it is the one running. */
  toggle(mode: FlightMode): void;
  /** Run this mode, or none; a no-op when it already does. */
  set(mode: FlightMode | null): void;
  stop(): void;
  readonly mode: FlightMode | null;
  /** The flight is in the air right now: not holding still between legs or for a gesture. */
  readonly flying: boolean;
  /** Which way the next orbit turns: +1 clockwise, -1 counter-clockwise. */
  readonly spin: Spin;
  setSpin(spin: Spin): void;
  disable(): void;
};

/**
 * Forward speed as a fraction of the camera's height over the ground per second, fixed
 * at takeoff: what reads as slow is the ground going by, and the ground goes by in
 * proportion to how far below it is. 2.2 km up over Zermatt that is 220 m/s, an airliner;
 * a few metres over a path it is a walk.
 */
const FORWARD_RATE = 0.1;
const MIN_SPEED = 2;
const MAX_SPEED = 1500;

/** Degrees per second; two minutes for a full circle. */
const ORBIT_RATE = 3;

/** A background tab hands back one huge frame; the flight should not leap by it. */
const MAX_FRAME_S = 0.1;
/**
 * The camera is rewritten at most this often — about 30 Hz on a 60 Hz display. Every
 * rewrite is a full re-render; at half the display's rate the motion still reads as
 * smooth and the map gets every other frame to itself.
 */
const MIN_FRAME_MS = 30;

/** Seconds of motion between the still moments. */
const LEG_S = 10;
/** Seconds a leg takes to reach speed, and to come to rest. */
const RAMP_S = 1;
/** The still moment ends when the map goes idle, or here, whichever first. */
const IDLE_TIMEOUT_MS = 1000;

/** 0 at rest to 1 at speed, cosine-smooth, over the ramp either end of a leg. */
const gainAt = (sinceStart: number, untilEnd: number): number => {
  const x = Math.min(sinceStart, untilEnd) / RAMP_S;
  return x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2;
};
/** How long the map has to be left alone before a yielded flight takes off again. */
const RESUME_DELAY_MS = 1000;

/** Fixed at takeoff for the whole flight. */
type Forward = { bearing: number; pitch: number; speed: number };
/** Re-read from the camera at the start of every leg. */
type Leg = {
  camera: MercatorCoordinate;
  altitude: number;
  mercatorPerMetre: number;
  /** The plane the centre rides on, held for the leg. See `applyPose`. */
  planeElevation: number;
};

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/**
 * @param anchor null when `#pivot=0` hands the camera to MapLibre; the flight then has
 *   no ground to hold and turns about the map centre.
 * @param onChange called with the mode and the next orbit's spin whenever either
 *   changes, however it changed.
 * @param onPivot called with the pivot an orbit turns about, and null when it lets go.
 */
export function enableFlight(
  map: MapLibreMap,
  anchor: CameraAnchor | null,
  onChange?: (mode: FlightMode | null, spin: Spin) => void,
  onPivot?: (pivot: Pivot | null) => void,
): Flight {
  const camera = map._camera;
  const container = map.getCanvasContainer();
  const forwardButton = document.getElementById('flight-forward') as HTMLButtonElement;
  const orbitButton = document.getElementById('flight-orbit') as HTMLButtonElement;

  let mode: FlightMode | null = null;
  let frame = 0;
  let last = 0;
  /** The leg in progress; past its end the flight holds still. */
  let legStart = 0;
  let legEnd = 0;
  /** Set around the flight's own jumpTo so its movestart is not mistaken for a gesture. */
  let applying = false;
  /** Whether the flight holds the anchor and the elevation plane right now. */
  let holding = false;
  /** Cancels a wait for the map to go idle, if one is pending. */
  let cancelIdleWait: (() => void) | null = null;

  /** The user has the map: paused until the hand is off it and it has been quiet. */
  let yielded = false;
  let pointerDown = false;
  let quietTimer = 0;

  let forward: Forward | null = null;
  let leg: Leg | null = null;
  /** The point an orbit turns about, kept across legs. */
  let pivot: Pivot | null = null;
  let turn: Orbit | null = null;
  let turnBearing = 0;
  let turnPitch = 0;
  /** The next orbit's direction. */
  let spin: Spin = 1;

  const paint = (): void => {
    forwardButton.setAttribute('aria-pressed', String(mode === 'forward'));
    orbitButton.setAttribute('aria-pressed', String(mode === 'orbit'));
    orbitButton.dataset.spin = spin === 1 ? 'cw' : 'ccw';
  };

  const write = (fn: () => void): void => {
    applying = true;
    try {
      fn();
    } finally {
      applying = false;
    }
  };

  /**
   * The flight's own jumpTo fires moveend every frame; the anchor settling against those
   * would fight it. And the flight names the elevation plane itself, so MapLibre's other
   * elevation writers are held off as for shift+drag.
   */
  const hold = (): void => {
    if (holding) return;
    holding = true;
    anchor?.suspend();
    camera.elevationFreeze = true;
  };

  /**
   * Resuming settles the camera in the terms MapLibre keeps it in — the centre on the
   * terrain the view axis actually meets.
   */
  const release = (): void => {
    if (!holding) return;
    holding = false;
    camera.elevationFreeze = false;
    write(() => anchor?.resume());
  };

  /**
   * Run `fn` once the map has nothing left to load or draw. A map that is idle already
   * fires no further 'idle' until something renders, so that case runs at once.
   */
  const whenIdle = (fn: () => void): void => {
    cancelIdleWait?.();
    if (!map.isMoving() && map.loaded() && map.areTilesLoaded()) {
      fn();
      return;
    }
    const go = (): void => {
      cancelIdleWait?.();
      fn();
    };
    const timer = window.setTimeout(go, IDLE_TIMEOUT_MS);
    map.once('idle', go);
    cancelIdleWait = () => {
      cancelIdleWait = null;
      clearTimeout(timer);
      map.off('idle', go);
    };
  };

  const flyForward = (dt: number): void => {
    const f = forward!;
    const l = leg!;
    // Level: the bearing's ground direction, whatever the pitch.
    const ahead = cameraFrame(f.bearing, 90).forward;
    const step = f.speed * dt * l.mercatorPerMetre;
    l.camera = new MercatorCoordinate(l.camera.x + ahead[0] * step, l.camera.y - ahead[1] * step);
    const at = l.camera.toLngLat();
    const ground = map.terrain?.getElevationForLngLatZoom(at, camera.transform.tileZoom);
    if (ground !== undefined) l.altitude = Math.max(l.altitude, ground + MIN_GROUND_CLEARANCE);
    const pose: Pose = { camera: at, altitude: l.altitude, bearing: f.bearing, pitch: f.pitch };
    applyPose(map, l.mercatorPerMetre, pose, distanceToPlane(pose, l.planeElevation));
  };

  const tick = (now: number): void => {
    if (now >= legEnd) {
      land();
      whenIdle(takeOff);
      return;
    }
    frame = requestAnimationFrame(tick);
    if (now - last < MIN_FRAME_MS) return;
    const dt =
      Math.min((now - last) / 1000, MAX_FRAME_S) * gainAt((now - legStart) / 1000, (legEnd - now) / 1000);
    last = now;
    write(() => {
      if (mode === 'forward') flyForward(dt);
      else if (mode === 'orbit') {
        turnBearing += spin * ORBIT_RATE * dt;
        if (turn) orbit(map, turn, turnBearing, turnPitch);
        else map.jumpTo({ bearing: turnBearing });
      }
    });
  };

  /** Start a leg from the camera as it stands. Speed and pivot carry over from the last one. */
  const takeOff = (): void => {
    const tr = camera.transform;
    if (mode === 'forward') {
      const at = MercatorCoordinate.fromLngLat(tr.getCameraLngLat());
      leg = {
        camera: at,
        altitude: tr.getCameraAltitude(),
        mercatorPerMetre: at.meterInMercatorCoordinateUnits(),
        planeElevation: tr.elevation,
      };
    } else {
      turn = pivot && orbitAbout(map, pivot.point);
      turnBearing = tr.bearing;
      turnPitch = tr.pitch;
    }
    hold();
    last = performance.now();
    legStart = last;
    legEnd = last + LEG_S * 1000;
    frame = requestAnimationFrame(tick);
  };

  /** Hold still: no more frames, the camera back with the anchor. */
  const land = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
    cancelIdleWait?.();
    release();
  };

  /** Heading, speed and pivot from the camera as it stands, then the first leg. */
  const launch = (): void => {
    const tr = camera.transform;
    if (mode === 'forward') {
      const at = tr.getCameraLngLat();
      const altitude = tr.getCameraAltitude();
      const ground = map.terrain?.getElevationForLngLatZoom(at, tr.tileZoom) ?? 0;
      forward = {
        bearing: tr.bearing,
        pitch: tr.pitch,
        speed: clamp((altitude - ground) * FORWARD_RATE, MIN_SPEED, MAX_SPEED),
      };
    } else {
      pivot = anchor ? choosePivot(map) : null;
      onPivot?.(pivot);
    }
    takeOff();
  };

  const stop = (): void => {
    if (!mode) return;
    if (mode === 'orbit') spin = spin === 1 ? -1 : 1;
    mode = null;
    land();
    clearTimeout(quietTimer);
    quietTimer = 0;
    yielded = false;
    forward = null;
    leg = null;
    if (pivot) onPivot?.(null);
    pivot = null;
    turn = null;
    paint();
    onChange?.(null, spin);
  };

  const start = (next: FlightMode): void => {
    stop();
    mode = next;
    paint();
    onChange?.(next, spin);
    launch();
  };

  const set = (next: FlightMode | null): void => {
    if (mode === next) return;
    if (next) start(next);
    else stop();
  };
  const toggle = (next: FlightMode): void => set(mode === next ? null : next);

  /* The user's hand ------------------------------------------------------------ */

  const resume = (): void => {
    quietTimer = 0;
    if (!mode || !yielded || pointerDown) return;
    whenIdle(() => {
      if (!mode || !yielded || pointerDown || quietTimer) return;
      yielded = false;
      launch();
    });
  };

  /** Something other than the flight touched the map: yield, and restart the quiet clock. */
  const touched = (): void => {
    if (!mode) return;
    if (!yielded) {
      yielded = true;
      land();
    }
    clearTimeout(quietTimer);
    quietTimer = window.setTimeout(resume, RESUME_DELAY_MS);
  };

  const onMove = (): void => {
    if (!applying) touched();
  };
  const onPointerDown = (): void => {
    pointerDown = true;
    touched();
  };
  const onPointerUp = (e: MouseEvent | TouchEvent): void => {
    if (!pointerDown) return;
    if ('touches' in e && e.touches.length > 0) return;
    pointerDown = false;
    touched();
  };

  map.on('movestart', onMove);
  map.on('move', onMove);
  container.addEventListener('mousedown', onPointerDown, { capture: true, passive: true });
  container.addEventListener('touchstart', onPointerDown, { capture: true, passive: true });
  container.addEventListener('wheel', touched, { capture: true, passive: true });
  container.addEventListener('keydown', touched, { capture: true, passive: true });
  window.addEventListener('mouseup', onPointerUp, true);
  window.addEventListener('touchend', onPointerUp, true);
  window.addEventListener('touchcancel', onPointerUp, true);
  forwardButton.addEventListener('click', () => toggle('forward'));
  orbitButton.addEventListener('click', () => toggle('orbit'));

  return {
    toggle,
    set,
    stop,
    get mode() {
      return mode;
    },
    get flying() {
      return frame !== 0;
    },
    get spin() {
      return spin;
    },
    setSpin: (next: Spin) => {
      if (spin === next) return;
      spin = next;
      paint();
      onChange?.(mode, spin);
    },
    disable: () => {
      stop();
      map.off('movestart', onMove);
      map.off('move', onMove);
      container.removeEventListener('mousedown', onPointerDown, true);
      container.removeEventListener('touchstart', onPointerDown, true);
      container.removeEventListener('wheel', touched, true);
      container.removeEventListener('keydown', touched, true);
      window.removeEventListener('mouseup', onPointerUp, true);
      window.removeEventListener('touchend', onPointerUp, true);
      window.removeEventListener('touchcancel', onPointerUp, true);
    },
  };
}
