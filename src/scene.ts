import type { MapLibreMap } from 'maplibre-gl';
import { BASEMAPS, type BasemapKey } from './basemaps';
import {
  CONTOUR_LINE_LAYER,
  CONTOUR_SOURCE,
  CONTOUR_TEXT_LAYER,
  contourLineLayer,
  contourSource,
  contourTextLayer,
  styleTextFont,
} from './contours';
import type { Range } from './exposure';
import { HILLSHADE_LAYER, hillshadeLayer, RAMP_LAYER, rampColor, rampDomain, rampLayer, type RampKey } from './shading';
import {
  DEM_SOURCE,
  demSource,
  MAX_ZOOM_LEVELS_ON_SCREEN,
  TILE_COUNT_MAX_MIN_RATIO,
  usesLodParams,
  type Detail,
} from './terrain';

const BACKDROP_LAYER = 'terrain-backdrop';

/**
 * Everything that decides what a map of this app looks like, camera aside. One spec
 * renders identically on any MapLibre map it is attached to — the main view and the
 * thumbnail previews differ only in which spec they are handed.
 */
export type SceneSpec = {
  basemap: BasemapKey;
  basemapVisible: boolean;
  /** Elevation painted through a colour ramp; null leaves the basemap's own ground. */
  ramp: RampKey | null;
  /** Relief lit from the DEM's gradient, over the ramp when both are on. */
  hillshade: boolean;
  /** Contour lines over whatever the ramp and hillshade paint. */
  contours: boolean;
  /** Elevation numbers along the major lines; only read while contours are on. */
  contourLabels: boolean;
  /** Range the ramps are pinned to; null spans the ramp's own metres. */
  exposure: Range | null;
  /** Vertical multiplier on the DEM; 0 renders the terrain flat. */
  terrainScale: number;
};

export type Scene = {
  /** Applies the changed parts, no-oping on values already in force. */
  set(partial: Partial<SceneSpec>): void;
  spec(): SceneSpec;
  destroy(): void;
};

const sameExposure = (a: Range | null, b: Range | null): boolean =>
  a === b || (a !== null && b !== null && a.lo === b.lo && a.hi === b.hi);

/**
 * Makes `map` render `initial` and keeps it rendering whatever `set` moves the spec to.
 * Owns the style lifecycle: setStyle() replaces sources, layers, terrain and sky
 * wholesale, so everything the terrain contributes is re-attached on `style.load`,
 * which fires on the initial load and on every subsequent style change.
 */
export function attachScene(map: MapLibreMap, initial: SceneSpec, detail: Detail): Scene {
  let spec = { ...initial };

  /** Layer ids the current style ships with `visibility: none`, captured at style.load. */
  let styleHidden = new Set<string>();

  const firstSymbolId = (): string | undefined =>
    map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  /**
   * The overlays stack under the basemap's symbols — or place names sit behind the
   * ramp — in a fixed order: ramp, hillshade, contour lines, labels. Each one is added
   * and removed on its own so a change to one leaves the others' drawn tiles in place.
   */
  const ORDER = [RAMP_LAYER, HILLSHADE_LAYER, CONTOUR_LINE_LAYER, CONTOUR_TEXT_LAYER];
  const anchorFor = (layer: string): string | undefined =>
    ORDER.slice(ORDER.indexOf(layer) + 1).find((id) => map.getLayer(id)) ?? firstSymbolId();

  function applyRamp(): void {
    if (map.getLayer(RAMP_LAYER)) map.removeLayer(RAMP_LAYER);
    if (spec.ramp === null) return;
    map.addLayer(rampLayer(spec.ramp, DEM_SOURCE, spec.exposure), anchorFor(RAMP_LAYER));
  }

  function applyHillshade(): void {
    if (map.getLayer(HILLSHADE_LAYER)) map.removeLayer(HILLSHADE_LAYER);
    if (!spec.hillshade) return;
    map.addLayer(
      hillshadeLayer(DEM_SOURCE, BASEMAPS[spec.basemap], spec.ramp !== null),
      anchorFor(HILLSHADE_LAYER),
    );
  }

  function applyContours(): void {
    if (map.getLayer(CONTOUR_TEXT_LAYER)) map.removeLayer(CONTOUR_TEXT_LAYER);
    if (map.getLayer(CONTOUR_LINE_LAYER)) map.removeLayer(CONTOUR_LINE_LAYER);
    if (!spec.contours) return;
    // The source only lands once contours are asked for — adding it spins up the
    // tracing worker — and then stays: a source no layer uses fetches nothing.
    if (!map.getSource(CONTOUR_SOURCE)) map.addSource(CONTOUR_SOURCE, contourSource());
    const basemap = BASEMAPS[spec.basemap];
    const anchor = firstSymbolId();
    map.addLayer(contourLineLayer(basemap), anchor);
    if (spec.contourLabels) {
      const font = styleTextFont(map);
      if (font) map.addLayer(contourTextLayer(basemap, font), anchor);
    }
  }

  /**
   * Background layers stay on: MapLibre hangs vertical skirts off every terrain tile
   * edge to cover LOD seams, and over a see-through drape those skirts smear the edge
   * pixels into grey curtains between tiles. The backdrop then replaces the style's
   * near-black or paper-white ground with a mid tone the relief reads against.
   */
  const ownLayers = new Set(ORDER);

  function applyBasemapVisibility(): void {
    for (const layer of map.getStyle().layers) {
      if (ownLayers.has(layer.id) || layer.type === 'background' || styleHidden.has(layer.id))
        continue;
      map.setLayoutProperty(layer.id, 'visibility', spec.basemapVisible ? 'visible' : 'none');
    }
    map.setLayoutProperty(BACKDROP_LAYER, 'visibility', spec.basemapVisible ? 'none' : 'visible');
  }

  /**
   * Repainting the ramp is ~0.5 ms and leaves the layer in place; re-adding it would
   * drop the tiles already drawn.
   */
  function repaintRamp(): void {
    if (spec.ramp !== null && map.getLayer(RAMP_LAYER)) {
      map.setPaintProperty(
        RAMP_LAYER,
        'color-relief-color',
        rampColor(spec.ramp, spec.exposure ?? rampDomain(spec.ramp)),
      );
    }
  }

  let terrainFrame = 0;
  function scheduleTerrain(): void {
    // setTerrain tears down and rebuilds the terrain and its render-to-texture cache, and
    // the camera anchor re-settles on the 'terrain' event it fires — at most one per frame.
    terrainFrame ||= requestAnimationFrame(() => {
      terrainFrame = 0;
      if (map.getTerrain()) map.setTerrain({ source: DEM_SOURCE, exaggeration: spec.terrainScale });
    });
  }

  /** The centre's elevation as a basemap swap began, to put back once terrain returns. */
  let swapElevation: number | null = null;

  const onStyleLoad = (): void => {
    const basemap = BASEMAPS[spec.basemap];
    const elevation = swapElevation ?? map._camera.transform.elevation;
    swapElevation = null;

    // What the style ships hidden stays hidden: the visibility toggle restores the style,
    // it must not reveal layers the author turned off.
    styleHidden = new Set(
      map
        .getStyle()
        .layers.filter((l) => 'layout' in l && l.layout?.visibility === 'none')
        .map((l) => l.id),
    );

    map.addSource(DEM_SOURCE, demSource(detail));
    if (usesLodParams(detail)) {
      map.setSourceTileLodParams(MAX_ZOOM_LEVELS_ON_SCREEN, TILE_COUNT_MAX_MIN_RATIO, DEM_SOURCE);
    }
    map.setTerrain({ source: DEM_SOURCE, exaggeration: spec.terrainScale });
    // setTerrain re-derives the centre's elevation from the just-added DEM source, whose
    // cache is still empty and answers 0 — on a basemap switch that sinks the camera by
    // the centre's height. The elevation the swap started with is still right (same DEM,
    // same terrain scale), so it goes back. The initial load enters at 0 and skips: its
    // elevation arrives per terrain tile (cameraAnchor), and a jumpTo here would fire a
    // moveend that ends that regime early.
    if (map._camera.transform.elevation !== elevation) map.jumpTo({ elevation });
    map.setSky(basemap.sky);

    // Above the style's own background, so it covers it once the basemap goes.
    map.addLayer(
      { id: BACKDROP_LAYER, type: 'background', paint: { 'background-color': basemap.backdrop } },
      map.getStyle().layers[1]?.id,
    );

    applyRamp();
    applyHillshade();
    applyContours();
    applyBasemapVisibility();
  };
  map.on('style.load', onStyleLoad);

  return {
    set(partial: Partial<SceneSpec>): void {
      const prev = spec;
      spec = { ...spec, ...partial };
      if (spec.basemap !== prev.basemap) {
        // The old terrain must not draw over the incoming style: the painter's depth
        // pass reads style.projection, which the fresh style has not resolved yet, and
        // every frame until it does throws. style.load re-attaches the terrain along
        // with the rest of the spec, and the elevation goes back with it.
        if (map.getTerrain()) {
          swapElevation = map._camera.transform.elevation;
          map.setTerrain(null);
        }
        map.setStyle(BASEMAPS[spec.basemap].url);
        return;
      }
      if (spec.terrainScale !== prev.terrainScale) scheduleTerrain();
      if (spec.basemapVisible !== prev.basemapVisible) applyBasemapVisibility();
      if (spec.ramp !== prev.ramp) applyRamp();
      else if (!sameExposure(spec.exposure, prev.exposure)) repaintRamp();
      // The hillshade's colours depend on whether a ramp sits under it.
      if (spec.hillshade !== prev.hillshade || (spec.ramp === null) !== (prev.ramp === null)) {
        applyHillshade();
      }
      if (
        spec.contours !== prev.contours ||
        (spec.contours && spec.contourLabels !== prev.contourLabels)
      ) {
        applyContours();
      }
    },
    spec: () => ({ ...spec }),
    destroy(): void {
      map.off('style.load', onStyleLoad);
      if (terrainFrame) cancelAnimationFrame(terrainFrame);
    },
  };
}
