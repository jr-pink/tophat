
// The chat the app opens into.
//
// Transient means not created anywhere yet: session.createProvisional puts the conversation in
// this tab's state only, so nothing is posted, nothing is written to the replica headers, and
// the sidebar row it shows is this tab's alone. The first thing that commits it (a send, a
// rename, a settings change) dispatches the real conversation.create behind it; leaving it
// untouched drops it with forgetConversation and no server ever heard of it.

// one he only looked at is dropped.
export function transientFate({
  turns = [],
  draft = '',
  uploads = [],
  awaitingFirstToken = false
} = {}) {
  if (turns.length) return 'keep';
  if (awaitingFirstToken) return 'keep';
  if (uploads.length) return 'keep';
  if (String(draft ?? '').trim()) return 'keep';
  return 'drop';
}

export function shouldDropTransient(input) {
  return transientFate(input) === 'drop';
}

// The sidebar does not show the chat the app opened into until something commits it. Hidden is
// only about the row: the pane is live, the composer is focused, and the draft is his the
// moment he types, which is also the moment Composer commits the chat and this row appears with
// the same id.
export function hiddenTransientRow(conversation, { provisional = false } = {}) {
  if (!provisional) return false;
  if (!conversation) return true;
  // Belt and braces: anything with content behind it is a real chat on screen even if the
  // create action has not been dispatched yet, so it keeps its row.
  if (conversation.awaitingFirstToken) return false;
  if (Number(conversation.turns ?? 0) > 0) return false;
  return true;
}

// The conversations the sidebar lists, which is every chat except an untouched transient one.
// Returns the same object when nothing is hidden, so the common case costs no re-render.
export function listedConversations(conversations = {}, isProvisional = null) {
  if (typeof isProvisional !== 'function') return conversations;
  const kept = {};
  let hid = false;
  for (const [id, conversation] of Object.entries(conversations ?? {})) {
    if (hiddenTransientRow(conversation, { provisional: Boolean(isProvisional(id)) })) { hid = true; continue; }
    kept[id] = conversation;
  }
  return hid ? kept : conversations;
}

// The previous listing when the new one holds exactly the same chats (same ids, same objects), so a
// derived that recomputes on every chatState.rev (every keystroke in a new chat, every streamed
// event) hands its readers the same object and nothing downstream re-ranks. Cheap: one pass of
// identity checks.
export function stableListing(previous, next) {
  if (!previous || previous === next) return next;
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return next;
  for (const key of keys) if (previous[key] !== next[key]) return next;
  return previous;
}
