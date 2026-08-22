import { BASEMAPS, BASEMAP_KEYS, type BasemapKey } from './basemaps';
import { SHADINGS, SHADING_KEYS, type ShadingKey } from './shading';

/** One tile per choice; `null` is the "none" tile, which hides that layer. */
export type TrayCallbacks = {
  onBasemap(key: BasemapKey | null): void;
  onShading(key: ShadingKey | null): void;
};

export type TraySelection = {
  basemap: BasemapKey;
  basemapVisible: boolean;
  shading: ShadingKey;
  shadingVisible: boolean;
};

/** Tile ids, shared with the thumbnailer: `b:carto-dark`, `b:none`, `s:heatmap`, … */
export const tileId = (group: 'b' | 's', key: string | null): string => `${group}:${key ?? 'none'}`;

export type Tray = {
  /** Marks the tiles for `sel` pressed; a hidden layer presses its "none" tile. */
  select(sel: TraySelection): void;
  setImage(id: string, url: string): void;
  /** False only while collapsed with the chip closed — nothing to keep previews fresh for. */
  visible(): boolean;
  onVisibleChange(cb: () => void): void;
  setForceCollapsed(on: boolean): void;
};

const SLASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg>';

export function createTray(forceCollapsed: boolean, cb: TrayCallbacks): Tray {
  const tiles = new Map<string, HTMLButtonElement>();
  const images = new Map<string, HTMLImageElement>();

  function tile(
    container: HTMLElement,
    id: string,
    label: string,
    caption: string,
    onClick: () => void,
  ): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tile';
    button.dataset.key = id.slice(2);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    const preview = document.createElement('div');
    preview.className = 'preview';
    const img = document.createElement('img');
    img.alt = '';
    preview.appendChild(img);
    if (id.endsWith(':none')) preview.insertAdjacentHTML('beforeend', SLASH);
    const text = document.createElement('span');
    text.className = 'caption';
    text.textContent = caption;
    preview.appendChild(text);
    button.appendChild(preview);
    button.addEventListener('click', onClick);
    tiles.set(id, button);
    images.set(id, img);
    container.appendChild(button);
    return preview;
  }

  const shadingRow = document.getElementById('shading-thumbs')!;
  tile(shadingRow, tileId('s', null), 'no shading', 'none', () => cb.onShading(null));
  for (const key of SHADING_KEYS) {
    // The keys are already the short names; SHADINGS holds the spelled-out ones.
    tile(shadingRow, tileId('s', key), SHADINGS[key], key, () => cb.onShading(key));
  }

  const basemapRow = document.getElementById('basemap-thumbs')!;
  tile(basemapRow, tileId('b', null), 'no basemap', 'none', () => cb.onBasemap(null));
  for (const key of BASEMAP_KEYS) {
    const { label, short, backdrop } = BASEMAPS[key];
    const preview = tile(basemapRow, tileId('b', key), label, short, () => cb.onBasemap(key));
    // Until a preview lands, the tile shows the ground the style would put under the
    // terrain — dark styles read dark, warm ones warm.
    preview.style.background = backdrop;
  }

  /* Collapse ---------------------------------------------------------------- */

  const toggle = document.getElementById('tray-toggle') as HTMLButtonElement;
  const media = window.matchMedia('(max-width: 640px)');
  let force = forceCollapsed;
  const listeners: (() => void)[] = [];
  const notify = (): void => listeners.forEach((l) => l());

  const collapsed = (): boolean => force || media.matches;
  function applyCollapsed(): void {
    document.body.classList.toggle('tray-collapsed', collapsed());
    if (!collapsed()) setOpen(false);
    notify();
  }
  function setOpen(open: boolean): void {
    document.body.classList.toggle('tray-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  media.addEventListener('change', applyCollapsed);
  toggle.addEventListener('click', () => {
    setOpen(!document.body.classList.contains('tray-open'));
    notify();
  });
  applyCollapsed();

  return {
    select(sel: TraySelection): void {
      const pressed = new Set([
        tileId('s', sel.shadingVisible ? sel.shading : null),
        tileId('b', sel.basemapVisible ? sel.basemap : null),
      ]);
      for (const [id, button] of tiles) {
        button.setAttribute('aria-pressed', String(pressed.has(id)));
      }
    },
    setImage(id: string, url: string): void {
      const img = images.get(id);
      if (img) img.src = url;
    },
    visible: () => !collapsed() || document.body.classList.contains('tray-open'),
    onVisibleChange(listener: () => void): void {
      listeners.push(listener);
    },
    setForceCollapsed(on: boolean): void {
      if (on === force) return;
      force = on;
      applyCollapsed();
    },
  };
}
