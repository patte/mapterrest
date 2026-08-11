import { type MapLibreMap } from 'maplibre-gl';
import {
  attentionTriangle,
  choosePivot,
  GRID_COLUMNS,
  projectPoint,
  type Pivot,
  type PivotSample,
} from './pivot';

/**
 * `#debugPivot=1`: draw what the shift+drag gesture would turn around, and the grid that
 * chose it. A tuning affordance for the attention shape in [pivot.ts](pivot.ts) — Google
 * shows nothing.
 *
 * Each hit is drawn at its own world position, sized by the weight it carried and
 * coloured by how its depth compares to the pivot's; the ones ringed in white are the
 * surface that won, and the crosshair is the point on it the gesture turns about. The
 * dashed triangle is where attention sits. During a gesture the hits swing with the camera
 * while the crosshair stays put, which is the property being tested.
 *
 * A solve marches 117 rays, so it happens when the camera comes to rest rather than per
 * frame. Drawing is plain arithmetic and runs every frame.
 */

/** Nearer than the pivot, at it, beyond it. Saturated, because most of this map is snow. */
const NEAR = [255, 88, 51];
const AT = [255, 209, 26];
const FAR = [56, 142, 255];
/** Depth ratio to the pivot, in octaves, that saturates the ramp: half as far, twice as far. */
const RAMP_OCTAVES = 1;

const formatDistance = (m: number): string =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;

function rampColor(depth: number, pivotDepth: number): string {
  const t = Math.max(-1, Math.min(1, Math.log2(depth / pivotDepth) / RAMP_OCTAVES));
  const end = t < 0 ? NEAR : FAR;
  const mix = AT.map((a, i) => Math.round(a + (end[i] - a) * Math.abs(t)));
  return `rgb(${mix.join(' ')})`;
}

export type PivotDebug = {
  /** Show the pivot a gesture is holding, or null to go back to solving on rest. */
  hold(pivot: Pivot | null): void;
  disable(): void;
};

export function enablePivotDebug(map: MapLibreMap): PivotDebug {
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  let pivot: Pivot | null = null;
  let held = false;
  let pending = 0;

  const dot = (x: number, y: number, radius: number, fill: string): void => {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };

  const drawSample = (s: PivotSample, pivotDepth: number): void => {
    if (!s.point || s.depth === null) {
      // Sky: nothing in the world to follow, so it is only drawn where it was cast from.
      if (held) return;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    const at = projectPoint(map, s.point);
    if (!at) return;
    // Weight is the say this sample had, read as size and solidity; the ring marks the
    // ones that belong to the surface it went to.
    const radius = 2.5 + 4.5 * s.weight;
    ctx.globalAlpha = s.chosen ? 1 : 0.4 + 0.3 * s.weight;
    dot(at.x, at.y, radius, rampColor(s.depth, pivotDepth));
    if (s.chosen) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const drawLabel = (x: number, y: number, lines: string[]): void => {
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const height = lines.length * 14 + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.66)';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#fff';
    lines.forEach((line, i) => ctx.fillText(line, x + 6, y + 5 + i * 14));
  };

  const draw = (): void => {
    const tr = map._camera.transform;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(tr.width * ratio)) {
      canvas.width = Math.round(tr.width * ratio);
      canvas.height = Math.round(tr.height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, tr.width, tr.height);
    if (!pivot) return;

    // The attention triangle, since its shape is now the thing worth tuning by eye.
    if (!held) {
      const corners = attentionTriangle(tr.width, tr.height);
      ctx.beginPath();
      corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const s of pivot.samples) drawSample(s, pivot.depth);

    const at = projectPoint(map, pivot.point);
    if (!at) return;
    ctx.beginPath();
    ctx.moveTo(at.x - 20, at.y);
    ctx.lineTo(at.x + 20, at.y);
    ctx.moveTo(at.x, at.y - 20);
    ctx.lineTo(at.x, at.y + 20);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    dot(at.x, at.y, 5, held ? '#ffd166' : '#fff');

    const hits = pivot.samples.filter((s) => s.point).length;
    const voted = pivot.samples.filter((s) => s.chosen).length;
    drawLabel(at.x + 18, at.y + 12, [
      `${pivot.from}${held ? ' · held' : ''} · ${formatDistance(pivot.depth)} ahead`,
      `${Math.round(pivot.point.elevation)} m · ${hits}/${pivot.samples.length} hits`,
      `surface ${voted} pts · ${Math.round(pivot.share * 100)}% of weight`,
    ]);
  };

  /**
   * The grid as a table, to paste out of the console. The overlay shows where the choice
   * landed; this shows what it was choosing between.
   */
  const report = (p: Pivot): void => {
    const tr = map._camera.transform;
    // Depth, elevation and weight, kept short enough that 13 columns still paste as a
    // readable grid. Elevation is what says whether a pivot at the right distance is on
    // the peak or in the valley below it.
    const cell = (s: PivotSample): string =>
      (s.depth === null || !s.point
        ? '·'
        : `${(s.depth / 1000).toFixed(1)}@${Math.round(s.point.elevation / 100)}/${s.weight
            .toFixed(2)
            .slice(1)}${s.chosen ? '*' : ''}`
      ).padStart(13);
    const rows: string[] = [];
    for (let i = 0; i < p.samples.length; i += GRID_COLUMNS) {
      rows.push(p.samples.slice(i, i + GRID_COLUMNS).map(cell).join(''));
    }
    console.log(
      `[pivot] ${tr.width}×${tr.height} z${tr.zoom.toFixed(2)} pitch ${tr.pitch.toFixed(1)} · ` +
        `${p.from} ${(p.depth / 1000).toFixed(2)} km, ${Math.round(p.point.elevation)} m, ` +
        `${Math.round(p.share * 100)}% of weight (* = chosen surface)\n${rows.join('\n')}`,
    );
  };

  /** Out of the render and event handlers the solve was triggered from: it reads pixels. */
  const solve = (): void => {
    if (held || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (held) return;
      pivot = choosePivot(map);
      draw();
      if (pivot) report(pivot);
    });
  };

  map.on('render', draw);
  map.on('moveend', solve);
  map.on('idle', solve);
  map.on('terrain', solve);
  solve();

  return {
    hold: (next) => {
      held = next !== null;
      if (next) pivot = next;
      draw();
      if (!held) solve();
    },
    disable: () => {
      map.off('render', draw);
      map.off('moveend', solve);
      map.off('idle', solve);
      map.off('terrain', solve);
      canvas.remove();
    },
  };
}
