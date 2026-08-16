// The app exposes these on window under import.meta.env.DEV; the suite drives the map
// through them, so the server must be `vite dev`.
export {};

declare global {
  interface Window {
    map: any;
    visibleRange: (map: any, source: string) => { lo: number; hi: number } | null;
    choosePivot: (map: any) => any;
    projectPoint: (map: any, p: any) => { x: number; y: number } | null;
  }
}
