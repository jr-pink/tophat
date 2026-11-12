// The tab's journal of what he made and has not yet seen delivered: one module, used by both chat cores (the engine's tab host,
// engine/session-host.js, and the legacy per-tab session, client/session.js, which incognito, rooms and the rollback path still run).
//
// the chat showed it; the server never got the chat or the message, and after two reloads there was nothing to replay. The shape that
// lost it was fire-and-forget: draw the echo, make a call, forget.
//   1. `track` writes the action to this tab's own storage (localStorage, kit outbox-local.js), synchronously, before the echo
//      is drawn and before any call; a storage that refuses is said (journalError, a `journal_failed` record);
//   2. the action leaves the journal only when delivery is confirmed durable: `deliver` answers (the engine core holds it on
//      disk, or the server has it) or the core calls `settle(id)` itself (the legacy session: the server answered 2xx, or
//      refused the body for good and said so);
//   3. a `deliver` that rejects, answers `durable: false`, or never answers is asked again under the same action id (the engine
//      and the server both dedupe on it): backoff `retryMs` after a failure, `stuck` after `stallMs` (reported, and the tab is
//      shown offline), then every `resubmitMs`; a reply `{ pending: true }` means "asked; I will settle it myself";
//   4. rows left by an earlier life of the tab (a reload, a crash) are drawn at once (`restore`), sent when the core is up
//      (`submitReplayed`), and everything held is asked again when the network or the page returns (`resubmitAll`);
//   5. telemetry kinds stuck / call_failed / recovered / replayed / journal_failed go to /api/client-lag (server/client-lag.js).
// Only message sends, chat creations and forks are journaled (`ops`); the rest keep their plain one-shot path.
import { localOutbox } from '../../../../runner/tools/docstore-kit/lib/engine/outbox-local.js';
import { createEphemeralPost } from '../../../../runner/tools/docstore-kit/lib/engine/ephemeral.js';
import { ACTIONS } from '../core/contract.js';

export const JOURNAL_KEY = 'qk-outbox:chat-tab';
export const JOURNALED_OPS = Object.freeze(new Set([ACTIONS.SEND, ACTIONS.CREATE, ACTIONS.FORK]));
export const RETRY_BACKOFF_MS = Object.freeze([2000, 5000, 12_000, 30_000]);

/**
 * @param {object} o
 * @param {Storage|null} o.storage             where the journal lives; null journals nothing (incognito must leave nothing on disk)
 * @param {string} [o.key]                     the storage key, shared by both cores so a rollback finds what the other left
 * @param {(entry:{id,op,conversationId,payload,at}) => Promise<any>} o.deliver  one attempt; `{durable:false}` or a throw is a failure
 * @param {(entry) => void} [o.onChange]       a hold appeared, settled or stalled: the core recomputes what it shows
 * @param {(row) => void} [o.report]           telemetry sink; default posts to /api/client-lag
 * @param {() => object} [o.context]           extra fields for every telemetry row (engine kind, online flag, calls pending)
 */
export function createSendJournal({
  storage, key = JOURNAL_KEY, deliver, onChange = () => {}, report = null, context = () => ({}), ops = JOURNALED_OPS,
  stallMs = 12_000, resubmitMs = 20_000, retryMs = RETRY_BACKOFF_MS,
  setTimer = (...a) => globalThis.setTimeout(...a), clearTimer = (...a) => globalThis.clearTimeout(...a), wallClock = () => Date.now()
}) {
  let journal = null;
  try { journal = storage ? localOutbox({ storage, key }) : null; } catch { journal = null; }
  const held = new Map(); // action id -> { id, op, conversationId, payload, at, since, tries, stalled, timer, lastError }
  let journalError = null;
  const ephemeral = report ? null : createEphemeralPost();
  const tell = (record) => {
    const row = { at: new Date().toISOString(), ...context(), ...record };
    try { if (report) report(row); else ephemeral('/api/client-lag', { body: { records: [row] }, keepalive: true }).catch(() => {}); } catch { /* telemetry never throws into a send */ }
  };
  const changed = (entry) => { try { onChange(entry); } catch { /* the core's recompute never breaks delivery */ } };

  const journals = (op) => ops.has(op);
  const has = (id) => held.has(id);

  /** First thing a journaled action does, before the echo is drawn and before any call: the row is on this device or the failure is said. */
  function track({ id, op, conversationId, payload, at }) {
    try { journal?.putSync([{ id, stream: String(conversationId), body: { op, conversationId, payload, at, actionId: id } }]); }
    catch (cause) { journalError = String(cause?.message || cause); tell({ kind: 'delivery', event: 'journal_failed', durationMs: 0, id, op, conversation: conversationId, error: journalError }); }
    const entry = { id, op, conversationId, payload, at, since: wallClock(), tries: 0, stalled: false, timer: null, lastError: null };
    held.set(id, entry);
    return entry;
  }

  /** Start the clock without making a call: the core has already sent it by its own means (legacy: its delivery machine posts on dispatch). */
  function watch(id) { const hold = held.get(id); if (!hold) return false; hold.tries += 1; armStall(hold); return true; }

  /** One attempt to deliver `id`; the call may settle it, fail it (backoff) or leave it unanswered (the stall timer asks again). */
  async function submit(id) {
    const hold = held.get(id);
    if (!hold) return undefined;
    hold.tries += 1;
    armStall(hold);
    try {
      const reply = await deliver(hold);
      if (!held.has(id)) return reply;
      if (reply?.pending) return reply; // the core settles it itself (legacy: when the server answers); the stall timer is the guard
      if (reply?.durable === false) { failed(hold, 'the engine could not store it yet'); return undefined; }
      settle(id);
      return reply;
    } catch (cause) {
      failed(hold, String(cause?.message || cause), cause?.code);
      return undefined;
    }
  }
  function armStall(hold) {
    if (hold.timer) clearTimer(hold.timer);
    hold.timer = setTimer(() => {
      hold.timer = null;
      if (!held.has(hold.id)) return;
      if (!hold.stalled) {
        hold.stalled = true;
        tell({ kind: 'delivery', event: 'stuck', durationMs: wallClock() - hold.since, id: hold.id, op: hold.op, conversation: hold.conversationId, tries: hold.tries });
        changed(hold);
      }
      submit(hold.id); // not answered: ask again under the same id (idempotent in the engine and at the server)
    }, hold.tries <= 1 ? stallMs : resubmitMs);
    hold.timer?.unref?.();
  }
  /** Delivery is confirmed durable (or the server refused the body for good and said so): the action leaves the journal. */
  function settle(id) {
    const hold = held.get(id);
    if (!hold) return false;
    if (hold.timer) clearTimer(hold.timer);
    held.delete(id);
    try { journal?.deleteSync([id]); } catch { /* the core holds it; a stale row replays idempotently */ }
    if (hold.stalled) tell({ kind: 'delivery', event: 'recovered', durationMs: wallClock() - hold.since, id, op: hold.op, conversation: hold.conversationId, tries: hold.tries });
    changed(hold);
    return true;
  }
  function failed(hold, reason, code = null) {
    if (!held.has(hold.id)) return;
    if (hold.timer) { clearTimer(hold.timer); hold.timer = null; }
    hold.lastError = reason;
    tell({ kind: 'delivery', event: 'call_failed', durationMs: wallClock() - hold.since, id: hold.id, op: hold.op, conversation: hold.conversationId, tries: hold.tries, error: reason, code });
    hold.timer = setTimer(() => { hold.timer = null; if (held.has(hold.id)) submit(hold.id); }, retryMs[Math.min(hold.tries - 1, retryMs.length - 1)]);
    hold.timer?.unref?.();
    changed(hold);
  }

  /** Rows from an earlier life of this tab (a reload, a crash, another tab that left them): held, and handed to `draw` to show. Rows already held or `skip`ped are left alone. */
  function restore({ skip = () => false, draw = () => {} } = {}) {
    let rows = [];
    try { rows = journal?.rows() ?? []; } catch { rows = []; }
    let n = 0;
    for (const row of rows) {
      const b = row.body;
      if (!b?.actionId || !b.op || held.has(b.actionId) || skip(b.actionId)) continue;
      const entry = { id: b.actionId, op: b.op, conversationId: b.conversationId, payload: b.payload ?? {}, at: b.at, since: wallClock(), tries: 0, stalled: false, timer: null, lastError: null };
      held.set(entry.id, entry);
      draw(entry);
      n += 1;
    }
    if (n) changed(null);
    return n;
  }
  /** Restored rows not yet sent are sent now (the core is up). */
  function submitReplayed() {
    let n = 0;
    for (const hold of [...held.values()]) if (!hold.timer && hold.tries === 0) { n += 1; submit(hold.id); }
    if (n) tell({ kind: 'delivery', event: 'replayed', durationMs: 0, count: n });
    return n;
  }
  /** The network came back, the page came back: everything still held is asked again (the core dedupes on the id). */
  function resubmitAll(restoreOptions = undefined) {
    if (restoreOptions) { try { restore(restoreOptions); } catch { /* none */ } }
    for (const hold of [...held.values()]) submit(hold.id);
  }
  /** What a core shows: `deliveryStalled` while any hold has gone unanswered past the stall bound (truthful offline), `journalError` if the storage refused. */
  function view() {
    const stalled = [...held.values()].filter((h) => h.stalled);
    return {
      deliveryStalled: stalled.length ? { count: stalled.length, oldestMs: wallClock() - Math.min(...stalled.map((h) => h.since)) } : null,
      journalError,
      owed: held.size
    };
  }
  return { journals, has, track, watch, submit, settle, restore, submitReplayed, resubmitAll, view, tell, get size() { return held.size; } };
}
