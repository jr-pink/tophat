// The public documents' client state on the docstore-ui-kit core. Four declarations replace four hand-rolled localStorage
// families:
//   docsDecl            ONE state for the commenter name (was read by DocPage and DocNamePrompt, each with its own copy,
//                       and stale across tabs), the per-document meta cache and the /docs list cache. local, crossTab.
//   docThreadsDecl(t)   the threads last seen for a document (offline paint). local.
//   docCommentsDecl(t)  what this device wrote in a document: comments and resolves as an op log with a reducer. scope
//                       'cloud': every action is a Stream entry (entry_id device:seq), replayed through the same
//                       reducers on any device; idempotent by comment id, by resolve time and by thread id (a delete).
// `overlayThreads` is the pure view: the server's threads plus the actions not yet delivered.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field, on, scratch, set } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const META_CAP = 100;

const cleanMeta = (v) => {
  const entries = Object.entries(plain(v)).filter(([, m]) => m && typeof m === 'object').map(([t, m]) => [t, { title: str(m.title), owner: Boolean(m.owner), bound: Boolean(m.bound) }]);
  return Object.fromEntries(entries.slice(-META_CAP));
};
const cleanList = (v) => (Array.isArray(v) ? v.filter((d) => d && typeof d.token === 'string') : []);

const NAME = 'tophat.docs.name', LIST = 'tophat.docs.list', META = 'tophat.docs.meta.';
const parse = (raw) => { try { return JSON.parse(raw); } catch { return undefined; } };

/** One-time import of the old keys (name: a bare string; list: JSON; meta: one key per document). The old keys stay in place. */
function legacyDocs(storage) {
  const out = {};
  const name = storage.getItem(NAME);
  if (name) out.name = name;
  const list = parse(storage.getItem(LIST));
  if (Array.isArray(list)) out.list = list;
  const meta = {};
  for (let i = 0; i < (storage.length || 0); i++) {
    const key = storage.key(i);
    if (key?.startsWith(META)) { const m = parse(storage.getItem(key)); if (m && typeof m === 'object') meta[key.slice(META.length)] = m; }
  }
  if (Object.keys(meta).length) out.meta = meta;
  return Object.keys(out).length ? out : null;
}

export const docsDecl = declare({
  name: 'docs', scope: 'local', crossTab: true,
  fields: { name: field('', str), meta: field({}, cleanMeta), list: field([], cleanList) },
  legacy: legacyDocs,
  actions: {
    'name.set': set('name', 'name'),
    'meta.set': on('meta', (meta, { token, title, owner, bound }) => {
      const next = { title: str(title), owner: Boolean(owner), bound: Boolean(bound) };
      return JSON.stringify(meta[token]) === JSON.stringify(next) ? meta : { ...Object.fromEntries(Object.entries(meta).filter(([t]) => t !== token)), [token]: next };
    }),
    'list.set': set('list', 'docs'),
    'list.remove': on('list', (list, { token }) => (list.some((d) => d.token === token) ? list.filter((d) => d.token !== token) : list))
  }
});

export const docThreadsDecl = (token) => declare({
  name: `doc-threads:${token}`, scope: 'local',
  // `armed` is the thread whose Delete was pressed once (the second press deletes); ephemeral, never saved.
  fields: { threads: field([], (v) => (Array.isArray(v) ? v : [])), armed: scratch(null) },
  legacy: [{ key: `tophat.docs.threads.${token}`, json: true, into: 'threads' }],
  actions: {
    'threads.set': set('threads', 'threads'),
    'delete.arm': on('armed', (armed, { threadId }) => (str(threadId) && armed !== threadId ? threadId : armed)),
    'delete.disarm': on('armed', (armed) => (armed === null ? armed : null))
  }
});

// ---- comments: the op log ----------------------------------------------------------------------------------------

const COMMENT_KEYS = ['id', 'threadId', 'lineId', 'quote', 'start', 'end', 'body', 'author', 'at'];
const cleanComment = (c) => {
  const p = plain(c);
  if (!str(p.id) || !str(p.threadId) || !str(p.body).trim()) return null;
  const out = Object.fromEntries(COMMENT_KEYS.map((k) => [k, k === 'start' || k === 'end' ? Math.max(0, Math.floor(Number(p[k]) || 0)) : str(p[k])]));
  out.owner = Boolean(p.owner);
  return out;
};
const cleanResolved = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([, r]) => r && typeof r === 'object').map(([t, r]) => [t, { resolved: Boolean(r.resolved), at: str(r.at) }]));
const cleanDeleted = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([, d]) => d && typeof d === 'object').map(([t, d]) => [t, { at: str(d.at) }]));
const cleanComments = (v) => Object.fromEntries(Object.entries(plain(v)).map(([id, c]) => [id, cleanComment(c)]).filter(([, c]) => c));

// The two merge rules: a comment id is written once (the first entry in the total order stands, as the server keeps the
// first copy of an id); a resolve is a last-writer-wins register on its `at`.
export const commentAdd = (comments, payload) => {
  const c = cleanComment(payload);
  return !c || comments[c.id] ? comments : { ...comments, [c.id]: c };
};
export const threadResolve = (resolved, { threadId, resolved: flag, at }) => {
  if (!str(threadId)) return resolved;
  const next = { resolved: Boolean(flag), at: str(at) };
  const have = resolved[threadId];
  if (have && (have.at > next.at || (have.at === next.at && have.resolved === next.resolved))) return resolved;
  return { ...resolved, [threadId]: next };
};

// A delete is a tombstone on the thread id: the earliest `at` is kept, so the same entry twice, or entries in any order,
// leave the same state. The comments of a deleted thread stay in `comments` (a reply that arrives after the delete is
// written once like any comment) and are hidden by `threadsOf` and `overlayThreads`: delete and reply commute.
export const threadDelete = (deleted, { threadId, at }) => {
  if (!str(threadId)) return deleted;
  const have = deleted[threadId];
  if (have && have.at <= str(at)) return deleted;
  return { ...deleted, [threadId]: { at: str(at) } };
};

/** The actions an old comments outbox held, as reducer actions (the old key is archived and removed by the kit). */
export const outboxToActions = (list) => (Array.isArray(list) ? list : []).flatMap((op) => {
  if (op?.kind === 'resolve') return [['thread.resolve', { threadId: op.threadId, resolved: Boolean(op.resolved), at: str(op.at) || new Date(0).toISOString() }]];
  return op?.body ? [['comment.add', { ...op.body, at: str(op.at), author: '', owner: false }]] : [];
});

export const docCommentsDecl = (token) => declare({
  name: `doc-comments:${token}`, scope: 'cloud',
  fields: { comments: field({}, cleanComments), resolved: field({}, cleanResolved), deleted: field({}, cleanDeleted) },
  legacy: [{ key: `tophat.docs.comments-outbox.${token}`, json: true, actions: outboxToActions }],
  actions: {
    'comment.add': on('comments', commentAdd),
    'thread.resolve': on('resolved', threadResolve),
    'thread.delete': on('deleted', threadDelete)
  }
});

/** The replicated state as threads (what every device converges to): comments grouped by thread, a resolve overlaid. */
export function threadsOf(state) {
  const byId = new Map();
  for (const c of Object.values(state.comments).filter((c) => !state.deleted?.[c.threadId]).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))) {
    if (!byId.has(c.threadId)) byId.set(c.threadId, { id: c.threadId, lineId: c.lineId, quote: c.quote, start: c.start, end: c.end, comments: [], resolvedAt: null });
    byId.get(c.threadId).comments.push({ id: c.id, body: c.body, author: c.author, owner: c.owner, createdAt: c.at });
  }
  for (const [id, r] of Object.entries(state.resolved)) if (byId.has(id)) byId.get(id).resolvedAt = r.resolved ? r.at : null;
  return [...byId.values()];
}

/**
 * The threads as shown: the server's, plus the actions not yet delivered (the old outbox overlay, the same rules):
 * an undelivered resolve flips the thread, an undelivered comment joins its thread (or makes it, marked pending), an
 * undelivered delete removes the thread, and nothing written for it, before or after, brings it back.
 * `pending` is replica.pending (entries {type, payload}); `me` names the author of a comment written before names
 * were kept per comment.
 */
export function overlayThreads(threads, pending, { me, owner, now = () => new Date().toISOString() }) {
  const gone = new Set(pending.filter((e) => e.type === 'thread.delete').map((e) => e.payload.threadId));
  const byId = new Map(threads.filter((t) => !gone.has(t.id)).map((t) => [t.id, { ...t, comments: [...(t.comments || [])] }]));
  for (const { type, payload } of pending) {
    if (type === 'thread.delete' || gone.has(payload.threadId)) continue;
    if (type === 'thread.resolve') {
      const thread = byId.get(payload.threadId);
      if (thread) thread.resolvedAt = payload.resolved ? payload.at || now() : null;
      continue;
    }
    let thread = byId.get(payload.threadId);
    if (!thread) {
      thread = { id: payload.threadId, lineId: payload.lineId, quote: payload.quote, start: payload.start, end: payload.end, comments: [], resolvedAt: null, pending: true };
      byId.set(thread.id, thread);
    }
    if (!thread.comments.some((c) => c.id === payload.id)) {
      thread.comments.push({ id: payload.id, body: payload.body, author: payload.author || me, owner: payload.author ? payload.owner : owner, createdAt: payload.at, pending: true });
    }
  }
  return [...byId.values()];
}
