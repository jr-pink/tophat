// The chat page's panes as ONE declaration on the docstore-ui-kit core: which chats are open, their widths, which is focused, and the
// uncommitted blank chat. Pure absolute-state actions over core/panels.js; hydrate, coalesced save and the one-time import of the old
// `tophat.panes` key are the kit's. Hydrated at `uiApp().use(...)`, so the first render already has his panes.
//
// Every logged action is absolute and names a panel by its id (layout.keys), so a repeat (a double click, a redelivered
// entry) is a no-op and the kit's validate() idempotence law holds (src/lib/declarations.test.js). His relative intents
// (duplicate this pane, move it one left, drag the divider by this frame's delta, close it) are gestures: `paneGesture` (`panesComp.gestures`)
// resolves each against the layout as it is at dispatch, through the kit's resolve/gesture (lib/components.js), into
// pane.add {id: a minted ULID, chat, after}, pane.move {id, to}, pane.set {id, size}, pane.remove {id}. The divider
// keeps the old per-frame clamp and collapse feel (divider-drag.test.js): each frame's size is the current width plus
// that frame's pointer delta.
//
// scope 'local' on the TAB's storage (`storage: 'tab'`): a second window has its own layout and a window opened fresh still lands in the new
// blank chat.
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { gesture } from '../../../../runner/tools/quicklook-kit/lib/components.js';
import { ulid } from '../../../../runner/tools/quicklook-kit/lib/engine/ulid.js';
import { field, scratch, set, on, reset } from '../../../../runner/tools/quicklook-kit/lib/schema.js';
import { initial, activate, openBeside, openFor, focusPanel, closePanel, addPanel, movePanel, togglePanel, resizeTo, prune } from './panels.js';
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
    'pane.remove': on('layout', (l, { id }) => closePanel(l, l.keys.indexOf(id))),
    'pane.add': on('layout', (l, p) => addPanel(l, p)),
    'pane.move': on('layout', (l, { id, to }) => { const at = l.keys.indexOf(id); return at < 0 || !Number.isInteger(to) ? l : movePanel(l, at, to - at); }),
    'pane.toggle': on('layout', (l, { index }) => togglePanel(l, index)),
    'pane.set': on('layout', (l, { id, size }) => resizeTo(l, l.keys.indexOf(id), size)),
    'pane.drop': on('layout', (l, { ids }) => (Array.isArray(ids) ? prune(l, (id) => !ids.includes(id)) : l)),
    'pane.reset': reset(),
    'transient.set': set('transient', 'id')
  }
});

// The relative intents, resolved at dispatch against the current layout (never logged). An index that names no panel
// resolves to nothing.
const at = (s, index) => (Number.isInteger(index) && index >= 0 && index < s.layout.panels.length ? s.layout.keys[index] : null);
export const panesComp = {
  kind: 'panes',
  actions: panesDecl.actions,
  gestures: {
    duplicate: (s, { index } = {}) => (at(s, index) ? ['pane.add', { id: ulid(), chat: s.layout.panels[index], after: at(s, index) }] : null),
    // An explicit split: always a new pane after the focused one, even for a chat already open in another pane.
    split: (s, { chat } = {}) => (typeof chat === 'string' && chat && s.layout.panels.length ? ['pane.add', { id: ulid(), chat, after: s.layout.keys[s.layout.focused] }] : null),
    move: (s, { index, delta } = {}) => (at(s, index) && Number.isInteger(delta) ? ['pane.move', { id: at(s, index), to: index + delta }] : null),
    resizeBy: (s, { index, delta } = {}) => (at(s, index) && Number.isFinite(delta) ? ['pane.set', { id: at(s, index), size: s.layout.widths[index] + delta }] : null),
    close: (s, { index } = {}) => (at(s, index) ? ['pane.remove', { id: at(s, index) }] : null)
  }
};
/** Dispatch a relative pane intent on a panes replica: the logged entry, or null when it resolved to nothing or changed nothing. */
export const paneGesture = (replica, name, payload) => gesture(replica, panesComp, name, payload);
