import mapterhornLogo from './assets/mapterhorn.svg?raw';
import maptilerLogo from './assets/maptiler.svg?raw';

export type LogoState = {
  /** Mapterhorn data shapes the frame — 3D relief, or a shading overlay reading the DEM. */
  mapterhorn: boolean;
  /** A MapTiler style is on screen; their free tier asks for the logo alongside it. */
  maptiler: boolean;
};

/**
 * The providers' logos, stacked above the attribution in its corner. The attribution
 * credits every source in text; the logos are the two providers whose terms or courtesy
 * ask for a mark on the map itself, so they come and go with what the frame shows.
 */
export function setupLogos(corner: Element): { update(state: LogoState): void } {
  const box = document.createElement('div');
  box.id = 'logos';
  box.className = 'maplibregl-ctrl';

  const link = (cls: string, href: string, label: string, svg: string): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.className = cls;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', label);
    a.title = label;
    a.innerHTML = svg;
    return a;
  };
  const mapterhorn = link('mapterhorn', 'https://mapterhorn.com', 'terrain by Mapterhorn', mapterhornLogo);
  const maptiler = link('maptiler', 'https://www.maptiler.com', 'basemap by MapTiler', maptilerLogo);
  // Mapterhorn last: the stack hangs from the attribution, and the near-always-on logo
  // holding the bottom spot means a basemap switch never shifts it.
  box.append(maptiler, mapterhorn);
  // Before the attribution, so the stack sits above it.
  corner.prepend(box);

  return {
    update(state: LogoState): void {
      mapterhorn.hidden = !state.mapterhorn;
      maptiler.hidden = !state.maptiler;
      // An empty box would still hold its corner margin open.
      box.hidden = !state.mapterhorn && !state.maptiler;
    },
  };
}
