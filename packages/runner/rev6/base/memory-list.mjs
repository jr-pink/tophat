// memory_list: the exhaustive read of the memory store, beside memory_search (a ranked top-k) and memory_read (one item). The command
// is rev6/push/cli.mjs `list`; the Python store has no such command, so a `list` goes to the Node CLI, read-only. Both runners'
// memoryCli (rev6/pull/tools.mjs, rev5/tools.mjs) route it through here.
import { join } from 'node:path';
import { ownerZone } from './clock.mjs';

/** Tool description, one copy for both runners (the spec itself is in rev6/pull/tools.json and rev5/tools.mjs, held equal by fuzz.test.mjs). */
export const LIST_DOC = 'List EVERY memory item that matches a filter, in time order, with no relevance cut. Use this, not memory_search, for any question that counts, totals, averages, takes the latest or the max, or asks "every time" or "how many": memory_search returns only the top few ranked hits, so a count or an average read off it is wrong. Give at least one of entity, term, source. Answer: total (per kind, over ALL matches), by_month (per local month and kind, over all matches, so a monthly count reads straight off it), by_source (raw rows per source name, to choose a source filter), items (kind, id, at, local time, text, entities; notes carry the raw ids they cite) and next_offset (null on the last page; pass it as offset to page on). Enumerate the dated items, then count, sum or pick the latest yourself; read the totals before the items. Policy-withheld rows are never shown.';
export const LIST_PROPS = {
  entity: 's:entity id, name or alias (a name matches exactly, case-insensitive); notes and work linked to it, and raw rows it was mentioned in or its notes cite',
  term: 's:words that must ALL occur in the text',
  source: 's:raw source name, or a prefix ending in * (e.g. hevy, gmail*); narrows raw rows only',
  kinds: { type: 'array', items: { type: 'string', enum: ['note', 'work', 'raw'] }, description: 'subset of note | work | raw; default all three' },
  since: 's:window start: YYYY-MM-DD is a local day in tz; a full ISO instant is exact',
  until: 's:window end: YYYY-MM-DD is a local day in tz and INCLUDES that day; a full ISO instant is exclusive',
  tz: 's:IANA zone for the local days and months; default the owner zone',
  order: 's:asc (default, oldest first) | desc (newest first; page 1 holds the latest)',
  limit: 'i:items per page, default 50, max 500; totals and by_month always cover every match',
  offset: 'i:page start, from next_offset',
  chars: 'i:clip of each item text, default 240, max 4000',
};

/** [binary, args, request] for one list call: the Node CLI, read-only, tz and page size defaulted. */
export function listCall(store, payload, env = process.env) {
  const bin = env.TOPHAT_RUNNER_NODE || process.execPath;
  const req = { ...payload };
  for (const k of Object.keys(req)) if (req[k] === undefined || req[k] === null || req[k] === '') delete req[k];
  req.tz ??= ownerZone(env); req.limit ??= 50; req.chars ??= 240;
  return [bin, [join(store.cwd, 'rev6', 'push', 'cli.mjs'), '--db', store.db, '--read-only', 'list'], req];
}
