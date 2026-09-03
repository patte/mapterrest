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
 * entry takes the next lower one, so the z0 rung covers the whole zoom-out. The two
 * finest rungs are Mapterhorn's own contour example; above them the interval roughly
 * doubles every two zooms, so zoomed-out views and the far reaches of a pitched one
 * keep their lines without drowning in them. The coarsest rung's single value means no
 * major lines — at that scale every line is a landmark, and 10 000 m majors would
 * never occur.
 */
const THRESHOLDS: Record<number, number[]> = {
  0: [2000],
  6: [1000, 5000],
  8: [500, 2000],
  10: [200, 1000],
  12: [100, 500],
  14: [20, 100],
};

/** Detents of the two tuning knobs, inclusive; 0 is the table as written. The top
 * end is what flat country needs: a fine rung below 5 m before any lines show, and
 * the DEM still traces ground there. */
export const DENSITY_RANGE = [-2, 3] as const;
export const FALLOFF_RANGE = [-2, 3] as const;

/**
 * Contours at "every 37 m" are cartographic nonsense: every computed interval lands on
 * the 1-2-5 ladder, to the nearest rung in log space.
 */
const snap125 = (x: number): number => {
  const decade = 10 ** Math.floor(Math.log10(x));
  let out = x;
  let best = Infinity;
  for (const mantissa of [1, 2, 5, 10]) {
    const rung = mantissa * decade;
    const distance = Math.abs(Math.log(rung / x));
    if (distance < best) {
      best = distance;
      out = rung;
    }
  }
  return out;
};

/**
 * The table under the two steppers, as one exponent per knob. `density` lifts or
 * lowers the whole curve: each detent halves or doubles every interval. `falloff` is
 * the exponent on the table's own slope — the deliberate thinning of lines on the
 * coarser rungs that keeps zoomed-out and far-field tiles from drowning:
 *
 *   interval(z) = table(z14) / 2^density × (table(z) / table(z14))^(1 + falloff/2)
 *
 * At detent −2 the exponent is 0 — a flat table, every tile traces the fine rung's
 * interval; at +3 it is 2.5 — the thinning past squared, lines a close-up-only affair. The
 * fine rung itself only ever moves with `density`. Both at 0 return the table bit for
 * bit — every value already sits on the 1-2-5 ladder the snap targets.
 */
export function contourThresholds(density: number, falloff: number): Record<number, number[]> {
  const fine = THRESHOLDS[14][0];
  const out: Record<number, number[]> = {};
  for (const [zoom, intervals] of Object.entries(THRESHOLDS)) {
    const slope = intervals[0] / fine;
    const factor = 2 ** density * slope ** (-falloff / 2);
    out[Number(zoom)] = intervals.map((metres) => snap125(metres / factor));
  }
  return out;
}

export function contourSource(density: number, falloff: number): VectorSourceSpecification {
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
        thresholds: contourThresholds(density, falloff),
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
      // Over terrain the lines are baked into a 2048 px drape texture per terrain tile
      // and stretched up to 2× between integer zooms; a 0.5 px minor is one texel and
      // smears into a grey band there, 0.75 still reads as a line (1 px crowds z14).
      'line-width': ['match', ['get', 'level'], 1, 1.5, 0.75],
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
