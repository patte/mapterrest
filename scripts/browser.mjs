// One definition of how a browser is launched, shared by the playwright config and the
// spike scripts: SwiftShader by default — deterministic, runs in CI, reproduces the
// software-GL bugs the suite guards — and GL=metal for the real GPU, which needs full
// Chromium in new-headless mode because the default headless shell has no GPU path.

/** @returns {{ channel?: 'chromium', args: string[] }} */
export function glLaunchOptions() {
  return process.env.GL === 'metal'
    ? { channel: 'chromium', args: ['--use-angle=metal'] }
    : { args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] };
}
