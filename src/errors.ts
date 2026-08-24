import * as Sentry from '@sentry/browser';
import { version } from '../package.json';

// Error tracking into Bugsink, which speaks the Sentry protocol. Only production
// builds report; dev sessions and Playwright runs (navigator.webdriver) stay out.
if (import.meta.env.PROD && !navigator.webdriver) {
  Sentry.init({
    dsn: 'https://d320c82faf4348a0bc4a1216d2b2ea26@mapterrest.bugsink.com/1',
    release: `mapterrest@${version}`,
    sendDefaultPii: false,
    integrations: [],
    // The WebGL2 gate's deliberate stop (main.ts): the visitor's browser lacking
    // WebGL2 is their situation, not a bug worth an event.
    ignoreErrors: [/^WebGL2 unavailable/],
    // Bugsink does not ingest traces.
    tracesSampleRate: 0,
  });
}
