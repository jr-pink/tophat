// Which side threads are folded away, per surface (a chat id, or `doc:<token>` for a public document), as ONE declaration on the
// docstore kit core. This is the rail's fold state only. FOCUS is not here: which thread has the caret, which pane is active and
// what the passage highlight paints are all projections of the kit intent record (tools/docstore-kit/lib/intent.js), the one owner
// of focus.
//
// collapsed   per surface, the thread ids put away (their mark in the text still opens them). Ephemeral: a reload draws every
//             thread as it was made.
// Absolute, idempotent actions; a repeat returns the same state.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const isKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const cleanCollapsed = (v) => Object.fromEntries(Object.entries(plain(v))
  .filter(([k, ids]) => isKey(k) && Array.isArray(ids))
  .map(([k, ids]) => [k, [...new Set(ids.filter(isKey))]])
  .filter(([, ids]) => ids.length)
  .slice(-100));

const EMPTY = Object.freeze([]);
export const collapsedOf = (state, key) => state.collapsed[key] || EMPTY;

const put = (s, key, ids) => {
  const had = s.collapsed[key] || EMPTY;
  if (had.length === ids.length && had.every((id, i) => id === ids[i])) return s;
  if (!ids.length) { const { [key]: _gone, ...rest } = s.collapsed; return { ...s, collapsed: rest }; }
  return { ...s, collapsed: { ...s.collapsed, [key]: ids } };
};

export const sidechatDecl = declare({
  name: 'sidechat',
  scope: 'local',
  fields: { collapsed: field({}, cleanCollapsed, { ephemeral: true }) },
  actions: {
    'thread.collapse': (s, p) => (isKey(plain(p).key) && isKey(plain(p).id) ? put(s, p.key, collapsedOf(s, p.key).includes(p.id) ? collapsedOf(s, p.key) : [...collapsedOf(s, p.key), p.id]) : s),
    'thread.expand': (s, p) => (isKey(plain(p).key) && isKey(plain(p).id) ? put(s, p.key, collapsedOf(s, p.key).filter((other) => other !== p.id)) : s),
    // The surface's live threads changed: forget the ones that are gone.
    'thread.prune': (s, p) => (isKey(plain(p).key) && Array.isArray(plain(p).ids) ? put(s, p.key, collapsedOf(s, p.key).filter((id) => p.ids.includes(id))) : s)
  }
});
