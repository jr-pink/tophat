// The chat page's panes as ONE declaration on the docstore-ui-kit core: which chats are open, their widths, which is
// focused, and the uncommitted blank chat. Pure absolute-state actions over core/panels.js; hydrate, coalesced save
// and the one-time import of the old `tophat.panes` key are the kit's. Hydrated at `uiApp().use(...)`, so the first
// render already has his panes.
//
// scope 'local' on the TAB's storage (`storage: 'tab'`): a second window has its own layout and a window opened
// fresh still lands in the new blank chat.
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { field, scratch, set, on, reset } from '../../../../runner/tools/quicklook-kit/lib/schema.js';
import { initial, activate, openBeside, openFor, focusPanel, closePanel, duplicatePanel, movePanel, togglePanel, resize, prune } from './panels.js';
import { LAYOUT_KEY, LAYOUT_VERSION, parseLayout, serializeLayout } from './panel-store.js';

const EMPTY = initial(null);
const valid = (layout) => (Array.isArray(layout?.panels) && !layout.panels.length) || parseLayout(JSON.stringify({ v: LAYOUT_VERSION, layout })) !== null;

export const panesDecl = declare({
  name: 'panes',
  scope: 'local',
  storage: 'tab', // a second window has its own layout
  fields: {
    // Whatever storage gave back becomes a valid layout. What is saved leaves out the panes that cannot exist after a
    // reload (an incognito chat, the blank chat never committed: core/panel-store.js serializeLayout owns the rule).
    layout: field(EMPTY, (l) => (valid(l) ? l : EMPTY), { save: (l, s) => { const text = serializeLayout(l, { transientId: s.transient }); return text ? JSON.parse(text).layout : EMPTY; } }),
    transient: scratch()
  },
  legacy: [{ key: LAYOUT_KEY, read: (raw) => { const layout = parseLayout(raw); return layout && { layout }; } }],
  actions: {
    'pane.activate': on('layout', (l, { id }) => activate(l, id)),
    'pane.openFor': on('layout', (l, { id, split, viewportPx }) => openFor(l, id, { split, viewportPx })),
    'pane.openBeside': on('layout', (l, { id }) => openBeside(l, id)),
    'pane.focus': on('layout', (l, { index }) => focusPanel(l, index)),
    'pane.close': on('layout', (l, { index }) => closePanel(l, index)),
    'pane.duplicate': on('layout', (l, { index }) => duplicatePanel(l, index)),
    'pane.move': on('layout', (l, { index, delta }) => movePanel(l, index, delta)),
    'pane.toggle': on('layout', (l, { index }) => togglePanel(l, index)),
    'pane.resize': on('layout', (l, { index, delta }) => resize(l, index, delta)),
    'pane.drop': on('layout', (l, { ids }) => prune(l, (id) => !ids.includes(id))),
    'pane.reset': reset(),
    'transient.set': set('transient', 'id')
  }
});
