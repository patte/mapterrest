import type { MapLibreMap } from 'maplibre-gl';

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
 */

/** Matches MapLibre's own rotateSpeed/pitchSpeed so both gestures feel identical. */
const ROTATE_SPEED = 0.8;
const PITCH_SPEED = 0.5;

export function enableShiftDragCamera(map: MapLibreMap): () => void {
  const container = map.getCanvasContainer();
  map.boxZoom.disable();

  let lastX = 0;
  let lastY = 0;
  let dragging = false;

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // Dragging up tilts towards the horizon, matching MapLibre's negative pitchSpeed.
    const pitch = map.getPitch() - dy * PITCH_SPEED;
    map.jumpTo({
      bearing: map.getBearing() + dx * ROTATE_SPEED,
      pitch: Math.min(Math.max(pitch, map.getMinPitch()), map.getMaxPitch()),
    });
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    container.style.cursor = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', stop);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!e.shiftKey || e.button !== 0) return;
    if (!(e.target instanceof Node) || !container.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
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
