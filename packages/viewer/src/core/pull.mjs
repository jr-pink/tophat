// Pull the ciphertext log from the hub's existing device API (GET /v1/pull with a device token) into a ViewState.
// Pages are followed until `more` is false (a hub may cut a page early by size, up to 16 MB, with more=true and `next`
// covering what it scanned). When the user gains a scope during the pull, the hub now also serves history it filtered
// before, so the pull starts over from 0 and parts already applied are skipped by id (as linknotes syncOnce does).
// The only requests are to `hubUrl`: /healthz (the log head, for the progress bar) and /v1/pull.
export class HubError extends Error { constructor(status, code) { super(`hub ${status} ${code}`); this.status = status; this.code = code; } }

export async function hubHead(hubUrl, { fetch = globalThis.fetch } = {}) {
  try { const r = await fetch(hubUrl.replace(/\/$/, '') + '/healthz', { cache: 'no-store' }); if (!r.ok) return null; const j = await r.json(); return Number(j.head) || 0; } catch { return null; }
}

/**
 * onProgress({ cursor, head, actions, bytes, pages, phase }). Returns { pulled, bytes, pages, cursor, head }.
 * limit: actions per page asked of the hub (it caps at 1000).
 */
export async function pullInto(state, { hubUrl, token, fetch = globalThis.fetch, onProgress = () => {}, limit = 500, maxPages = 1000000 } = {}) {
  const base = hubUrl.replace(/\/$/, '');
  const head = await hubHead(base, { fetch });
  let pulled = 0, bytes = 0, pages = 0;
  let groups = JSON.stringify(state.viewer.groups);
  onProgress({ cursor: state.cursor, head, actions: 0, bytes: 0, pages: 0, phase: 'pull' });
  for (let round = 0; round < maxPages; round++) {
    const before = state.cursor;
    const r = await fetch(`${base}/v1/pull?after=${state.cursor}&limit=${limit}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    const text = await r.text();
    bytes += text.length; pages++;
    let page; try { page = JSON.parse(text); } catch { throw new HubError(r.status, 'bad_json'); }
    if (!r.ok) throw new HubError(r.status, page && page.error || 'error');
    for (const a of page.actions) { await state.receive(a); pulled++; }
    state.cursor = page.next;
    const now = JSON.stringify(state.viewer.groups);
    if (now !== groups && JSON.parse(now).some((g) => !JSON.parse(groups).includes(g))) { groups = now; state.cursor = 0; onProgress({ cursor: 0, head, actions: pulled, bytes, pages, phase: 'restart' }); continue; }
    groups = now;
    onProgress({ cursor: state.cursor, head, actions: pulled, bytes, pages, phase: 'pull' });
    if (!page.more) break;
    if (page.next <= before) throw new HubError(r.status, 'page_without_progress'); // a hub must advance next on every page it marks more; never spin on one
  }
  if (state.unopened.length) { onProgress({ cursor: state.cursor, head, actions: pulled, bytes, pages, phase: 'retry' }); await state.retryUnopened(); }
  return { pulled, bytes, pages, cursor: state.cursor, head };
}
