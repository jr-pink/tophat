

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
