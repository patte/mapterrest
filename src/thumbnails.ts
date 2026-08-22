import { MapLibreMap } from 'maplibre-gl';
import { BASEMAPS } from './basemaps';
import { attachScene, type Scene, type SceneSpec } from './scene';

/** One preview render; several tiles share it when their specs coincide. */
export type ThumbVariant = { ids: string[]; spec: SceneSpec };

/**
 * Backing pixels per side. The map renders at devicePixelRatio on top of this, so a
 * 128 px canvas is already 2× the 64 px tile on a plain screen.
 */
const SIZE = 128;

/**
 * How far under the main camera's zoom the previews render. A square cut from the middle
 * of the frame at the same zoom shows almost nothing of the view; the full ~4 levels that
 * would fit the whole frame render a view the switch would never show. A little out keeps
 * the styles recognisable and the scene familiar.
 */
const ZOOM_OUT = 1.5;

/** A variant that cannot settle inside this forfeits its refresh — stale beats hung. */
const SETTLE_TIMEOUT = 8000;

export type Thumbnailer = {
  /** Re-renders every variant at the main camera, replacing any walk still running. */
  refresh(variants: ThumbVariant[]): void;
  destroy(): void;
};

export function createThumbnailer(
  main: MapLibreMap,
  opts: {
    onImage(id: string, url: string): void;
    /** Checked between variants: a tray folded away mid-walk stops the spending. */
    visible(): boolean;
  },
): Thumbnailer {
  let mini: MapLibreMap | null = null;
  let scene: Scene | null = null;
  let container: HTMLDivElement | null = null;
  let generation = 0;

  /** Created on the first refresh, so a tray that never shows never costs a map. */
  function ensure(spec: SceneSpec): void {
    if (mini) return;
    container = document.createElement('div');
    // Offscreen, not display:none — an unpainted canvas renders nothing to copy.
    container.style.cssText = `position:fixed;left:-9999px;top:0;width:${SIZE}px;height:${SIZE}px;`;
    document.body.appendChild(container);
    mini = new MapLibreMap({
      container,
      style: BASEMAPS[spec.basemap].url,
      interactive: false,
      attributionControl: false,
      maxPitch: 90,
      // Tile crossfades would either delay the snapshot or land half-blended in it.
      fadeDuration: 0,
      // Keeps the frame readable after 'idle'; the snapshot below reads it directly.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    scene = attachScene(mini, spec, 'low');
  }

  /** Resolves true on 'idle', false when the timeout wins; either way the walk moves on. */
  const settle = (): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        mini!.off('idle', onIdle);
        resolve(false);
      }, SETTLE_TIMEOUT);
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      mini!.once('idle', onIdle);
      // A map already idle fires no event on its own; one forced frame re-raises it.
      mini!.triggerRepaint();
    });

  async function walk(gen: number, variants: ThumbVariant[]): Promise<void> {
    ensure(variants[0].spec);
    mini!.jumpTo({
      center: main.getCenter(),
      zoom: main.getZoom() - ZOOM_OUT,
      pitch: main.getPitch(),
      bearing: main.getBearing(),
    });
    for (const variant of variants) {
      if (gen !== generation || !opts.visible()) return;
      scene!.set(variant.spec);
      const settled = await settle();
      if (gen !== generation) return;
      if (!settled) continue;
      const url = mini!.getCanvas().toDataURL();
      for (const id of variant.ids) opts.onImage(id, url);
    }
  }

  /**
   * Walks never overlap: a swap of the mini map's style while the last one is still
   * loading races MapLibre's own render loop. A refresh retires the running walk via
   * the generation and queues behind its current variant — at most one settle away.
   */
  let queue: Promise<void> = Promise.resolve();

  return {
    refresh(variants: ThumbVariant[]): void {
      if (variants.length === 0) return;
      const gen = ++generation;
      queue = queue.then(() => (gen === generation ? walk(gen, variants) : undefined));
    },
    destroy(): void {
      generation++;
      scene?.destroy();
      mini?.remove();
      container?.remove();
      mini = null;
      scene = null;
      container = null;
    },
  };
}
