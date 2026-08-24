// The app exposes these on window under import.meta.env.DEV; the suite drives the map
// through them, so the server must be `vite dev`.
export {};

declare global {
  interface Window {
    map: any;
    visibleRange: (map: any, source: string) => { lo: number; hi: number } | null;
    choosePivot: (map: any) => any;
    projectPoint: (map: any, p: any) => { x: number; y: number } | null;
    /** The thumbnailer's mini map — existing at all means a preview rendered live. */
    __mini?: any;
    /** Tile id → what the walk keyed its render on, `[spec, camera]` as JSON. */
    __thumbRendered?: Map<string, string>;
    /** Tile id → the delivered preview URL (baked asset or live data: snapshot). */
    __thumbImages?: Map<string, string>;
  }
}
