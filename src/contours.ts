import mlcontour from 'maplibre-contour';
import { addProtocol, type LayerSpecification, type MapLibreMap, type VectorSourceSpecification } from 'maplibre-gl';
import type { Basemap } from './basemaps';
import { DEM_ATTRIBUTION, DEM_TILE_URL } from './terrain';

export const CONTOUR_SOURCE = 'mapterhorn-contours';
export const CONTOUR_LINE_LAYER = 'terrain-contour-lines';
export const CONTOUR_TEXT_LAYER = 'terrain-contour-labels';

/**
 * There are no contour tiles to download: maplibre-contour registers a protocol that
 * fetches the same Mapterhorn DEM tiles the terrain uses (the browser's HTTP cache
 * dedupes the traffic) and traces isolines into vector tiles in a web worker. Created on
 * first use so a session that never turns contours on never pays for the worker; one
 * instance serves every map — main, thumbnails, screenshot — and shares its tile cache.
 */
let demSource: InstanceType<typeof mlcontour.DemSource> | null = null;

/**
 * The elevation gap between lines, minor and major, by tile zoom; a zoom without an
 * entry takes the next lower one, and below the lowest there are none at all. The two
 * finest rungs are Mapterhorn's own contour example; above them the interval roughly
 * doubles every two zooms, so zoomed-out views and the far reaches of a pitched one
 * keep their lines without drowning in them. z4's single value means no major lines —
 * at that scale every line is a landmark, and 10 000 m majors would never occur.
 */
const THRESHOLDS: Record<number, number[]> = {
  4: [2000],
  6: [1000, 5000],
  8: [500, 2000],
  10: [200, 1000],
  12: [100, 500],
  14: [20, 100],
};

export function contourSource(): VectorSourceSpecification {
  if (!demSource) {
    // maxzoom caps the DEM fetched for tracing at z12 — deeper levels sharpen lines
    // less than they cost, and much of the world carries nothing deeper anyway.
    demSource = new mlcontour.DemSource({
      url: DEM_TILE_URL,
      encoding: 'terrarium',
      maxzoom: 12,
      worker: true,
    });
    demSource.setupMaplibre({ addProtocol });
  }
  return {
    type: 'vector',
    tiles: [
      demSource.contourProtocolUrl({
        thresholds: THRESHOLDS,
        elevationKey: 'ele',
        levelKey: 'level',
        contourLayer: 'contours',
        buffer: 1,
        overzoom: 2,
      }),
    ],
    maxzoom: 17,
    attribution: DEM_ATTRIBUTION,
  };
}

export function contourLineLayer(basemap: Basemap): LayerSpecification {
  return {
    id: CONTOUR_LINE_LAYER,
    type: 'line',
    source: CONTOUR_SOURCE,
    'source-layer': 'contours',
    paint: {
      'line-color': basemap.contour.line,
      'line-width': ['match', ['get', 'level'], 1, 1, 0.5],
    },
  };
}

export function contourTextLayer(basemap: Basemap, font: string[]): LayerSpecification {
  return {
    id: CONTOUR_TEXT_LAYER,
    type: 'symbol',
    source: CONTOUR_SOURCE,
    'source-layer': 'contours',
    // Only the major lines carry a number; every 20 m line labelled is noise.
    filter: ['==', ['get', 'level'], 1],
    layout: {
      'symbol-placement': 'line',
      'text-size': 12,
      'text-field': ['concat', ['number-format', ['get', 'ele'], {}], 'm'],
      'text-font': font,
    },
    paint: {
      'text-color': basemap.contour.label,
      'text-halo-color': basemap.contour.halo,
      'text-halo-width': 1.5,
    },
  };
}

/**
 * The glyphs the labels can use are the active style's, and every provider names its
 * fonts differently — so the font comes off the style itself, from its first symbol
 * layer that declares one. A style without any (none of the current basemaps) gets
 * lines without labels rather than a stack of 404s.
 */
export function styleTextFont(map: MapLibreMap): string[] | null {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const font: unknown = layer.layout?.['text-font'];
    if (!Array.isArray(font)) continue;
    if (font.every((f) => typeof f === 'string')) return font as string[];
    if (font[0] === 'literal' && Array.isArray(font[1])) return font[1] as string[];
  }
  return null;
}
