// Small helpers the scope routes share.

/** Ids of chats the caller may see, out of a list of conversation ids (the live and busy lists). */
export function liveFor(ctx, ids) {
  if (!ctx.enabled) return ids;
  return ids.filter((id) => ctx.service.canSee(ctx.identity, ctx.store?.conversation?.(id)));
}
