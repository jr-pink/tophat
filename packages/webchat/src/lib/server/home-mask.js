// A server that serves strangers (TOPHAT_RUNNER_PROMPT_MODE=public, the same switch that makes the runner's system prompt show no path)
// must not tell a client where on the host's disk it lives. Conversation rows, sidebar rows, events and the capabilities block carry
// a working directory under the host's home; every JSON or event-stream answer under /api/ goes through this mask on the way out, so
// a route that adds a path field later is covered too. A home directory (the server's own, or any /Users/<name> or /home/<name>) is
// written as `~`. Nothing here imports anything: the hook applies it, node tests drive it.
import { homedir } from 'node:os';

// The one place this module asks for the process's own home. It is masked out of what a client sees, never a place state is read or
// written, so the server-homedir rule (state resolving under the real home) does not apply; the ratchet allows exactly this one call.
const ownHome = () => homedir();

export const publicMode = (env = process.env) => env.TOPHAT_RUNNER_PROMPT_MODE === 'public';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The pattern for the home directories to hide: this process's own home, then any /Users/<name> or /home/<name>. */
export function homePattern(home = ownHome()) {
  const own = home && home !== '/' ? `${escapeRe(home.replace(/\/+$/, ''))}|` : '';
  return new RegExp(`${own}/(?:Users|home)/[A-Za-z0-9._-]+`, 'g');
}

/** One string with every home directory written as `~`. */
export const maskHomeText = (text, pattern = homePattern()) => String(text).replace(pattern, '~');

/** True for the answers that carry app data: JSON, newline-delimited JSON and event streams. */
export const maskableType = (contentType) => /^(?:application\/(?:[\w.+-]*\+)?json|application\/x-ndjson|text\/event-stream)\b/i.test(contentType || '');

/**
 * A TransformStream that masks home directories in text as it passes. A chunk that ends partway into a home directory (a prefix
 * of `/Users/` or `/home/`, or of the home itself) keeps that tail for the next chunk, so a path split across chunks is masked
 * too; the tail is held only while it could still become a match, so a live event stream is not delayed.
 */
export function maskStream({ home = ownHome() } = {}) {
  const pattern = homePattern(home);
  const heads = [home && home !== '/' ? home.replace(/\/+$/, '') : '', '/Users/', '/home/'].filter(Boolean);
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let held = '';
  const safeCut = (text) => {
    let cut = text.length;
    // the tail is a proper prefix of a home directory head ...
    for (let n = 1; n < Math.min(text.length, Math.max(...heads.map((h) => h.length))) + 1; n++) {
      const tail = text.slice(text.length - n);
      if (heads.some((h) => h.length > n && h.startsWith(tail))) cut = text.length - n;
    }
    // ... or an unfinished /Users/<name> segment whose name may continue in the next chunk
    const open = /\/(?:Users|home)\/[A-Za-z0-9._-]*$/.exec(text);
    if (open) cut = Math.min(cut, open.index);
    return cut;
  };
  return new TransformStream({
    transform(chunk, controller) {
      const text = held + decoder.decode(chunk, { stream: true });
      const cut = safeCut(text);
      held = text.slice(cut);
      const out = maskHomeText(text.slice(0, cut), pattern);
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      const out = maskHomeText(held + decoder.decode(), pattern);
      if (out) controller.enqueue(encoder.encode(out));
    }
  });
}

/** The response with its body masked, or the same response when this one carries no app data. Length headers are dropped (the body changes size). */
export function maskResponse(response, { home = ownHome() } = {}) {
  const encoding = response.headers.get('content-encoding');
  if (!response.body || !maskableType(response.headers.get('content-type')) || (encoding && encoding !== 'identity')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(response.body.pipeThrough(maskStream({ home })), { status: response.status, statusText: response.statusText, headers });
}
