

export const MAX_SEGMENTS = 4;
export const NEW_CHAT = 'New chat';

const STOP = new Set(['the', 'a', 'an', 'and', 'for', 'of', 'to', 'in', 'on', 'with', 'my', 'its']);

export function splitTitle(title) {
  if (!title || title === NEW_CHAT) return [];
  return title.split(',').map((s) => s.trim()).filter(Boolean);
}

function stem(word) {
  return word.replace(/(ing|ers|er|ed|es|s)$/, '').replace(/e$/, '');
}

function words(text) {
  return new Set(
    String(text).toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem)
      .filter((w) => w.length > 2)
  );
}

export function coversSameSubject(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.6;
}

export const MAX_WORDS = 5;

function clampWords(segment) {
  const words = String(segment).replace(/[.,;]+$/, '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_WORDS).join(' ');
}

export function reflowTitle(existing, proposed, { max = MAX_SEGMENTS } = {}) {
  const kept = splitTitle(existing);
  const incoming = splitTitle(proposed).map(clampWords).filter(Boolean);
  if (!incoming.length) return null;

  const merged = [...kept];
  for (const segment of incoming) {
    if (merged.some((have) => coversSameSubject(have, segment))) continue;
    merged.push(segment);
  }
  const trimmed = merged.length <= max ? merged : [merged[0], ...merged.slice(-(max - 1))];
  const title = trimmed.join(', ');
  return title === existing ? null : title;
}

// What the titler names chats by: 'subjects', what each chat is about, for searching the sidebar later, or 'actions',
// what each chat is doing now, refreshed while it works (server/autotitle.js). Set from the menu (core/title-style.js).
export const TITLE_STYLES = Object.freeze(['subjects', 'actions']);
export const DEFAULT_TITLE_STYLE = 'subjects';

export const RETITLE_INTERVAL_MS = 60 * 60 * 1000;

export function shouldTitle({ turns, titledAtTurn = 0, titledAt = 0, now = Date.now(), interval = RETITLE_INTERVAL_MS }) {
  if (turns < 1 || turns <= titledAtTurn) return false;
  if (!titledAt) return true;
  return now - titledAt >= interval;
}

export const APP_NAME = 'tophat';

export function documentTitle(title) {
  
  
  const name = String(title ?? '').replace(/\s+/g, ' ').trim();
  return name ? `${name} · ${APP_NAME}` : APP_NAME;
}

// It is not the title: he cannot read a sidebar where every such row starts the same way. The
// label comes off the title; the row carries an `automated` flag the sidebar shows as a tag
// instead.
const AUTOMATED_LABEL = /^\s*\[\s*automated event\b[^\]]*\]\s*[,.;:-]?\s*/iu;

export function automatedTitle(text) {
  const raw = String(text || '');
  const automated = AUTOMATED_LABEL.test(raw);
  return { automated, text: automated ? raw.replace(AUTOMATED_LABEL, '') : raw };
}
