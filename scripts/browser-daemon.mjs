// A resident browser server, so repeated verify/probe runs skip the process launch:
// `pnpm browser:start` once, and every run whose GL mode matches connects to it via
// .browser-server.json; `pnpm browser:stop` takes it down. Without one, runs simply
// launch their own browser — the daemon is an opt-in accelerator, never a requirement.
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { glLaunchOptions, residentServer, serverFile } from './browser.mjs';

const gl = glLaunchOptions();
const alive = () => {
  for (const mode of ['metal', 'swiftshader']) {
    const s = residentServer(mode);
    if (s) return s;
  }
  return null;
};

const cmd = process.argv[2];
if (cmd === '_serve') {
  const server = await chromium.launchServer({ channel: gl.channel, args: gl.args });
  writeFileSync(
    serverFile,
    JSON.stringify({ wsEndpoint: server.wsEndpoint(), pid: process.pid, mode: gl.mode }),
  );
  const down = async () => {
    rmSync(serverFile, { force: true });
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', down);
  process.on('SIGINT', down);
} else if (cmd === 'start') {
  const s = alive();
  if (s) {
    const match = s.mode === gl.mode;
    console.log(
      match
        ? `already running: ${s.mode} browser at ${s.wsEndpoint}`
        : `a ${s.mode} browser is running — pnpm browser:stop first to switch to ${gl.mode}`,
    );
    process.exit(match ? 0 : 1);
  }
  rmSync(serverFile, { force: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const t0 = Date.now();
  while (!alive()) {
    if (Date.now() - t0 > 60000) throw new Error('browser server did not come up in 60s');
    await new Promise((r) => setTimeout(r, 100));
  }
  const up = alive();
  console.log(`${up.mode} browser at ${up.wsEndpoint}`);
} else if (cmd === 'stop') {
  const s = alive();
  if (s) process.kill(s.pid, 'SIGTERM');
  else rmSync(serverFile, { force: true });
  console.log(s ? `stopped ${s.mode} browser` : 'not running');
} else if (cmd === 'status') {
  const s = alive();
  console.log(s ? `${s.mode} browser at ${s.wsEndpoint} (pid ${s.pid})` : 'not running');
  process.exit(s ? 0 : 1);
} else {
  console.error('usage: browser-daemon.mjs start | stop | status');
  process.exit(2);
}
