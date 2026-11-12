// The chat sidebar's device state as ONE declaration on the docstore-ui-kit core (tools/docstore-kit/lib/model.js):
// which folders are open, the folders made on this device, their layout, the folder he is working in, whether the
// Inbox is folded, and the list's width. Pure absolute-state actions; hydrate, coalesced save, versioning and the
// legacy import are the kit's....
//
// scope 'local': per device, never pushed (which folder he is in and how wide the list is are per device).
// Folder membership rides on each chat (conversation.workspace), not here.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { setMember } from '../../../../runner/tools/docstore-kit/lib/fields.js';
import { field, bool, num, list, flags, set, on, scratch } from '../../../../runner/tools/docstore-kit/lib/schema.js';
import { UNFILED, canonicalWorkspace, cleanLayout, emptyLayout, folderKey, miscKey, moveFolder, normalizeWorkspace, removedLayout, renamedIn, renamedLayout, withName, withoutName } from './workspaces.js';

const swapKey = (map, from, to) => {
  if (!map[from] || from === to) return map;
  const { [from]: _gone, ...rest } = map;
  return { ...rest, [to]: true };
};

export const sidebarDecl = declare({
  name: 'sidebar',
  scope: 'local',
  fields: {
    names: list(normalizeWorkspace),
    current: field(null, normalizeWorkspace),
    open: flags(),
    // Folders whose chats go quiet while the folder is collapsed (right-click: Mute When Collapsed), by folder key. A
    // preference, not a read mark: the unread state stays on the chats and the folder's dot comes back when it is expanded.
    // Per device, like which folders are open, which it is judged against. Owner request, 2026-11-11 22:20 PST: "lets
    // add mark as read and mute-when-closed options to the right click menu".
    muteCollapsed: flags(),
    layout: field(emptyLayout(), cleanLayout),
    mainFolded: bool(),
    // Whether archived folders (and their subtrees) draw, dimmed with an "archived" marker, instead of being hidden.
    showArchived: bool(),
    width: num(null, { int: true }),
    // The list is collapsed (wide windows; Cmd-B, the pill's menu, or dragging it narrow). Decided afresh each time a window
    // opens (core/window-start.js), so never saved.
    hidden: field(false, Boolean, { ephemeral: true }),
    // The explorer's keyboard cursor: the address of one visible row ('f:<folder key>' or 'c:<chat id>'), VS Code's
    // focused tree item. Per device; a cursor naming a row that is not on screen is simply not drawn.
    cursor: field(null, (v) => (typeof v === 'string' && v.length <= 300 ? v : null)),
    // A folder being created: the key of the folder it goes inside ('' = the top level), drawn as an editable row in the
    // tree at that place (VS Code's New Folder). null: none.
    newIn: field(null, (v) => (typeof v === 'string' && v.length <= 300 ? v : null)),
    // The folder whose name is being edited in place (Enter or F2 on it, VS Code's rename), by key; null: none.
    renaming: field(null, (v) => (typeof v === 'string' && v.length <= 300 ? v : null)),
    // Cut (⌘X) waiting for a paste (⌘V on a folder): one row address, 'f:<key>' or 'c:<chat id>'; null: nothing cut.
    clip: field(null, (v) => (typeof v === 'string' && v.length <= 300 ? v : null)),
    // The multi-selection (⌘-click toggles, ⇧-click a range, a plain click one row): row addresses, VS Code's selected
    // set, for right-click actions on all of them. A one-line result of a sidebar action (a re-sort's moves), shown under
    // the tools; never saved.
    notice: scratch(null),
    // The description being edited (a fold-down under its row with Save and Cancel; nothing is written until Save): its
    // address, 'f:<folder name>' or 'h:<host id>', and the draft. Never saved: a reload drops an unsaved edit, as Cancel does.
    descAt: field(null, (v) => (typeof v === 'string' && v.length <= 300 ? v : null), { ephemeral: true }),
    descDraft: field('', (v) => (typeof v === 'string' ? v.slice(0, 300) : ''), { ephemeral: true }),
    // The hosts dropdown under its button in the tools row is open. Never saved.
    hostMenu: field(false, Boolean, { ephemeral: true }),
    selection: field([], (v) => (Array.isArray(v) ? [...new Set(v.filter((a) => typeof a === 'string' && a.length <= 300))].slice(0, 500) : []))
  },
  // The keys the hand-written version used (workspaces.js readLocal, the main-folded flag, the width).
  legacy: [
    { key: 'tophat-workspaces:chats', json: true, read: (o) => o && ({
      names: o.names, current: o.current, layout: o.layout,
      open: Object.fromEntries((Array.isArray(o.open) ? o.open : []).filter((k) => typeof k === 'string').map((k) => [folderKey(k === UNFILED ? null : k), true]))
    }) },
    { key: 'tophat-workspaces:chats:main-folded', read: (v) => ({ mainFolded: v === '1' }) },
    { key: 'webchat.sidebarWidth', read: (v) => ({ width: Number(v) }) }
  ],
  actions: {
    // Folder open/closed is an absolute statement about one key (folderKey of its name).
    'folder.open': on('open', (open, { key, open: yes }) => setMember(open, key, yes)),
    // Mute When Collapsed is an absolute statement about one key, like folder.open: repeating it changes nothing.
    'folder.mute': on('muteCollapsed', (muted, { key, muted: yes }) => setMember(muted, key, yes)),
    'folder.create': on('names', (names, { name }) => withName(names, canonicalWorkspace(name))),
    'folder.rename': (s, { from, to }) => {
      const clean = normalizeWorkspace(to);
      if (!clean || clean === from) return s;
      const a = folderKey(from), b = folderKey(clean);
      const names = renamedIn(s.names, from, clean), layout = renamedLayout(s.layout, from, clean), open = swapKey(swapKey(s.open, a, b), miscKey(a), miscKey(b)), muteCollapsed = swapKey(s.muteCollapsed, a, b), current = s.current === from ? clean : s.current;
      return names === s.names && layout === s.layout && open === s.open && muteCollapsed === s.muteCollapsed && current === s.current ? s : { ...s, names, layout, open, muteCollapsed, current };
    },
    'folder.remove': (s, { name }) => {
      const names = withoutName(s.names, name), layout = removedLayout(s.layout, name), current = s.current === name ? null : s.current;
      // A removed folder takes its mute with it, so a folder made later under the same name starts loud.
      const muteCollapsed = setMember(s.muteCollapsed, folderKey(name), false);
      return names === s.names && layout === s.layout && muteCollapsed === s.muteCollapsed && current === s.current ? s : { ...s, names, layout, muteCollapsed, current };
    },
    // `all` is every folder name on screen (device names plus names found on chats): the move is a pure function of it.
    'folder.move': on('layout', (layout, { all, drag, target, where }) => moveFolder(all, layout, drag, target, where)),
    'workspace.enter': set('current', 'name'),
    'main.fold': set('mainFolded', 'folded'),
    'archived.show': set('showArchived', 'show'),
    'width.set': set('width', 'px'),
    'hidden.set': set('hidden', 'hidden'),
    'cursor.set': set('cursor', 'addr'),
    'newfolder.at': set('newIn', 'parent'),
    'rename.at': set('renaming', 'key'),
    'clip.set': set('clip', 'addr'),
    'selection.set': set('selection', 'addrs'),
    'notice.set': set('notice', 'text'),
    'desc.open': (s, { at, text } = {}) => {
      const descAt = typeof at === 'string' && at.length <= 300 ? at : null;
      const descDraft = descAt && typeof text === 'string' ? text.slice(0, 300) : '';
      return s.descAt === descAt && s.descDraft === descDraft ? s : { ...s, descAt, descDraft };
    },
    'desc.draft': (s, { text } = {}) => {
      if (!s.descAt) return s;
      const descDraft = typeof text === 'string' ? text.slice(0, 300) : '';
      return s.descDraft === descDraft ? s : { ...s, descDraft };
    },
    'desc.close': (s) => (s.descAt === null && s.descDraft === '' ? s : { ...s, descAt: null, descDraft: '' }),
    'hostmenu.open': set('hostMenu', 'open')
  }
});

export const normalize = sidebarDecl.normalize;
/** The open-folder key for a folder name (null is the Inbox as a folder). */
export const openKey = (name) => folderKey(name ?? null);
export { UNFILED };
