const scheme = window.matchMedia('(prefers-color-scheme: dark)');

export const prefersDark = (): boolean => scheme.matches;

export function onSchemeChange(listener: (dark: boolean) => void): void {
  scheme.addEventListener('change', (e) => listener(e.matches));
}
