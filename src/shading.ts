import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import type { Basemap } from './basemaps';
import type { Range } from './exposure';

export const RAMP_LAYER = 'terrain-ramp';
export const HILLSHADE_LAYER = 'terrain-hillshade';

/**
 * Hypsometric heat ramp in metres: sea level blue, green lowlands, warm mid
 * altitudes, near-white above the snow line. Stops past 4500 m keep the highest
 * peaks from flattening into one colour.
 */
const HEATMAP_RAMP: (number | string)[] = [
  0, '#0c2c54',
  250, '#1b6e4a',
  750, '#5f9e42',
  1500, '#c7b13f',
  2200, '#e07b39',
  2900, '#c8412f',
  3600, '#8c2d61',
  4500, '#e8dcef',
  6000, '#ffffff',
];

/**
 * Heightmapper's greyscale, black at the foot of the ramp and white at its head with
 * nothing between the two but the elevation itself. Unlike the heat ramp it makes no
 * claim about what a given height is — grey is only ever higher or lower than other grey.
 */
const HEIGHTMAP_RAMP: (number | string)[] = [0, '#000000', 6000, '#ffffff'];

/**
 * The colour overlays paint elevation through a ramp, as against hillshade, which reads
 * the DEM's gradient and never sees an absolute height at all. The two compose: a
 * hillshade over a hypsometric tint is the classic terrain look.
 */
export type RampKey = 'heatmap' | 'heightmap';

export const RAMP_LABELS: Record<RampKey, string> = {
  heatmap: 'elevation heatmap',
  heightmap: 'grey heightmap',
};

const RAMPS: Record<RampKey, (number | string)[]> = {
  heatmap: HEATMAP_RAMP,
  heightmap: HEIGHTMAP_RAMP,
};

/** The heat ramp tints the ground under it; grey is the whole picture, so it covers it. */
const RAMP_OPACITY: Record<RampKey, number> = { heatmap: 0.85, heightmap: 1 };

/**
 * Whether a ramp starts exposed. Grey has nothing to lose by following the view; the heat
 * ramp's absolute colours do (see rampColor), so it starts pinned to its own metres.
 */
export const defaultExposed = (key: RampKey): boolean => key === 'heightmap';

/** The metres a ramp spans as written, which is what it spans unexposed. */
export const rampDomain = (key: RampKey): Range => ({
  lo: RAMPS[key][0] as number,
  hi: RAMPS[key][RAMPS[key].length - 2] as number,
});

/**
 * The ramp's own stops carried onto `range`, keeping their spacing.
 *
 * Auto-exposure is this and nothing more: the palette is untouched, only the metres it is
 * pinned to. Heightmapper spreads the lowest visible elevation to black and the highest to
 * white, which over the Netherlands is 10 m of relief across the whole ramp instead of the
 * 1 % of it a fixed scale would give.
 *
 * The consequence is that a shade stops meaning a height — mid grey is 47 m in one view
 * and 2450 m in another. Grey has nothing to lose by that; the heat ramp's sea blue and
 * snow white do, so exposing the heatmap is a choice the panel leaves open rather than
 * one it makes.
 */
export function rampColor(key: RampKey, range: Range): ExpressionSpecification {
  const domain = rampDomain(key);
  const width = domain.hi - domain.lo;
  const stops = RAMPS[key].map((stop, i) =>
    i % 2 === 0
      ? range.lo + (((stop as number) - domain.lo) / width) * (range.hi - range.lo)
      : stop,
  );
  return ['interpolate', ['linear'], ['elevation'], ...stops] as ExpressionSpecification;
}

export const RAMP_KEYS = Object.keys(RAMP_LABELS) as RampKey[];

export function rampLayer(key: RampKey, source: string, range: Range | null): LayerSpecification {
  return {
    id: RAMP_LAYER,
    type: 'color-relief',
    source,
    paint: {
      'color-relief-color': rampColor(key, range ?? rampDomain(key)),
      'color-relief-opacity': RAMP_OPACITY[key],
    },
  };
}

/** Neutral over a ramp: the basemap's tinted shade would muddy the ramp's colours. */
const NEUTRAL_HILLSHADE = { shadow: '#000000', highlight: '#ffffff' };

export function hillshadeLayer(source: string, basemap: Basemap, overRamp: boolean): LayerSpecification {
  const colors = overRamp ? NEUTRAL_HILLSHADE : basemap.hillshade;
  return {
    id: HILLSHADE_LAYER,
    type: 'hillshade',
    source,
    paint: {
      // MapLibre anchors the light to the viewport by default, which welds the sun to
      // the screen: rotating the camera re-lights every slope, and a bearing that runs
      // the light along the ridges flattens them into smears that read as lost detail.
      // Anchored to the map the light sits over the terrain at the cartographic 335°,
      // so rotating only changes the viewpoint — and an azimuth here means a real
      // compass bearing, which is what a sun position would have to be.
      'hillshade-illumination-anchor': 'map',
      'hillshade-exaggeration': basemap.hillshade.exaggeration,
      'hillshade-shadow-color': colors.shadow,
      'hillshade-highlight-color': colors.highlight,
    },
  };
}
