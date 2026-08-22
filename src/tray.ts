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
  /** False while folded down to the settings tile — only its preview stays fresh then. */
  open(): boolean;
  onOpenChange(cb: () => void): void;
  setForceCollapsed(on: boolean): void;
};

/** The settings tile's preview: the view itself, the spec every row varies from. */
export const CURRENT_TILE = 'current';

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

  /* Fold -------------------------------------------------------------------- */

  const settingsTile = document.getElementById('tray-tile') as HTMLButtonElement;
  const closeButton = document.getElementById('tray-close') as HTMLButtonElement;
  images.set(CURRENT_TILE, settingsTile.querySelector('img')!);

  const media = window.matchMedia('(max-width: 640px)');
  let force = forceCollapsed;
  const listeners: (() => void)[] = [];
  const notify = (): void => listeners.forEach((l) => l());

  function setOpen(open: boolean): void {
    document.body.classList.toggle('tray-closed', !open);
    settingsTile.setAttribute('aria-expanded', String(open));
    notify();
  }
  settingsTile.addEventListener('click', () => setOpen(true));
  closeButton.addEventListener('click', () => setOpen(false));
  // The media and the hash pick the state a viewport starts in; the tile and the X
  // hand it to the user from there.
  media.addEventListener('change', () => setOpen(!(force || media.matches)));
  setOpen(!(force || media.matches));

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
    open: () => !document.body.classList.contains('tray-closed'),
    onOpenChange(listener: () => void): void {
      listeners.push(listener);
    },
    setForceCollapsed(on: boolean): void {
      if (on === force) return;
      force = on;
      setOpen(!(force || media.matches));
    },
  };
}
