import type { LayerSpecification } from 'maplibre-gl';
import type { Basemap } from './basemaps';

export const SHADING_LAYER = 'terrain-shading';

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

export type ShadingKey = 'hillshade' | 'heatmap' | 'heightmap';

export const SHADINGS: Record<ShadingKey, string> = {
  hillshade: 'hillshade',
  heatmap: 'elevation heatmap',
  heightmap: 'grey heightmap',
};

/**
 * The modes that paint elevation through a ramp, as against hillshade, which reads the
 * DEM's gradient and never sees an absolute height at all.
 */
export type RampKey = Exclude<ShadingKey, 'hillshade'>;

const RAMPS: Record<RampKey, (number | string)[]> = {
  heatmap: HEATMAP_RAMP,
  heightmap: HEIGHTMAP_RAMP,
};

/** The heat ramp tints the ground under it; grey is the whole picture, so it covers it. */
const RAMP_OPACITY: Record<RampKey, number> = { heatmap: 0.85, heightmap: 1 };

export const isRamp = (key: ShadingKey): key is RampKey => key !== 'hillshade';

export const DEFAULT_SHADING: ShadingKey = 'hillshade';

export const SHADING_KEYS = Object.keys(SHADINGS) as ShadingKey[];

export function shadingLayer(
  key: ShadingKey,
  source: string,
  basemap: Basemap,
): LayerSpecification {
  if (isRamp(key)) {
    return {
      id: SHADING_LAYER,
      type: 'color-relief',
      source,
      paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...RAMPS[key]],
        'color-relief-opacity': RAMP_OPACITY[key],
      },
    };
  }
  return {
    id: SHADING_LAYER,
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
      'hillshade-shadow-color': basemap.hillshade.shadow,
      'hillshade-highlight-color': basemap.hillshade.highlight,
    },
  };
}
