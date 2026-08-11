/**
 * Control state lives in the location hash alongside MapLibre's own camera entry,
 * so a reload restores the whole view.
 *
 * MapLibre's named-hash mode (`hash: 'map'`) reads the existing params, sets only
 * its own key and re-serialises the rest, so the two writers coexist. The
 * serialisation below mirrors MapLibre's exactly — otherwise the hash would flip
 * between encoded and decoded forms as each side writes.
 */

export const MAP_HASH_KEY = 'map';

const params = (): URLSearchParams => new URLSearchParams(window.location.hash.replace(/^#/, ''));

const serialize = (p: URLSearchParams): string =>
  `#${decodeURIComponent(p.toString()).replace(/=&/g, '&').replace(/=$/g, '')}`;

export const has = (key: string): boolean => params().has(key);

export function readString<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const value = params().get(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = params().get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function readBoolean(key: string, fallback: boolean): boolean {
  const value = params().get(key);
  return value === null ? fallback : value === '1';
}

export function write(key: string, value: string | number | boolean): void {
  const next = params();
  next.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  history.replaceState(null, '', serialize(next));
}
