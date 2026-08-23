/**
 * A dismissible toast for errors the map cannot express itself — currently MapTiler
 * requests failing, e.g. the shared key running over its limits.
 */

const FREE_KEY_SENTENCE =
  'this app uses a free MapTiler key, whose limits can be temporarily exceeded when many people use it';

/**
 * The server's own words, where they are showable: MapTiler answers errors with short
 * plain sentences (or JSON with a message), but a proxy in between could send a whole
 * HTML page — that stays out, and anything long is cut.
 */
function serverWords(body: string): string {
  let text = body.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { message?: unknown })?.message;
    if (typeof message === 'string') text = message;
  } catch {
    // not JSON — keep the raw text
  }
  if (!text || text.startsWith('<')) return '';
  text = text.replace(/\s+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/**
 * Why a MapTiler request failed, as a message suffix scoped by what came back. An
 * invalid or missing key answers 403 with a body naming it (verified empirically), and
 * is reworded; everything else quotes the server where it sent showable words. The
 * over-limit response is not documented, so the free-key sentence covers the remaining
 * auth-shaped statuses and stays off anything else (a 5xx is not a limits problem).
 */
export function maptilerSuffix(status: number, body: string): string {
  if (/invalid key|missing key/i.test(body)) return ' — the configured MapTiler key is not valid';
  const quote = serverWords(body);
  const hint = status === 402 || status === 403 || status === 429 ? ` — ${FREE_KEY_SENTENCE}` : '';
  return `${quote ? `: “${quote}”` : ''}${hint}`;
}

const box = document.getElementById('notice')!;
const text = box.querySelector('p')!;
let timer: number | undefined;

const hide = (): void => {
  window.clearTimeout(timer);
  box.hidden = true;
};
document.getElementById('notice-close')!.addEventListener('click', hide);

/** Repeats of a still-visible notice just extend its stay. */
export function showNotice(message: string): void {
  text.textContent = message;
  box.hidden = false;
  window.clearTimeout(timer);
  timer = window.setTimeout(hide, 12000);
}
