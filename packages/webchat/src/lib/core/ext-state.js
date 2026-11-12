// The instance's extension UI contributions (EXTENSIONS-V1 section 6: slots ui.sidebar.chatMenu and ui.palette.commands)
// as ONE declaration on the docstore kit core. Plain data the server answers at GET /api/ext/contributions: menu items
// { ext, slot, title, command, priority } and palette commands { ext, id, title, category }. scope 'local': the last
// answer is on disk, so the menus are there offline and at first paint; `contributions.set` replaces the whole answer
// (absolute; the same answer twice is the same state).
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const menu = (m) => (m && typeof m === 'object' && str(m.command) && str(m.title) ? { ext: str(m.ext, 48), slot: str(m.slot, 64), title: str(m.title, 80), command: str(m.command, 120), priority: Number(m.priority) || 0 } : null);
const command = (c) => (c && typeof c === 'object' && str(c.id) && str(c.title) ? { ext: str(c.ext, 48), id: str(c.id, 120), title: str(c.title, 80), category: str(c.category, 48) || null } : null);
const listOf = (item) => (v) => (Array.isArray(v) ? v.map(item).filter(Boolean).slice(0, 200) : []);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const extDecl = declare({
  name: 'ext-contributions',
  scope: 'local',
  fields: { menus: field([], listOf(menu)), commands: field([], listOf(command)) },
  actions: {
    'contributions.set': (s, p = {}) => {
      const next = { ...s, menus: listOf(menu)(p?.menus), commands: listOf(command)(p?.commands) };
      return same(next.menus, s.menus) && same(next.commands, s.commands) ? s : next;
    }
  }
});

/** The menu items of one slot, in order. */
export const menusOf = (s, slot) => (s?.menus || []).filter((m) => m.slot === slot);
