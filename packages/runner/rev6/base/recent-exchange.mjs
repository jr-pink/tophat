// Who has exchanged a message with the owner lately: one definition for the search linker (rev6/pull/link.mjs, ladder tier 2:
// "people who messaged you in the last 14 days") and the same-name settle pass (rev6/push/ambiguity.mjs, recent signal).
// Pure reads of raw_data through the indexes raw_author (source, author) and raw_thread (source, account, thread, occurred_at).
export const RECENT_DAYS = 14;
export const MSG_SOURCES = String(process.env.TOPHAT_MESSAGING_SOURCES || 'imessage-history,beeper').split(',').map((s) => s.trim()).filter(Boolean);

/** The newest message to or from one of `idents` ({source, native, key}; Contacts cards excluded) between `since` and `until`:
 *  `{at, via, handle}` or null. `get(sql, ...args)` returns the first row of a query (or undefined/null).
 *  `oneToOne` keeps only direct texts: an iMessage thread keyed by the handle, a Beeper room of two; no mail, no group chat. */
export function lastExchange(get, idents, since, until, { oneToOne = false } = {}) {
  let best = null;
  for (const r of idents) {
    if (r.source === 'contacts') continue;
    const native = String(r.native || ''), key = String(r.key || '');
    const forms = new Set([native]);
    if (key.startsWith('phone:')) { const d = key.slice(6); forms.add(`+1${d}`); forms.add(`+${d}`); }
    if (key.startsWith('email:')) forms.add(key.slice(6));
    for (const f of forms) {
      if (!f) continue;
      for (const src of oneToOne ? ['beeper'] : MSG_SOURCES) {
        const a = get(`SELECT MAX(occurred_at) t FROM raw_data WHERE source=? AND author=? AND occurred_at>=? AND occurred_at<=?${oneToOne ? ' AND json_array_length(participants)<=2' : ''}`, src, f, since, until)?.t;
        if (a && (!best || a > best.at)) best = { at: a, via: src, handle: f };
      }
      const t = get("SELECT MAX(occurred_at) t FROM raw_data WHERE source='imessage-history' AND account='' AND thread=? AND occurred_at>=? AND occurred_at<=?", `imessage:${f}`, since, until)?.t;
      if (t && (!best || t > best.at)) best = { at: t, via: 'imessage-history', handle: f };
    }
  }
  return best;
}
