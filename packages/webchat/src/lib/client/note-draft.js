// A note being typed is the user's work from the first keystroke, so it lives in storage, not only
// in a component that a tap, a keyboard dismissal or a reload can take away. One draft per
// document and section: he types in one place at a time, and a stale draft is worse than none.

const KEY = 'reader:note-draft';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // a week; older than that he has moved on

const store = () => {
  try { return globalThis.localStorage || null; } catch { return null; }
};

const slot = (docId, sectionIdx) => `${KEY}:${docId || 'page'}:${sectionIdx ?? 0}`;

/** Keep what he has typed, with everything needed to put the box back where the words are. */
export function saveDraft({ docId, sectionIdx = 0, text, sel = null, existingId = null, x = 0, y = 0, below = false, now = Date.now() }) {
  const ls = store();
  if (!ls) return null;
  const draft = { docId: docId || null, sectionIdx: sectionIdx ?? 0, text, sel, existingId, x, y, below, at: now };
  if (!text || !text.trim()) { clearDraft({ docId, sectionIdx }); return null; }
  try { ls.setItem(slot(docId, sectionIdx), JSON.stringify(draft)); } catch { return null; }
  return draft;
}

/** What he was typing here, if it is recent enough to still be his intent. */
export function loadDraft({ docId, sectionIdx = 0, now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const ls = store();
  if (!ls) return null;
  let raw = null;
  try { raw = ls.getItem(slot(docId, sectionIdx)); } catch { return null; }
  if (!raw) return null;
  let draft = null;
  try { draft = JSON.parse(raw); } catch { clearDraft({ docId, sectionIdx }); return null; }
  if (!draft || typeof draft.text !== 'string' || !draft.text.trim()) { clearDraft({ docId, sectionIdx }); return null; }
  if (typeof draft.at === 'number' && now - draft.at > maxAgeMs) { clearDraft({ docId, sectionIdx }); return null; }
  return draft;
}

export function clearDraft({ docId, sectionIdx = 0 } = {}) {
  const ls = store();
  if (!ls) return;
  try { ls.removeItem(slot(docId, sectionIdx)); } catch { /* a full or blocked store; nothing to undo */ }
}

/** Every draft still held, newest first: what a reader would have to be shown to lose nothing. */
export function allDrafts({ now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const ls = store();
  if (!ls) return [];
  const out = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key || !key.startsWith(`${KEY}:`)) continue;
    try {
      const draft = JSON.parse(ls.getItem(key));
      if (!draft?.text?.trim()) continue;
      if (typeof draft.at === 'number' && now - draft.at > maxAgeMs) continue;
      out.push(draft);
    } catch { /* unreadable slot; leave it for clearDraft */ }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
