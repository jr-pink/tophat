// Chat transcripts into the intake's derive. The runner ingests every turn of a chat into the replica as `webchat` records
// (runner/rev6/pull/pushq.mjs) without a pusher id, and the push plane derives only the rows its own pusher id marks
// (`locator.pusher`), so no transcript was ever derived. Before each derive the intake claims the pending transcript rows of chats
// that may enter this instance's shared memory: it marks them with its pusher id, as one logged store action.
//
// Scope gate. With scopes on (config file `scopes.enabled`), a chat's transcript is claimed only when the chat is unscoped or `legacy`,
// is in the instance's own write scope, or is in a registry group open to everyone (`everyone: true`). A personal scope, a
// member-limited group, an unknown scope and a chat the webchat store does not know stay unclaimed: they are never derived into the
// instance's group. The rule is one function, shared with the runner (runner/rev6/pull/chat-scope.mjs): the runner no longer writes
// the rows of a chat outside this gate at all; this claim still covers rows an earlier runner wrote. With scopes off every chat is claimed.
/** null when the chat's transcript may be claimed, else the reason. `scopeVerdict` is the runner's chatScopeVerdict (rev6/pull/chat-scope.mjs, the rule the
 *  runner itself applies before it writes a chat's rows); `env` is the instance env (TOPHAT_CONFIG, WEBCHAT_DB, TOPHAT_SCOPE). */
export function chatScopeRefusal(sessionId, env, scopeVerdict) {
  return scopeVerdict([sessionId], env)?.why ?? null;
}

/** Mark the pending, unmarked transcript rows of allowed chats with `pusher`. Returns { claimed, held: [{ thread, why }] }. */
export function claimTranscripts(store, { pusher, env, scopeVerdict, limit = 2000 }) {
  const s = store.store;
  const rows = s.all("SELECT id, thread FROM raw_data WHERE source='webchat' AND processed_batch IS NULL AND json_extract(locator,'$.pusher') IS NULL LIMIT ?", [limit]);
  if (!rows.length) return { claimed: 0, held: [] };
  const verdict = new Map(), held = [];
  for (const r of rows) if (!verdict.has(r.thread)) { const why = chatScopeRefusal(r.thread, env, scopeVerdict); verdict.set(r.thread, why); if (why) held.push({ thread: r.thread, why }); }
  const ids = rows.filter((r) => !verdict.get(r.thread)).map((r) => r.id);
  if (ids.length) s.tx(() => { for (const id of ids) s.run("UPDATE raw_data SET locator=json_set(locator,'$.pusher',?) WHERE id=?", [pusher, id]); });
  return { claimed: ids.length, held };
}
