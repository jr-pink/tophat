// First-run onboarding as ONE self-contained declaration on the docstore-ui-kit core. and then prompt to send another
// message for instant followup, previous toolcall runs in background. and then cmd enter to create new chat, cmd shift
// enter to create a new chat in split, cmd e to archive.
//
// So this store touches no other declaration. It holds (1) progress: which step he is on, which are done, whether he
// dismissed the tour, the chats he has messaged and created, the auto chat the inbox tooltip points at; and (2) the
// absolute position of the tip on screen (`tip`: x, y, side, arrow offset), computed here by a pure function from the
// anchor's measured rectangle, so the tip renders from state and never from ad-hoc DOM reads. The rest of the app
// reaches it only through thin hooks that dispatch the idempotent actions below (client/onboarding.js).
//
// Every action is absolute or guarded by the current step, so a repeat (a double dispatch, a redelivered entry) is a
// no-op: `message.sent` carries n, the ordinal of the message in its chat, and `chat.created` / `chat.archived` name a
// chat id. scope 'local': per browser, hydrated before the first render, offline first (localStorage, no server).
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { field, bool, list, flags, scratch } from '../../../../runner/tools/quicklook-kit/lib/schema.js';

/** The teaching order. `workspaces` waits until he has messaged WORKSPACE_AFTER different chats. */
export const STEPS = ['first', 'followup', 'newchat', 'split', 'archive', 'workspaces'];
export const WORKSPACE_AFTER = 3;
const KEEP = 12; // ids remembered per list; the count that matters is tiny

const id = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
const stepName = (v) => (STEPS.includes(v) || v === 'done' ? v : 'first');
const ids = list(id);

/** Where each tip points and on which side. `anchor` is an address (anchorSelector) not a selector, so state stays plain data. */
export const TIPS = {
  first: { anchor: 'composer', side: 'above', title: 'Send your first message', body: 'Type a message, then press Enter.' },
  followup: { anchor: 'composer', side: 'above', title: 'Send another one now', body: 'Follow-ups go out instantly, no waiting for a reply. Anything still running keeps going in the background.' },
  newchat: { anchor: 'composer', side: 'above', title: 'Start a new chat', body: 'Press {mod}+Enter with the composer empty. Your other chats keep working.' },
  split: { anchor: 'composer', side: 'above', title: 'New chat in a split', body: 'Press {mod}+Shift+Enter to open a new chat beside this one.' },
  archive: { anchor: 'composer', side: 'above', title: 'Archive when done', body: 'Press {mod}+E to archive the open chat. It leaves the list; {mod}+Z brings it back.' },
  workspaces: { anchor: 'new-workspace', side: 'right', title: 'Workspaces', body: 'Chats on different topics can live in workspaces (folders). New chats are routed into the right workspace automatically. Make the first with this button.' },
  auto: { anchor: 'chat', side: 'right', title: 'This chat came from an external event', body: 'It opened by itself. If nothing needs doing it archives itself; if it needs something from you it stays. Complete the task and archive it when you want. This list is your universal inbox.' }
};

/** The tip's text for this platform: {mod} is Cmd on a Mac, Ctrl elsewhere. */
export const tipText = (key, apple) => {
  const t = TIPS[key];
  if (!t) return null;
  const sub = (s) => s.replaceAll('{mod}', apple ? 'Cmd' : 'Ctrl');
  return { title: sub(t.title), body: sub(t.body) };
};

/** An anchor address -> the CSS selector that finds its element. `chat:<id>` is that chat's sidebar row. */
export function anchorSelector(address) {
  const a = String(address ?? '');
  if (a === 'composer') return '[data-testid="pane"][data-focused="true"] .composer, .composer';
  if (a === 'new-workspace') return '[data-testid="new-workspace"]';
  if (a.startsWith('chat:')) return `[data-testid="chat-row"][data-chat="${a.slice(5).replace(/["\\]/g, '\\$&')}"]`;
  return null;
}

/** The tip on screen now, or null: { key, anchor, side }. Auto-chat first (rarer, and it is about the user's inbox). */
export function activeTip(s) {
  if (!s.seeded || s.skipped) return null;
  if (s.autoChat && !s.done.auto) return { key: 'auto', anchor: `chat:${s.autoChat}`, side: TIPS.auto.side };
  if (s.step === 'done') return null;
  if (s.step === 'workspaces' && s.chats.length < WORKSPACE_AFTER) return null;
  const t = TIPS[s.step];
  return { key: s.step, anchor: t.anchor, side: t.side };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The absolute position of a tip box of `size` beside `rect` (the anchor's viewport rectangle) in a `view`. Pure.
 * `side` is where the tip sits relative to the anchor; it flips once if it would leave the screen, and an anchor
 * with no rectangle (hidden sidebar on a phone) puts it top right. `ax`/`ay` is the arrow's offset along the edge
 * that faces the anchor. Never returns a position outside the view.
 */
export function placeTip({ rect, side = 'above', size, view, gap = 12, margin = 8 }) {
  const w = Math.min(size.w, view.w - margin * 2), h = Math.min(size.h, view.h - margin * 2);
  if (!rect) return { x: Math.round(Math.max(margin, view.w - w - margin * 2)), y: margin * 2, side: 'free', ax: 0, ay: 0 };
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const fits = {
    above: rect.top - gap - h >= margin,
    below: rect.top + rect.height + gap + h <= view.h - margin,
    right: rect.left + rect.width + gap + w <= view.w - margin,
    left: rect.left - gap - w >= margin
  };
  const order = { above: ['above', 'below'], below: ['below', 'above'], right: ['right', 'left', 'below', 'above'], left: ['left', 'right', 'below', 'above'] }[side] ?? ['above'];
  const use = order.find((o) => fits[o]) ?? order[0];
  let x, y;
  if (use === 'above' || use === 'below') {
    x = clamp(cx - w / 2, margin, view.w - w - margin);
    y = use === 'above' ? rect.top - gap - h : rect.top + rect.height + gap;
  } else {
    y = clamp(cy - h / 2, margin, view.h - h - margin);
    x = use === 'right' ? rect.left + rect.width + gap : rect.left - gap - w;
  }
  x = clamp(x, margin, Math.max(margin, view.w - w - margin));
  y = clamp(y, margin, Math.max(margin, view.h - h - margin));
  return { x: Math.round(x), y: Math.round(y), side: use, ax: Math.round(clamp(cx - x, 14, w - 14)), ay: Math.round(clamp(cy - y, 14, h - 14)) };
}

/** Finish `from`: mark it done and move to the next step (or 'done'). A no-op unless he is on `from`. */
function advance(s, from) {
  if (s.step !== from) return s;
  const next = STEPS.slice(STEPS.indexOf(from) + 1).find((k) => !s.done[k]) ?? 'done'; // a step he already did is skipped
  return { ...s, step: next, done: { ...s.done, [from]: true } };
}

const remember = (list, v) => (list.includes(v) ? list : [...list, v].slice(-KEEP));

// A payload that is not an object (a hand-built or corrupt entry) reads as an empty one: every action is total.
const total = (actions) => Object.fromEntries(Object.entries(actions).map(([k, f]) => [k, (s, p) => f(s, p && typeof p === 'object' ? p : {})]));

export const onboardingDecl = declare({
  name: 'onboarding',
  scope: 'local',
  fields: {
    // Whether the existing-account check ran. Until then no tip shows (an old account never flashes step 1).
    seeded: bool(),
    step: field('first', stepName),
    skipped: bool(),
    done: flags(),
    chats: ids,      // chats he has sent a message in (different chats stand for different topics)
    archived: ids,   // chats he put away
    created: ids,    // chats he made with a new-chat action
    firstChat: field(null, id),
    firstN: field(0, (v) => (Number.isInteger(v) && v > 0 ? v : 0)), // the ordinal of that first message in its chat
    autoChat: field(null, id),
    // The tip's absolute position, from the anchor's measured rectangle. Screen-dependent, so never saved.
    tip: scratch()
  },
  actions: total({
    // An account that already has chats is not new: the five teaching steps are done. The auto-chat tooltip still shows once.
    seed: (s, { chats } = {}) => {
      if (s.seeded) return s;
      const old = Number(chats) > 0 && s.step === 'first' && !s.chats.length;
      return old ? { ...s, seeded: true, step: 'done', done: Object.fromEntries(STEPS.map((k) => [k, true])) } : { ...s, seeded: true };
    },
    'message.sent': (s, { chat, n } = {}) => {
      const c = id(chat);
      if (!c || !Number.isInteger(n) || n < 1 || s.skipped) return s;
      const chats = remember(s.chats, c);
      let next = chats === s.chats ? s : { ...s, chats };
      if (next.step === 'first') return { ...next, step: 'followup', firstChat: c, firstN: n, done: { ...next.done, first: true } };
      if (next.step === 'followup' && (c !== next.firstChat || n > next.firstN)) return advance(next, 'followup');
      return next;
    },
    'chat.created': (s, { chat, split } = {}) => {
      const c = id(chat);
      if (!c || s.skipped) return s;
      // Keyed by the chat id: the same chat reported again (a redelivery) is not a second chat made.
      if (s.created.includes(c)) return s;
      const next = { ...s, created: remember(s.created, c) };
      if (next.step === 'newchat') return advance(next, 'newchat');
      if (next.step === 'split' && split === true) return advance(next, 'split');
      return next;
    },
    'chat.archived': (s, { chat } = {}) => {
      const c = id(chat);
      if (!c || s.skipped) return s;
      const archived = remember(s.archived, c);
      let next = archived === s.archived ? s : { ...s, archived };
      if (c === next.autoChat) next = { ...next, autoChat: null, done: { ...next.done, auto: true } };
      return advance(next, 'archive');
    },
    // He made a workspace (or already uses them): the workspaces tip has done its job.
    'workspace.made': (s) => advance(s.done.workspaces ? s : { ...s, done: { ...s.done, workspaces: true } }, 'workspaces'),
    // The first automated chat he can see: the inbox tooltip points at it until he acknowledges it, archives it or skips.
    'auto.seen': (s, { chat } = {}) => {
      const c = id(chat);
      return !c || s.skipped || s.done.auto || s.autoChat ? s : { ...s, autoChat: c };
    },
    'auto.ack': (s) => (s.autoChat || !s.done.auto ? { ...s, autoChat: null, done: { ...s.done, auto: true } } : s),
    // "Skip" on one tip: moves past it. A no-op when that is not the step he is on.
    'tip.skip': (s, { step } = {}) => advance(s, step),
    // "Skip tour": no tip shows again, the auto-chat one included.
    'tour.skip': (s) => (s.skipped ? s : { ...s, skipped: true, autoChat: null }),
    // Replay from the top. Seeded stays true so the account check does not run again.
    replay: (s) => {
      const top = { ...onboardingDecl.initial, seeded: true };
      return JSON.stringify({ ...top, tip: s.tip }) === JSON.stringify(s) ? s : top;
    },
    // The anchor's measured rectangle and the tip's size, in; the tip's absolute position, out.
    'tip.place': (s, { key, anchor, side, rect, size, view } = {}) => {
      const num = (o, ks) => o && ks.every((k) => Number.isFinite(o[k]));
      if (!key || !num(size, ['w', 'h']) || !num(view, ['w', 'h'])) return s;
      const pos = placeTip({ rect: num(rect, ['left', 'top', 'width', 'height']) ? rect : null, side, size, view });
      const tip = { key, anchor: String(anchor ?? ''), ...pos };
      return JSON.stringify(tip) === JSON.stringify(s.tip) ? s : { ...s, tip };
    }
  })
});

export const normalize = onboardingDecl.normalize;
