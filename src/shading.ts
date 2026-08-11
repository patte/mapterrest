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

export type ShadingKey = 'hillshade' | 'heatmap';

export const SHADINGS: Record<ShadingKey, string> = {
  hillshade: 'hillshade',
  heatmap: 'elevation heatmap',
};

export const DEFAULT_SHADING: ShadingKey = 'hillshade';

export const SHADING_KEYS = Object.keys(SHADINGS) as ShadingKey[];

export function shadingLayer(
  key: ShadingKey,
  source: string,
  basemap: Basemap,
): LayerSpecification {
  if (key === 'heatmap') {
    return {
      id: SHADING_LAYER,
      type: 'color-relief',
      source,
      paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...HEATMAP_RAMP],
        'color-relief-opacity': 0.85,
      },
    };
  }
  return {
    id: SHADING_LAYER,
    type: 'hillshade',
    source,
    paint: {
      'hillshade-exaggeration': basemap.hillshade.exaggeration,
      'hillshade-shadow-color': basemap.hillshade.shadow,
      'hillshade-highlight-color': basemap.hillshade.highlight,
    },
  };
}
