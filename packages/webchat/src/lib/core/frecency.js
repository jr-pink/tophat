import { isDeferred } from './defer.js';
import { indicatorOf, unreadOf } from './rowstate.js';

export const HALF_LIFE_HOURS = 6;
const AGE_FLOOR = 0; 

const DEPTH_CAP = 4;
const RUNNING = new Set(['queued', 'starting', 'thinking', 'running']);

function hoursBetween(nowMs, iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - then) / 3_600_000);
}

export function frecency(conversation, nowMs) {
  const age = hoursBetween(nowMs, conversation.activeAt || conversation.updatedAt);
  const decay = Number.isFinite(age) ? 2 ** (-age / HALF_LIFE_HOURS) : 0;
  const depth = Math.min(1 + 0.8 * Math.log2(1 + (conversation.turns || 0)), DEPTH_CAP);
  return depth * (AGE_FLOOR + (1 - AGE_FLOOR) * decay);
}

// `onlyArchived`, `onlyAside` and `onlyDeferred` are the three folded trays at the foot of the
// sidebar: the same ranking, over the chats he has put down. None of them changes a run, so a
// parked chat can still be live, and it is only its own tray that shows it.
//
// The trays do not overlap. Archived wins over set aside, set aside over deferred, and a chat
// whose defer hour has passed is not in any of them: it is back in the main list by itself,
// because the clock decided that and nothing has to run for it to happen.
export function rankConversations(conversations, { now = Date.now(), query = '', match = null, includeArchived = false, onlyArchived = false, onlyAside = false, onlyDeferred = false, includeSidechats = false, sorted = true } = {}) {
  const needle = query.trim().toLowerCase();
  const parked = (c) => Boolean(c.aside) || isDeferred(c, now);
  const rows = Object.values(conversations)
    .filter((c) => (
      onlyArchived ? Boolean(c.archived)
      : onlyAside ? (!c.archived && Boolean(c.aside))
      : onlyDeferred ? (!c.archived && !c.aside && isDeferred(c, now))
      : (includeArchived || !c.archived) && !parked(c)))
    .filter((c) => (includeSidechats || !c.sidechat))
    .filter((c) => (match ? match.has(c.id) : !needle || `${c.title} ${c.preview}`.toLowerCase().includes(needle)))
    .map((c) => ({ ...c, score: frecency(c, now), live: RUNNING.has(c.runState), unread: unreadOf(c), indicator: indicatorOf(c) }));
  if (!sorted) return rows;
  return rows.sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.live) - Number(a.live) ||
      b.score - a.score ||
      String(b.activeAt || b.updatedAt).localeCompare(String(a.activeAt || a.updatedAt)) ||
      a.id.localeCompare(b.id));
}

export function trayCounts(conversations, { now = Date.now(), match = null, includeSidechats = false } = {}) {
  const counts = { archived: 0, aside: 0, deferred: 0, archivedLive: 0 };
  for (const c of Object.values(conversations)) {
    if (!includeSidechats && c.sidechat) continue;
    if (match && !match.has(c.id)) continue;
    if (c.archived) {
      counts.archived += 1;
      const indicator = indicatorOf(c);
      if (indicator === 'live' || indicator === 'live-muted') counts.archivedLive += 1;
    } else if (c.aside) counts.aside += 1;
    else if (isDeferred(c, now)) counts.deferred += 1;
  }
  return counts;
}

export function groupForks(ranked) {
  const byId = new Map(ranked.map((c) => [c.id, c]));
  const children = new Map();
  for (const c of ranked) {
    if (c.parentId && byId.has(c.parentId)) {
      children.set(c.parentId, [...(children.get(c.parentId) || []), c]);
    }
  }
  return ranked
    .filter((c) => !c.parentId || !byId.has(c.parentId))
    .map((c) => ({ ...c, forks: children.get(c.id) || [] }));
}
