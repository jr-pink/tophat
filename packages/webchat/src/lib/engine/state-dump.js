// The normalized visible state of a chat session, legacy or engine, for the parity harness (webchat/tests/parity)
// and the differential tests: what the UI can show, with volatile bookkeeping removed, keys sorted, so two cores
// that show the same thing dump the same JSON.
//
//   window.__tophatState()            -> { core: 'docstore'|'legacy', conversations, items, cursor, status }
//   window.__tophatState({ raw: true }) -> also the engine's health (async)

const ROW_DROP = new Set(['rev', 'hydrated', 'pending']);
const ITEM_DROP = new Set(['rev']);
const STATUS_KEEP = ['online', 'reachable', 'offline', 'connected', 'cached', 'error', 'transcriptError', 'queued', 'rejected', 'skipped', 'backpressure'];

const pick = (obj, drop) => Object.fromEntries(Object.keys(obj || {}).sort().filter((k) => !drop.has(k)).map((k) => [k, obj[k]]));

export function normalizeState(state, status = {}) {
  const conversations = {};
  for (const id of Object.keys(state?.conversations || {}).sort()) conversations[id] = pick(state.conversations[id], ROW_DROP);
  const items = {};
  for (const id of Object.keys(state?.items || {}).sort()) items[id] = (state.items[id] || []).map((item) => pick(item, ITEM_DROP));
  const st = {};
  for (const k of STATUS_KEEP) if (status?.[k] !== undefined && status?.[k] !== null) st[k] = k === 'rejected' ? status[k].map((r) => ({ op: r.op, conversationId: r.conversationId, status: r.status })) : status[k];
  return { conversations, items, cursor: state?.cursor ?? 0, status: st };
}

export function installStateDump(session, { core = 'legacy', win = globalThis.window } = {}) {
  if (!win) return () => {};
  win.__tophatState = async ({ raw = false } = {}) => {
    const out = { core, ...normalizeState(session.state, session.status) };
    if (raw && session.health) out.health = await session.health();
    if (raw && session.mainThreadCost) out.mainThread = session.mainThreadCost();
    return out;
  };
  return () => { delete win.__tophatState; };
}

/** window.__parityProbe for the engine path (tests/parity reads it; the legacy path is read from its localStorage outbox). */
export function installParityProbe(session, { win = globalThis.window } = {}) {
  if (!win || typeof session.probe !== 'function') return () => {};
  win.__parityProbe = {
    outboxDepth: () => session.probe().outboxDepth(),
    outboxTexts: () => session.probe().outboxTexts(),
    engine: () => session.probe().engine()
  };
  return () => { delete win.__parityProbe; };
}
