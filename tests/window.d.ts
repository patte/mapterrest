// The app exposes these on window under import.meta.env.DEV; the suite drives the map
// through them, so the server must be `vite dev`.
export {};

declare global {
  interface Window {
    map: any;
    visibleRange: (map: any, source: string) => { lo: number; hi: number } | null;
    /** GPU bytes held across every WebGL context, counted since `#debugPerf=1` installed it. */
    glUsageAll: () => { textureBytes: number; textures: number; bufferBytes: number; buffers: number };
    choosePivot: (map: any) => any;
    projectPoint: (map: any, p: any) => { x: number; y: number } | null;
    /** The forward/orbit toggles beside the magnifier. */
    flight: { mode: 'forward' | 'orbit' | null; flying: boolean; spin: 1 | -1; toggle(mode: 'forward' | 'orbit'): void; stop(): void };
    /** The thumbnailer's mini map — existing at all means a preview rendered live. */
    __mini?: any;
    /** Tile id → what the walk keyed its render on, `[spec, camera]` as JSON. */
    __thumbRendered?: Map<string, string>;
    /** Tile id → the delivered preview URL (baked asset or live data: snapshot). */
    __thumbImages?: Map<string, string>;
  }
}
