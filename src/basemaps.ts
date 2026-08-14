import type { SkySpecification } from 'maplibre-gl';

export type Basemap = {
  label: string;
  url: string;
  dark: boolean;
  sky: SkySpecification;
  hillshade: { shadow: string; highlight: string; exaggeration: number };
  /** Ground under the terrain while the basemap is hidden. */
  backdrop: string;
};

/**
 * Sky, hillshade and backdrop travel together: a daylight sky over a dark basemap looks
 * wrong, and the shadow colour has to suit the ground it lands on. Styles pick a palette
 * by the ground they paint rather than one each.
 */
type Palette = Pick<Basemap, 'dark' | 'sky' | 'hillshade' | 'backdrop'>;

const NIGHT: Palette = {
  dark: true,
  sky: {
    'sky-color': '#0b1622',
    'horizon-color': '#243447',
    'fog-color': '#1b2735',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.2,
  },
  hillshade: { shadow: '#000000', highlight: '#8fa6bd', exaggeration: 0.55 },
  backdrop: '#39434f',
};

/** Cool grey ground — Positron and its descendants. */
const DAY: Palette = {
  dark: false,
  sky: {
    'sky-color': '#a8c6e6',
    'horizon-color': '#e4ecf3',
    'fog-color': '#eef2f6',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.1,
  },
  hillshade: { shadow: '#4a5a6b', highlight: '#ffffff', exaggeration: 0.4 },
  backdrop: '#cdd6de',
};

/** Warm paper ground — the OSM-carto lineage. */
const WARM_DAY: Palette = {
  dark: false,
  sky: {
    'sky-color': '#6ba6dd',
    'horizon-color': '#d3e3f0',
    'fog-color': '#e8eef3',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.1,
  },
  hillshade: { shadow: '#2c3a47', highlight: '#ffffff', exaggeration: 0.45 },
  backdrop: '#d6cfc4',
};

/**
 * Aerial imagery is shot in daylight, so it takes a daylight sky — but the ground it
 * paints is dark enough that the panel reads better as dark chrome. It is the one style
 * whose `dark` and whose sky disagree, which is why it carries its own palette.
 */
const SATELLITE: Palette = {
  dark: true,
  sky: {
    'sky-color': '#7fb0e0',
    'horizon-color': '#cddced',
    'fog-color': '#dae3ec',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.1,
  },
  // Imagery already carries the sun's own shadows; the shade only has to deepen them.
  hillshade: { shadow: '#000000', highlight: '#ffffff', exaggeration: 0.3 },
  backdrop: '#5c5a50',
};

/**
 * CARTO publishes its DataViz basemaps under their original names: DataViz Dark is
 * Dark Matter, DataViz Light is Positron. There is no dataviz-* style URL — those 404.
 */
const carto = (style: string) => `https://basemaps.cartocdn.com/gl/${style}-gl-style/style.json`;
const openFreeMap = (style: string) => `https://tiles.openfreemap.org/styles/${style}`;

/** Baked into the bundle, as MapTiler intends — their keys are scoped by origin instead. */
const maptilerKey = import.meta.env.VITE_MAPTILER_API_KEY;
const maptiler = (style: string) =>
  `https://api.maptiler.com/maps/${style}/style.json?key=${maptilerKey}`;

export const BASEMAPS = {
  'carto-dark': { label: 'CARTO DataViz Dark', url: carto('dark-matter'), ...NIGHT },
  'carto-light': { label: 'CARTO DataViz Light', url: carto('positron'), ...DAY },
  liberty: { label: 'OpenFreeMap Liberty', url: openFreeMap('liberty'), ...WARM_DAY },
  'ofm-bright': { label: 'OpenFreeMap Bright', url: openFreeMap('bright'), ...WARM_DAY },
  'ofm-positron': { label: 'OpenFreeMap Positron', url: openFreeMap('positron'), ...DAY },
  'ofm-dark': { label: 'OpenFreeMap Dark', url: openFreeMap('dark'), ...NIGHT },
  satellite: { label: 'MapTiler Satellite Hybrid', url: maptiler('hybrid-v4'), ...SATELLITE },
} satisfies Record<string, Basemap>;

export type BasemapKey = keyof typeof BASEMAPS;

/**
 * Without a key the MapTiler style 401s, so it leaves the list rather than offering a
 * basemap that cannot load. The hash reads its basemap against these keys too, so
 * `#basemap=satellite` then falls back to the default instead of loading nothing.
 */
export const BASEMAP_KEYS = (Object.keys(BASEMAPS) as BasemapKey[]).filter(
  (key) => key !== 'satellite' || Boolean(maptilerKey),
);

/** Which style the browser's colour scheme asks for when the hash names none. */
export const defaultBasemap = (dark: boolean): BasemapKey => (dark ? 'carto-dark' : 'carto-light');

export const isDark = (key: BasemapKey): boolean => BASEMAPS[key].dark;
