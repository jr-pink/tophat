// Find in chat (⌘F) as ONE declaration on the docstore kit core. Per chat: whether the find bar is open, what is typed in it,
// which match is current, and (never saved) whether the chat's earlier pages are still loading for it or could not all be
// fetched. The bar and the transcript highlight are projections of this; FindBar keeps nothing of its own. Whether find reads
// tool calls is a device preference, core/prefs-state.js `find.tools`, not here.
//
// storage 'tab': a window's open finds are its own, like its panes (core/panes-state.js), and come back on its reload. Keyed
// by chat id: two panes showing one chat show one find bar state, never two copies that can drift.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field, flags, on } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const isChat = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const STATUS = ['loading', 'partial', 'whole'];
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const mapOf = (ok) => (v) => Object.fromEntries(Object.entries(plain(v)).filter(([k, x]) => isChat(k) && ok(x)).slice(0, 200));
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 500;
const index = (v) => Number.isInteger(v) && v > 0 && v < 100_000;
const status = (v) => STATUS.includes(v);
// One chat's entry set (or removed when `value` is its default), the same map when it already is.
const put = (map, chat, value, keep) => {
  if (!isChat(chat)) return map;
  if (keep(value)) return map[chat] === value ? map : { ...map, [chat]: value };
  if (!(chat in map)) return map;
  const { [chat]: _gone, ...rest } = map;
  return rest;
};

export const findDecl = declare({
  name: 'find',
  scope: 'local',
  storage: 'tab',
  fields: {
    open: flags(),
    query: field({}, mapOf(text)),
    // the current match, 0 (the first) is the default and is not stored
    index: field({}, mapOf(index)),
    // the chat's earlier pages, fetched so find covers all of it: loading, partial (some could not be fetched) or whole
    status: field({}, mapOf(status), { ephemeral: true })
  },
  actions: {
    // Open or closed. Closing clears what was typed and the current match: a bar opened again starts empty.
    'find.open': (s, { chat, open } = {}) => {
      if (!isChat(chat)) return s;
      const yes = open === true;
      const next = {
        ...s,
        open: put(s.open, chat, yes || undefined, (v) => v === true),
        query: yes ? s.query : put(s.query, chat, undefined, text),
        index: yes ? s.index : put(s.index, chat, undefined, index)
      };
      return next.open === s.open && next.query === s.query && next.index === s.index ? s : next;
    },
    // What is typed: a new query starts at the first match.
    'find.query': (s, { chat, text: t } = {}) => {
      if (!isChat(chat)) return s;
      const query = put(s.query, chat, typeof t === 'string' ? t.slice(0, 500) : undefined, text);
      if (query === s.query) return s;
      return { ...s, query, index: put(s.index, chat, undefined, index) };
    },
    'find.index': on('index', (m, { chat, index: i } = {}) => put(m, chat, i, index)),
    'find.status': on('status', (m, { chat, status: st } = {}) => put(m, chat, st, status))
  }
});
