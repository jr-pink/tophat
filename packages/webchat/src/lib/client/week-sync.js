// Keeping the last week of every conversation on this device, whether or not he opened it.
//
// The replica used to hold only what this tab happened to see: the live stream while it was open,
// the handful of chats bootstrap hydrates, and the chats he clicked. A chat that moved while the
// phone was asleep, and that he never opened, was not on the device at all when the tunnel went
// down.
//
// The server is a sync peer here, not the source of the screen. This walks the conversations
// active in the window, newest first, and copies each one's events into the replica from the last
// cursor held contiguously from its start (`synced[id]`), so a run after the first is a cursor
// delta, not a re-download. It folds nothing into the live state: the transcript is read out of
// the replica when he opens the chat, exactly as a cold open reads it. It stops at the first
// sign the server is unreachable and picks up from the same place next time.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SYNC_PAGE = 5000;

const activityOf = (conversation) => conversation?.activeAt || conversation?.updatedAt || conversation?.createdAt || '';

/**
 * Which conversations to hold, newest activity first: every one active within `windowMs`, plus
 * pinned ones, archived or not (an archived chat is one he stopped looking at, not one that is done).
 */
export function syncPlan(conversations, { now = Date.now(), windowMs = WEEK_MS, provisional = () => false } = {}) {
  const cutoff = now - windowMs;
  return (conversations || [])
    .filter((conversation) => conversation?.id && !provisional(conversation.id))
    .filter((conversation) => {
      const at = Date.parse(activityOf(conversation));
      return conversation.pinned || (Number.isFinite(at) && at >= cutoff);
    })
    .sort((a, b) => String(activityOf(b)).localeCompare(String(activityOf(a))))
    .map((conversation) => conversation.id);
}

/** The highest cursor in a page, or the floor it was asked from when the page is empty. */
export function highestCursor(events, floor = 0) {
  let high = floor;
  for (const event of events || []) if (Number.isSafeInteger(event?.cursor) && event.cursor > high) high = event.cursor;
  return high;
}

/** Thrown when the far end is not a server that can answer: no connection, a 5xx, or HTML. */
export class Unreachable extends Error {
  constructor(message) { super(message); this.name = 'Unreachable'; }
}

/**
 * Whether a response came from the app or from something in the way of it. A Cloudflare 502/530
 * page is HTML with a 5xx; a captive portal is HTML with a 200. Neither is the app saying anything
 * about his data or his session.
 */
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
export function fromApp(response) {
  if (!response) return false;
  if (GATEWAY.has(response.status)) return false;
  const type = response.headers?.get?.('content-type') || '';
  return !type || type.includes('json');
}

/**
 * Copy the window into the replica. Returns what happened, for status and tests. `shouldStop` lets
 * the session abandon the run (the tab went to the background, a newer run started).
 */
export async function syncWindow({ fetchImpl, replica, conversations, now = Date.now(), windowMs = WEEK_MS,
  provisional, shouldStop = () => false, pause = () => new Promise((resolve) => setTimeout(resolve, 30)),
  pageSize = SYNC_PAGE } = {}) {
  const result = { planned: 0, synced: 0, events: 0, unreachable: false, stopped: false };
  if (!replica?.readSynced || !fetchImpl) return result;
  const plan = syncPlan(conversations, { now, windowMs, provisional });
  result.planned = plan.length;
  const synced = { ...(await replica.readSynced()) };
  for (const id of plan) {
    if (shouldStop()) { result.stopped = true; break; }
    let after = Number(synced[id]) || 0;
    let held = null;
    try {
      for (;;) {
        let response;
        try {
          response = await fetchImpl(`/api/conversation/${encodeURIComponent(id)}?after=${after}&limit=${pageSize}`);
        } catch (cause) { throw new Unreachable(cause?.message || 'network'); }
        if (response.status === 404) break; // gone on the server; nothing to hold
        if (!fromApp(response)) throw new Unreachable(`conversation ${response.status}`);
        if (!response.ok) break; // a verdict on this chat (401, 403): leave it, keep going
        let body;
        try { body = await response.json(); } catch { throw new Unreachable('not json'); }
        const events = Array.isArray(body?.events) ? body.events : [];
        if (events.length) {
          held ??= new Set(await replica.conversationCursors(id));
          const fresh = events.filter((event) => Number.isSafeInteger(event?.cursor) && !held.has(event.cursor));
          if (fresh.length) {
            await replica.append(fresh);
            for (const event of fresh) held.add(event.cursor);
            result.events += fresh.length;
          }
        }
        const next = highestCursor(events, after);
        if (next === after || events.length < pageSize) { after = next; break; }
        after = next;
        // The store answers synchronously; a breath between pages keeps a first sync of a busy
        // week from holding the live chat's requests behind it.
        await pause();
      }
    } catch (cause) {
      if (cause instanceof Unreachable) { result.unreachable = true; break; }
      throw cause;
    } finally {
      if (after > (Number(synced[id]) || 0)) {
        synced[id] = after;
        await replica.writeSynced(synced);
      }
    }
    result.synced += 1;
    await pause();
  }
  return result;
}
