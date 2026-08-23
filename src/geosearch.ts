import type { MapLibreMap } from 'maplibre-gl';
import { maptilerSuffix } from './notice';

/**
 * Geosearch against the MapTiler Geocoding API: a magnifier pill in the free top-left
 * corner that widens into a search input on click (or `/`, or ⌘K), and slides back shut
 * whenever focus leaves it — no standing footprint. A selected result only moves the
 * camera: an area frames itself via its bbox, a point is flown to; there is no marker
 * to clean up afterwards.
 */

type GeoFeature = {
  /** The feature's own name; `place_name` prefixes it to the containing places. */
  text: string;
  place_name: string;
  center: [number, number];
  bbox?: [number, number, number, number];
  place_type: string[];
};

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

/**
 * Point results carry no bbox, so the zoom comes from what kind of place they are.
 * Deliberately modest: this is a terrain viewer, and past ~z13.5 in the mountains the
 * camera pose collides with the relief (see MAX_PITCH below).
 */
const POINT_ZOOM: Record<string, number> = { address: 13.5, street: 13 };
const zoomFor = (f: GeoFeature): number => POINT_ZOOM[f.place_type[0]] ?? 12.5;

/**
 * A search flight eases the pitch down to this. At the app's default 78° the target
 * pose sits inside the mountainside; MapLibre rescues the camera upward and the target
 * ends up off-screen (measured: y≈990 in a 900px viewport). 45° keeps the camera
 * kilometres above any relief at the zooms used here, so the target lands centred.
 */
const MAX_PITCH = 45;

const key = import.meta.env.VITE_MAPTILER_API_KEY;

/** `onSearch` fires whenever a query actually goes out — the logo credit hangs on it. */
export function setupGeosearch(map: MapLibreMap, onSearch?: () => void): void {
  const root = document.getElementById('geosearch')!;
  // Same policy as the satellite basemap: without a key the API only 401s, so the
  // search never appears rather than failing on first use.
  if (!key) return;
  root.hidden = false;

  const magnifier = document.getElementById('geosearch-open') as HTMLButtonElement;
  const box = document.getElementById('geosearch-box') as HTMLElement;
  const input = document.getElementById('geosearch-input') as HTMLInputElement;
  const list = document.getElementById('geosearch-results') as HTMLElement;

  let debounceTimer: number | undefined;
  let controller: AbortController | null = null;
  let features: GeoFeature[] = [];
  let active = -1;

  function clearResults(): void {
    features = [];
    active = -1;
    list.hidden = true;
    list.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function openBox(): void {
    // A fresh open starts a fresh search; the stale text sat in the closed box only so
    // it would not flash back to the placeholder while the exit animation ran.
    if (!root.classList.contains('open')) input.value = '';
    root.classList.add('open');
    magnifier.setAttribute('aria-expanded', 'true');
    // preventScroll: the second guard against the box scrolling itself to the focused
    // input mid-widening (see the overflow: clip note in the stylesheet).
    input.focus({ preventScroll: true });
  }

  function closeBox(): void {
    window.clearTimeout(debounceTimer);
    controller?.abort();
    controller = null;
    clearResults();
    root.classList.remove('open');
    magnifier.setAttribute('aria-expanded', 'false');
  }

  function setActive(index: number): void {
    active = index;
    for (const [i, li] of [...list.children].entries()) {
      li.setAttribute('aria-selected', String(i === index));
    }
    if (index >= 0) input.setAttribute('aria-activedescendant', `geosearch-item-${index}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /** A message where the results go — an error (`warn`) or "no results", not selectable. */
  function renderNote(text: string, warn = false): void {
    clearResults();
    const li = document.createElement('li');
    li.className = warn ? 'note warn' : 'note';
    if (warn) {
      li.insertAdjacentHTML(
        'afterbegin',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />' +
          '<path d="M12 9v4" stroke-linecap="round" /><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" /></svg>',
      );
    }
    li.appendChild(document.createTextNode(text));
    list.appendChild(li);
    list.hidden = false;
  }

  function renderResults(found: GeoFeature[]): void {
    clearResults();
    features = found;
    for (const [i, f] of found.entries()) {
      const li = document.createElement('li');
      li.id = `geosearch-item-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.text;
      li.appendChild(name);
      // place_name spells the hierarchy out from the name itself; only the containing
      // places are news.
      const rest = f.place_name.startsWith(`${f.text}, `)
        ? f.place_name.slice(f.text.length + 2)
        : f.place_name;
      if (rest && rest !== f.text) {
        const context = document.createElement('span');
        context.className = 'context';
        context.textContent = rest;
        li.appendChild(context);
      }
      // The input keeps focus through the click, so focusout cannot close the list
      // between press and release.
      li.addEventListener('pointerdown', (e) => e.preventDefault());
      li.addEventListener('click', () => select(i));
      list.appendChild(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function select(index: number): void {
    const f = features[index];
    if (!f) return;
    closeBox();
    // The camera keeps its bearing — the answer stays a terrain view of the place,
    // not a reset to top-down north — but the pitch is capped (see MAX_PITCH).
    const attitude = { bearing: map.getBearing(), pitch: Math.min(map.getPitch(), MAX_PITCH) };
    if (f.bbox) map.fitBounds(f.bbox, { ...attitude, padding: 40 });
    else map.flyTo({ ...attitude, center: f.center, zoom: zoomFor(f) });
  }

  async function search(query: string): Promise<void> {
    onSearch?.();
    controller?.abort();
    const mine = (controller = new AbortController());
    const center = map.getCenter().wrap();
    const params = new URLSearchParams({
      key,
      limit: '5',
      language: navigator.language.split('-')[0],
      // Bias toward what the user is looking at: searching "Grindelwald" over the Alps
      // should not land in some other continent's Grindelwald.
      proximity: `${center.lng.toFixed(3)},${center.lat.toFixed(3)}`,
    });
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?${params}`;
    try {
      const res = await fetch(url, { signal: mine.signal });
      // A newer query took over while this response was in flight.
      if (mine !== controller) return;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (mine !== controller) return;
        renderNote(`search failed (HTTP ${res.status})${maptilerSuffix(res.status, body)}`, true);
        return;
      }
      const data = (await res.json()) as { features: GeoFeature[] };
      if (mine !== controller) return;
      if (data.features.length === 0) renderNote('no results');
      else renderResults(data.features);
    } catch {
      if (mine.signal.aborted) return;
      renderNote('search failed — network error', true);
    }
  }

  // Already open, the magnifier just hands focus back to the input.
  magnifier.addEventListener('click', openBox);
  document.getElementById('geosearch-close')!.addEventListener('click', closeBox);

  input.addEventListener('input', () => {
    const query = input.value.trim();
    window.clearTimeout(debounceTimer);
    if (query.length < MIN_CHARS) {
      controller?.abort();
      clearResults();
      return;
    }
    debounceTimer = window.setTimeout(() => search(query), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (features.length > 0) {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setActive((active + delta + features.length) % features.length);
      }
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (features.length > 0) select(active >= 0 ? active : 0);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeBox();
    }
  });

  // Clicks on the box's own padding land next to the input, not on it; keeping focus
  // there stops them from collapsing the search they happened inside of.
  box.addEventListener('pointerdown', (e) => {
    if (e.target !== input) e.preventDefault();
  });
  // A typed query survives a stray click on the map — vanishing would throw the typing
  // away. Only an empty box collapses when focus leaves; × and Escape stay the exits.
  root.addEventListener('focusout', (e) => {
    if (input.value.trim() === '' && !root.contains(e.relatedTarget as Node | null)) closeBox();
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing =
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
    const wantsOpen = (e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey));
    if (!wantsOpen) return;
    e.preventDefault();
    openBox();
  });
}
