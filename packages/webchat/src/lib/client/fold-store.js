// Which blocks he left open, kept per chat.
//
// Folding a tool call, a thinking block, an agent card or a hook card used to be
// state that lived as long as the page did: the nav pill navigates, and a reload
// rebuilds the transcript from the store, so every fold he had set came back at
// its default and he had to open it all again.
//
// What is written here is identity only -- `kind:itemId` for the blocks he
// opened -- never a word of a message, and only under the chat he set it in, so
// two chats that happen to share an item id do not fold each other.
//
// The store is bounded on three sides: MAX_KEYS opened blocks per chat, MAX_CHATS
// chats (the least recently touched go first), and a quota refusal falls back to
// keeping this chat alone rather than losing the write.

const PREFIX = 'tophat-fold:';

/** Opened blocks remembered per chat. Beyond this the oldest entries are dropped. */
export const MAX_KEYS = 400;

/** Chats remembered at once, most recently touched first. */
export const MAX_CHATS = 24;

// An explicit null is a browser with no storage; leaving the argument out is the page's own.
function store(storage) {
  if (storage === null) return null;
  try { return storage ?? globalThis.localStorage ?? null; } catch { return null; }
}

/** The localStorage name a chat's folds live under. */
export function foldStorageKey(chatId) {
  return `${PREFIX}${chatId}`;
}

function names(box) {
  try {
    if (box && typeof box.key === 'function' && typeof box.length === 'number') {
      const out = [];
      for (let index = 0; index < box.length; index += 1) {
        const name = box.key(index);
        if (typeof name === 'string') out.push(name);
      }
      return out;
    }
    return Object.keys(box || {});
  } catch { return []; }
}

// Anything that is not the shape written here is treated as absent: a half-written
// or hand-edited entry must not decide what he sees.
function record(box, name) {
  let raw;
  try { raw = box.getItem(name); } catch { return null; }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.keys)) return null;
  return {
    keys: parsed.keys.filter((key) => typeof key === 'string' && key).slice(-MAX_KEYS),
    at: Number.isFinite(parsed.at) ? parsed.at : 0
  };
}

/** Every chat with folds kept, newest touch first. */
export function foldChats(storage) {
  const box = store(storage);
  if (!box) return [];
  const found = [];
  for (const name of names(box)) {
    if (!name.startsWith(PREFIX)) continue;
    const entry = record(box, name);
    if (!entry) continue;
    found.push({ chatId: name.slice(PREFIX.length), at: entry.at, count: entry.keys.length });
  }
  return found.sort((a, b) => b.at - a.at);
}

function evict(box, limit, keep) {
  const dropped = [];
  for (const { chatId } of foldChats(box).slice(limit)) {
    const name = foldStorageKey(chatId);
    if (name === keep) continue;
    try { box.removeItem(name); dropped.push(chatId); } catch { /* raced */ }
  }
  return dropped;
}

/** The keys of the blocks he had open in this chat. Nothing stored is an empty list,
 * which is today's default: closed. */
export function readFolds(chatId, storage) {
  const box = store(storage);
  if (!box || !chatId) return [];
  return record(box, foldStorageKey(chatId))?.keys ?? [];
}

/** Keep this chat's open blocks. An empty list removes the entry rather than
 * leaving "[]" behind for every chat he ever folded in. */
export function writeFolds(chatId, keys, storage, now = Date.now()) {
  const box = store(storage);
  if (!box || !chatId) return false;
  const name = foldStorageKey(chatId);
  const kept = [...new Set((keys || []).filter((key) => typeof key === 'string' && key))].slice(-MAX_KEYS);
  if (!kept.length) {
    try { box.removeItem(name); return true; } catch { return false; }
  }
  const body = JSON.stringify({ at: Number.isFinite(now) ? now : 0, keys: kept });
  try {
    box.setItem(name, body);
  } catch {
    // A full store is not worth a lost fold: give up the other chats' folds first.
    evict(box, 0, name);
    try { box.setItem(name, body); } catch { return false; }
  }
  evict(box, MAX_CHATS, name);
  return true;
}

/** Drop the folds of chats that are gone. An empty list of live chats is no
 * knowledge rather than an empty world, so it removes nothing. Returns the ids dropped. */
export function pruneFolds(liveChatIds, storage) {
  const box = store(storage);
  if (!box) return [];
  const live = new Set([...(liveChatIds || [])].filter(Boolean).map(String));
  if (!live.size) return [];
  const dropped = [];
  for (const name of names(box)) {
    if (!name.startsWith(PREFIX)) continue;
    const chatId = name.slice(PREFIX.length);
    if (live.has(chatId)) continue;
    try { box.removeItem(name); dropped.push(chatId); } catch { /* raced */ }
  }
  return dropped;
}
