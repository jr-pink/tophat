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
// Editor groups and tabs: each pane is a group holding an ordered tab strip (`layout.tabs`), `layout.panels[i]` being the active tab. Absolute
// actions name the group by its key and the tab by its chat id: tab.open, tab.activate, tab.close, tab.move (a reorder inside a group or a
// move to another, a source left empty closing), pane.add (a new group with one tab, after or before a group). His relative intents are
// gestures: nextTab / prevTab (the tab beside the active one), splitActive (Cmd-\), shiftTab (one place along the strip). A tab drag in
// progress is kit state too (`drag`, scratch: never saved): which tab, from which group, over which drop target, so the strips and the drop
// overlays are projections of it. Version 2 of the saved record; version 1 (one chat per pane) upgrades to groups with one tab each.
//
// Preview tabs: VS Code's italic tab, `layout.preview[i]` per group. A plain list click is pane.activate {id, preview: true}: it opens the
// chat as the focused group's preview tab, replacing the one there in place. tab.open {group, chat, preview: true} does the same for a named
// group. tab.keepPreview {group, chat} makes it a normal tab; a drag keeps it too. Version 3; older records upgrade with none.
//
// scope 'local' on the TAB's storage (`storage: 'tab'`): a second window has its own layout and a window opened fresh still lands in the new
// blank chat.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { gesture } from '../../../../runner/tools/docstore-kit/lib/components.js';
import { ulid } from '../../../../runner/tools/docstore-kit/lib/engine/ulid.js';
import { field, scratch, set, on, reset } from '../../../../runner/tools/docstore-kit/lib/schema.js';
import { MIN_WIDTH, initial, activate, openBeside, openFor, focusPanel, closePanel, addPanel, movePanel, togglePanel, resizeTo, prune, closeTab, activateTab, moveTab, openTab, keepTabs, keepPreview, zoomPanel } from './panels.js';
import { LAYOUT_KEY, LAYOUT_VERSION, parseLayout, serializeLayout, upgradeLayout } from './panel-store.js';

const EMPTY = initial(null);
const valid = (layout) => (Array.isArray(layout?.panels) && !layout.panels.length) || parseLayout(JSON.stringify({ v: LAYOUT_VERSION, layout })) !== null;

// A tab drag in flight, repaired to a known shape: {chat, from (a group key), over}, over null or a drop target
// {kind: 'strip', group, index} | {kind: 'edge', group, side: 'left'|'right'} | {kind: 'body', group}.
const text = (v) => typeof v === 'string' && v.length > 0;
const SIDES = ['left', 'right'];
function cleanOver(over) {
  if (!over || typeof over !== 'object' || !text(over.group)) return null;
  if (over.kind === 'strip') return Number.isInteger(over.index) && over.index >= 0 ? { kind: 'strip', group: over.group, index: over.index } : null;
  if (over.kind === 'edge') return SIDES.includes(over.side) ? { kind: 'edge', group: over.group, side: over.side } : null;
  return over.kind === 'body' ? { kind: 'body', group: over.group } : null;
}
const cleanDrag = (d) => (d && typeof d === 'object' && text(d.chat) && text(d.from) ? { chat: d.chat, from: d.from, over: cleanOver(d.over) } : null);

export const panesDecl = declare({
  name: 'panes',
  version: 3,
  migrations: { 2: (s) => ({ ...s, layout: upgradeLayout(s?.layout) }), 3: (s) => ({ ...s, layout: upgradeLayout(s?.layout) }) },
  scope: 'local',
  storage: 'tab', // a second window has its own layout
  fields: {
    // Whatever storage gave back becomes a valid layout. What is saved leaves out the panes that cannot exist after a
    // reload (an incognito chat, the blank chat never committed: core/panel-store.js serializeLayout owns the rule).
    layout: field(EMPTY, (l) => (valid(l) ? l : EMPTY), { save: (l, s) => { const text = serializeLayout(l, { transientId: s.transient }); return text ? JSON.parse(text).layout : EMPTY; } }),
    transient: scratch(),
    drag: field(null, cleanDrag, { ephemeral: true })
  },
  legacy: [{ key: LAYOUT_KEY, read: (raw) => { const layout = parseLayout(raw); return layout && { layout }; } }],
  actions: {
    'pane.activate': on('layout', (l, { id, preview }) => activate(l, id, { preview: preview === true })),
    'pane.openFor': on('layout', (l, { id, split, viewportPx }) => openFor(l, id, { split, viewportPx })),
    'pane.openBeside': on('layout', (l, { id }) => openBeside(l, id)),
    'pane.focus': on('layout', (l, { index }) => focusPanel(l, index)),
    'pane.remove': on('layout', (l, { id }) => closePanel(l, l.keys.indexOf(id))),
    'pane.add': on('layout', (l, p) => addPanel(l, p)),
    'pane.move': on('layout', (l, { id, to }) => { const at = l.keys.indexOf(id); return at < 0 || !Number.isInteger(to) ? l : movePanel(l, at, to - at); }),
    'pane.toggle': on('layout', (l, { index }) => togglePanel(l, index)),
    'pane.set': on('layout', (l, { id, size }) => resizeTo(l, l.keys.indexOf(id), size)),
    // Ctrl-Q z: the group alone open (on) or its neighbours unfolded again (off); core/panels.js zoomPanel.
    'pane.zoom': on('layout', (l, { id, on } = {}) => zoomPanel(l, l.keys.indexOf(id), on === true)),
    'pane.drop': on('layout', (l, { ids }) => (Array.isArray(ids) ? prune(l, (id) => !ids.includes(id)) : l)),
    'tab.open': on('layout', (l, p) => openTab(l, p?.group, p?.chat, p?.at, { preview: p?.preview === true })),
    'tab.keepPreview': on('layout', (l, p) => keepPreview(l, p?.group, p?.chat)),
    'tab.activate': on('layout', (l, p) => activateTab(l, p?.group, p?.chat)),
    'tab.close': on('layout', (l, p) => closeTab(l, p?.group, p?.chat)),
    'tab.keep': on('layout', (l, p) => keepTabs(l, p?.group, p?.keep)),
    'tab.move': on('layout', (l, p) => moveTab(l, p ?? undefined)),
    'drag.set': on('drag', (_, p) => cleanDrag(p?.drag)),
    'pane.reset': reset(),
    'transient.set': set('transient', 'id')
  }
});

// The relative intents, resolved at dispatch against the current layout (never logged). An index that names no panel
// resolves to nothing.
const at = (s, index) => (Number.isInteger(index) && index >= 0 && index < s.layout.panels.length ? s.layout.keys[index] : null);
const holds = (s, group, chat) => typeof chat === 'string' && (s.layout.tabs[s.layout.keys.indexOf(group)] ?? []).includes(chat);
const focusedGroup = (s) => (s.layout.panels.length ? s.layout.keys[s.layout.focused] : null);
function cycle(s, delta) {
  const g = focusedGroup(s);
  if (!g) return null;
  const tabs = s.layout.tabs[s.layout.focused];
  if (tabs.length < 2) return null;
  return ['tab.activate', { group: g, chat: tabs[(tabs.indexOf(s.layout.panels[s.layout.focused]) + delta + tabs.length) % tabs.length] }];
}
export const panesComp = {
  kind: 'panes',
  actions: panesDecl.actions,
  gestures: {
    duplicate: (s, { index } = {}) => (at(s, index) ? ['pane.add', { id: ulid(), chat: s.layout.panels[index], after: at(s, index) }] : null),
    // An explicit split: always a new pane after the focused one, even for a chat already open in another pane.
    split: (s, { chat } = {}) => (typeof chat === 'string' && chat && s.layout.panels.length ? ['pane.add', { id: ulid(), chat, after: s.layout.keys[s.layout.focused] }] : null),
    move: (s, { index, delta } = {}) => (at(s, index) && Number.isInteger(delta) ? ['pane.move', { id: at(s, index), to: index + delta }] : null),
    resizeBy: (s, { index, delta } = {}) => (at(s, index) && Number.isFinite(delta) ? ['pane.set', { id: at(s, index), size: s.layout.widths[index] + delta }] : null),
    // The keyboard's resize: resizeBy that stops at the narrowest width, where a drag folds the pane to a rail and the
    // keyboard focus would go with it.
    resizeStep: (s, { index, delta } = {}) => {
      if (!at(s, index) || !at(s, index + 1) || !Number.isFinite(delta)) return null;
      if (s.layout.collapsed[index] || s.layout.collapsed[index + 1]) return null;
      const pair = s.layout.widths[index] + s.layout.widths[index + 1];
      return ['pane.set', { id: at(s, index), size: Math.min(pair - MIN_WIDTH, Math.max(MIN_WIDTH, s.layout.widths[index] + delta)) }];
    },
    // Ctrl-Q z toggles: the focused group alone when another is open, else its rails unfolded. One group: nothing.
    zoom: (s) => {
      const f = s.layout.focused;
      if (!at(s, f)) return null;
      const othersOpen = s.layout.collapsed.some((shut, i) => i !== f && !shut);
      if (othersOpen) return ['pane.zoom', { id: at(s, f), on: true }];
      return s.layout.collapsed.some(Boolean) ? ['pane.zoom', { id: at(s, f), on: false }] : null;
    },
    close: (s, { index } = {}) => (at(s, index) ? ['pane.remove', { id: at(s, index) }] : null),
    // The tab beside the active one in the focused group, wrapping (Ctrl-Tab, Cmd-Option-Arrow). One tab: nothing to do.
    nextTab: (s) => cycle(s, 1),
    prevTab: (s) => cycle(s, -1),
    // The tab moved one place along its strip (clamped by the action); `chat` defaults to the focused group's active tab.
    shiftTab: (s, { chat, delta } = {}) => {
      const g = focusedGroup(s);
      const c = typeof chat === 'string' && chat ? chat : g && s.layout.panels[s.layout.focused];
      const i = g ? s.layout.tabs[s.layout.focused].indexOf(c) : -1;
      return i >= 0 && Number.isInteger(delta) ? ['tab.move', { chat: c, from: g, to: g, index: i + delta }] : null;
    },
    // Cmd-\: the active tab shown again in a new group to the right (VS Code's split editor).
    splitActive: (s) => {
      const g = focusedGroup(s);
      return g ? ['pane.add', { id: ulid(), chat: s.layout.panels[s.layout.focused], after: g }] : null;
    },
    // The tab menu's split: the tab shown again in a new group on its right (a copy).
    splitTab: (s, { group, chat } = {}) => (holds(s, group, chat) ? ['pane.add', { id: ulid(), chat, after: group }] : null),
    // A drop on a group's left or right edge: a new group beside it holding `chat`; `move` takes the tab out of where it was.
    // Returns the two absolute entries (add, then close) the page dispatches in order.
    dropEdge: (s, { chat, from, group, side } = {}) => {
      if (!chat || !s.layout.keys.includes(group) || !s.layout.keys.includes(from) || !SIDES.includes(side)) return null;
      return ['pane.add', { id: ulid(), chat, [side === 'left' ? 'before' : 'after']: group }];
    }
  }
};
/** Dispatch a relative pane intent on a panes replica: the logged entry, or null when it resolved to nothing or changed nothing. */
export const paneGesture = (replica, name, payload) => gesture(replica, panesComp, name, payload);
