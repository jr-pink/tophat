// One sync round for a replica: push what this device logged and the hub has not acknowledged,
// then pull everything after the cursor in hub order. Any transport failure leaves the replica
// exactly as it was; the next round resumes from the same cursor and the same pending actions.
export function httpTransport(baseUrl, token, { timeoutMs = 15000 } = {}) {
  const call = async (method, path, body) => {
    const r = await fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const out = await r.json();
    if (!r.ok) { const e = new Error(`hub ${r.status} ${out.error}`); e.status = r.status; e.body = out; throw e; }
    return out;
  };
  return { push: (body) => call('POST', '/v1/push', body), pull: (after) => call('GET', `/v1/pull?after=${after}&limit=500`) };
}
/** The hub in-process (tests, model check): same handler as HTTP, with a switch to take it down. */
export function localTransport(hub, token) {
  const t = { up: true };
  const call = async (method, path, body) => {
    if (!t.up) { const e = new Error('hub unreachable'); e.code = 'ECONNREFUSED'; throw e; }
    const [status, out] = await hub.handle(method, path, { authorization: `Bearer ${token}` }, body ? JSON.stringify(body) : '');
    if (status !== 200) { const e = new Error(`hub ${status} ${out.error}`); e.status = status; e.body = out; throw e; }
    return JSON.parse(JSON.stringify(out));
  };
  t.push = (body) => call('POST', '/v1/push', body); t.pull = (after) => call('GET', `/v1/pull?after=${after}&limit=500`);
  return t;
}

const PUSH_ACTIONS = 100, PUSH_BYTES = 8 * 1024 * 1024;
export async function syncOnce(store, transport) {
  store.flush();
  let pushed = 0, pulled = 0;
  // A group gained is history to read: the hub filters by current membership, so start over;
  // parts already applied are skipped by id.
  const groupsKey = () => JSON.stringify(store.groupsOf(store.user));
  let cursor = Number(store.one("SELECT v FROM mc_meta WHERE k='cursor'")?.v ?? 0);
  const pullAll = async () => {
    let groups = groupsKey();
    for (let round = 0; round < 1000; round++) { // bounded: a page always advances the cursor
      const page = await transport.pull(cursor);
      for (const a of page.actions) { store.receive(a); pulled++; }
      cursor = page.next;
      store.tx(() => store.run("INSERT INTO mc_meta(k,v) VALUES('cursor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [String(cursor)]));
      const now = groupsKey();
      if (now !== groups && JSON.parse(now).some((g) => !JSON.parse(groups).includes(g))) { groups = now; cursor = 0; continue; }
      groups = now;
      if (!page.more) break;
    }
  };
  // Pull before push: an action the hub accepted whose acknowledgement never reached us (the process was killed
  // or timed out mid-push) comes back here as our own and settles locally. Pushing it again would re-seal it with
  // fresh randomness and the hub refuses an id it holds with different parts (409 action_id_reused), forever.
  // A position the hub gave to a different action of this device is reconciled in receive() (reconcileFork).
  await pullAll();
  const pending = store.pendingActions();
  // Chunked (the hub takes at most 500 actions and 32 MB per push): every chunk is acknowledged before the next goes,
  // so a failure part-way leaves the acknowledged ones settled and the rest pending, resumed by the next round.
  for (let i = 0; i < pending.length;) {
    const chunk = [];
    let bytes = 0;
    while (i < pending.length && chunk.length < PUSH_ACTIONS && (chunk.length === 0 || bytes < PUSH_BYTES)) {
      const sealed = store.sealAction(pending[i++]);
      bytes += JSON.stringify(sealed).length;
      chunk.push(sealed);
    }
    const { acks } = await transport.push({ actions: chunk });
    for (const a of acks) store.ack(a.id, a.seq, a.rejected ?? null);
    pushed += acks.length;
  }
  if (pushed) await pullAll();
  store.retryUnopened();
  return { pushed, pulled, cursor };
}

/** The hub log up to `upTo` (default: this replica's cursor) as this replica pulls it, in hub order; for TenantStore.regrant. */
export async function pullLog(store, transport, upTo = Number(store.one("SELECT v FROM mc_meta WHERE k='cursor'")?.v ?? 0)) {
  const out = [];
  let after = 0;
  for (let round = 0; round < 100000 && after < upTo; round++) {
    const page = await transport.pull(after);
    for (const a of page.actions) if (a.seq <= upTo) out.push(a);
    if (page.next <= after) break;
    after = page.next;
    if (!page.more) break;
  }
  return out;
}
