// The chat sidebar's device state as ONE declaration on the docstore-ui-kit core (tools/quicklook-kit/lib/model.js):
// which folders are open, the folders made on this device, their layout, the folder he is working in, whether the
// Inbox is folded, and the list's width. Pure absolute-state actions; hydrate, coalesced save, versioning and the
// legacy import are the kit's....
//
// scope 'local': per device, never pushed (which folder he is in and how wide the list is are per device).
// Folder membership rides on each chat (conversation.workspace), not here.
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { setMember } from '../../../../runner/tools/quicklook-kit/lib/fields.js';
import { field, bool, num, list, flags, set, on } from '../../../../runner/tools/quicklook-kit/lib/schema.js';
import { UNFILED, canonicalWorkspace, cleanLayout, emptyLayout, folderKey, moveFolder, normalizeWorkspace, removedLayout, renamedIn, renamedLayout, withName, withoutName } from './workspaces.js';

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
    layout: field(emptyLayout(), cleanLayout),
    mainFolded: bool(),
    width: num(null, { int: true })
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
    'folder.create': on('names', (names, { name }) => withName(names, canonicalWorkspace(name))),
    'folder.rename': (s, { from, to }) => {
      const clean = normalizeWorkspace(to);
      if (!clean || clean === from) return s;
      const a = folderKey(from), b = folderKey(clean);
      return { ...s, names: renamedIn(s.names, from, clean), layout: renamedLayout(s.layout, from, clean), open: swapKey(s.open, a, b), current: s.current === from ? clean : s.current };
    },
    'folder.remove': (s, { name }) => ({ ...s, names: withoutName(s.names, name), layout: removedLayout(s.layout, name), current: s.current === name ? null : s.current }),
    // `all` is every folder name on screen (device names plus names found on chats): the move is a pure function of it.
    'folder.move': on('layout', (layout, { all, drag, target, where }) => moveFolder(all, layout, drag, target, where)),
    'workspace.enter': set('current', 'name'),
    'main.fold': set('mainFolded', 'folded'),
    'width.set': set('width', 'px')
  }
});

export const normalize = sidebarDecl.normalize;
/** The open-folder key for a folder name (null is the Inbox as a folder). */
export const openKey = (name) => folderKey(name ?? null);
export { UNFILED };
