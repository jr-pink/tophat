// Find My for a resolved person. The "Resolved:" line of the search context now says so, with the last fix, where, and the
// distance from the owner, and names the command that reads the rest.
//
// The link is explicit when it can be: an `identities` row (source 'findmy', native = the Find My display name) bound to the
// person entity by rev6/push/identity-findmy.mjs. Without one, the person's own full name (two words or more) is matched to a
// Find My display name ignoring emoji, case and punctuation. Coordinates are never copied: the position is read from the Find
// My log (tools/tophat-findmy/history.mjs, `where`) at question time, read-only. Silent when the log, the table or the match
// is missing.
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The Find My tool is edited by other work; a broken import must not take the search tool down with it.
let H = null, normName = null, foldName = null;
try { H = await import('../../tools/tophat-findmy/history.mjs'); ({ normName, foldName } = await import('../../tools/tophat-findmy/parse.mjs')); } catch { H = null; }

export const FINDMY_DB = join(os.homedir(), '.local/state/tophat/findmy/findmy.sqlite');

/** Emoji, mojibake, punctuation, case and spacing folded away. */
export function fmNorm(s) {
  const base = normName ? normName(s) : String(s || '').toLowerCase();
  return base.replace(/\uFFFD/gu, '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}
const words = (s) => fmNorm(s).split(' ').filter(Boolean);

/** Find My display names that are this person: `names` are the person's names and aliases, only multi-word ones count; `bound`
 * are display names already bound to the entity, which match by folded equality.
 */
export function matchFindMyNames(fmNames, names = [], bound = []) {
  const want = new Set([...bound.map(fmNorm), ...names.filter((n) => words(n).length >= 2).map(fmNorm)].filter(Boolean));
  return fmNames.filter((n) => want.has(fmNorm(n)));
}

const age = (min) => (min < 90 ? `${Math.max(0, min)} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`);

// (distinct name rides the obs_name_ts index, ~10 ms; adding a kind filter forces a scan of the whole log, ~600 ms)
/** The "Find My: ..." clause for one person, or null. `fm` is an open read-only handle. Pure over the log. */
export function findMyClause(fm, { names = [], bound = [] } = {}, now = Date.now() / 1000) {
  if (!H) return null;
  const all = fm.prepare("select distinct name from obs").all().map((r) => r.name);
  const hits = matchFindMyNames(all, names, bound);
  if (!hits.length) return null;
  // one row per person: where() folds emoji and garbled-emoji spellings of a display name together
  const byKey = new Map(hits.map((n) => [fmNorm(n), n]));
  const rows = [...byKey].flatMap(([k, n]) => H.where(fm, foldName(n), now).filter((r) => fmNorm(r.name) === k));
  const best = rows.filter((r) => r.fix_age_min != null).sort((a, b) => a.fix_age_min - b.fix_age_min)[0];
  const name = (best ?? rows[0] ?? { name: hits[0] }).name;
  const cmd = `run tophat-findmy where "${name}"`;
  if (!best) return `Find My: shares location, no map fix yet, ${cmd}`;
  const me = H.where(fm, 'me', now)[0];
  const mi = me && best.lat != null ? H.haversine(me, best) / 1609.344 : null;
  return `Find My: shares location, last fix ${age(best.fix_age_min)} ago${best.address ? ` near ${best.address}` : ''}${mi != null ? `, ${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi from the owner` : ''}, ${cmd}`;
}

/** Entry for link.mjs: opens the log read-only, never throws. `link` is a resolved link ({display, aliases}); `bound` its bound names. */
export function findMyFor(link, bound = [], { findmyDb = process.env.FINDMY_DB || FINDMY_DB, now } = {}) {
  let fm = null;
  try {
    if (!H || !existsSync(findmyDb)) return null;
    fm = new DatabaseSync(findmyDb, { readOnly: true });
    fm.exec('PRAGMA busy_timeout=50');
    return findMyClause(fm, { names: [link.display, ...(link.aliases || [])], bound }, now);
  } catch { return null; } finally { try { fm?.close(); } catch { /* none */ } }
}
