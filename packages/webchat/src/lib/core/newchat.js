

export function reusableBlankChat({
  lastCreatedId = null,
  focusedId = null,
  conversation = null,
  turns = [],
  draft = '',
  uploads = []
} = {}) {
  if (!lastCreatedId) return null;
  
  
  
  if (lastCreatedId !== focusedId) return null;
  if (!conversation) return null;
  if (conversation.archived) return null;
  
  
  
  
  
  
  
  
  
  
  
  if (conversation.awaitingFirstToken) return null;
  
  
  
  if (String(draft ?? '').trim()) return null;
  if (uploads.length) return null;
  
  
  
  
  if (turns.length) return null;
  return lastCreatedId;
}

// Opening a chat in place ends the blank transient chat in another pane (it is dropped); an explicit split (split === true:
// cmd-shift-enter, open-in-split) adds a pane and must not drop one, or the new pane looks like a replacement.
export const releasesTransient = (split) => split !== true;
