// One definition of how a browser is launched, shared by the playwright config and the
// spike scripts. An explicit GL=metal / GL=swiftshader wins; otherwise a Mac renders on
// the real GPU and CI or Linux goes through SwiftShader — deterministic, needs no GPU,
// and reproduces the software-GL bugs the suite guards (e.g. the 255-tile
// coords-framebuffer overflow).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {{ mode: 'metal' | 'swiftshader', channel?: 'chromium', args: string[] }} */
export function glLaunchOptions() {
  const mode =
    process.env.GL ??
    (process.env.CI || process.platform !== 'darwin' ? 'swiftshader' : 'metal');
  return mode === 'metal'
    ? // The GPU needs full Chromium in new-headless mode; the headless shell has no GPU path.
      { mode, channel: 'chromium', args: ['--use-angle=metal'] }
    : {
        mode: 'swiftshader',
        args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
      };
}

// Where `pnpm browser:start` (scripts/browser-daemon.mjs) records its endpoint.
export const serverFile = fileURLToPath(new URL('../.browser-server.json', import.meta.url));

/**
 * A live resident browser server in the given mode, else null. The pid probe clears
 * stale files from a crashed daemon; the mode check keeps a GL override from silently
 * running on the other renderer.
 * @returns {{ wsEndpoint: string, pid: number, mode: string } | null}
 */
export function residentServer(mode) {
  try {
    const s = JSON.parse(readFileSync(serverFile, 'utf8'));
    process.kill(s.pid, 0);
    return s.mode === mode ? s : null;
  } catch {
    return null;
  }
}
