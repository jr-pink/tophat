// Exhaustive listing: every note, raw row and work item that matches a filter, in time order, with no relevance cut.
//
// Why: `search` is a ranked top-k, so a question that needs ALL the dated events of one kind (how many workouts in October, the average of the October weigh-ins, the latest B day) was answered
// from the 5-8 hits the ranking happened to return. `list` is the other read shape: a filter, not a ranking. The answerer enumerates the dated items, then counts, sums or picks the latest
// itself.
//
// Filters (at least one of entity, term, source is required; everything else narrows):
//   entity   entity id or name (a name matches the name or an alias exactly, case-insensitive); merged entities follow. Notes and
//            work linked to it; raw rows it was mentioned in or that its notes cite.
//   term     words that must ALL occur (full-text, same index as `search`): notes, work and raw text.
//   source   a raw source name, or a prefix ending in `*` ("git*", case-sensitive); narrows raw rows only.
//   kinds    subset of ["note","work","raw"]; default all three.
//   since, until   a window. A bare date (YYYY-MM-DD) is a local day in `tz` (default UTC); `until` as a bare date INCLUDES that
//            day; a full instant is exact and `until` is then exclusive.
//   order    "asc" (default, oldest first) or "desc"; limit (default 100, max 500) and offset page through the result.
//   chars    clip of each item's text (default 400, max 4000).
// Answer: total (matches before the page; policy-withheld rows are counted in `withheld_in_page`, never shown), by_month (count of
// each kind per local month over ALL matches, so a count question reads off it), by_source (raw rows per source name, to pick a `source` filter), items (kind, id, at, source, text, entities) and
// next_offset (null on the last page). Notes carry the raw ids they cite (`cites`) so a note and the record it came from can be told apart.
import { ftsQuery, StoreError } from './store.mjs';

/** The index a source-and-window listing seeks by; built by the Python store's read-write open (rev5/store.py, same statement). */
export const RAW_SOURCE_TIME_INDEX = 'CREATE INDEX IF NOT EXISTS raw_source_time ON raw_data(source, occurred_at)';
const KIND_SET = ['note', 'work', 'raw'];
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
/** The instant a local calendar day starts in `tz`. */
export function dayStart(day, tz) {
  if (!tz || tz === 'UTC') return new Date(`${day}T00:00:00.000Z`).toISOString();
  let ms = Date.parse(`${day}T00:00:00.000Z`);
  ms -= tzOffsetMs(ms, tz); ms = Date.parse(`${day}T00:00:00.000Z`) - tzOffsetMs(ms, tz);
  return new Date(ms).toISOString();
}
function bound(value, which, tz) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (DAY.test(s)) {
    if (which === 'since') return dayStart(s, tz);
    const next = new Date(Date.parse(`${s}T12:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    return dayStart(next, tz);
  }
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/u.test(s) ? s : `${s}Z`);
  if (Number.isNaN(ms)) throw new StoreError(`${which} is not a date or instant: ${s}`);
  return new Date(ms).toISOString();
}
const monthOf = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}`;
};
const localStamp = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const clip = (s, n) => { s = String(s ?? ''); const a = [...s]; return a.length <= n ? s : a.slice(0, n).join('') + '…'; };
const inList = (ids) => `(SELECT value FROM json_each('${JSON.stringify(ids).replace(/'/gu, "''")}'))`;

export function listItems(store, req = {}) {
  const tz = req.tz || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new StoreError(`unknown tz ${tz}`); }
  const kinds = req.kinds === undefined || req.kinds === null ? KIND_SET : [].concat(req.kinds);
  for (const k of kinds) if (!KIND_SET.includes(k)) throw new StoreError(`kinds must be a subset of ${JSON.stringify(KIND_SET)}`);
  const term = String(req.term ?? '').trim(), source = String(req.source ?? '').trim(), entityArg = String(req.entity ?? '').trim();
  if (!term && !source && !entityArg) throw new StoreError('list needs at least one of entity, term, source');
  const expr = term ? ftsQuery(term, 16, true) : '';
  if (term && !expr) throw new StoreError('term needs at least one word');
  const since = bound(req.since, 'since', tz), until = bound(req.until, 'until', tz);
  const order = req.order === 'desc' ? 'desc' : 'asc';
  const limit = Math.max(1, Math.min(parseInt(req.limit ?? 100, 10) || 100, 500)), offset = Math.max(0, parseInt(req.offset ?? 0, 10) || 0);
  const chars = Math.max(40, Math.min(parseInt(req.chars ?? 400, 10) || 400, 4000));

  let entityIds = null, entities = [];
  if (entityArg) {
    const hit = store.all("SELECT id, name, aliases FROM entities WHERE merged_into IS NULL AND (id=:a OR lower(name)=lower(:a) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(aliases) THEN aliases ELSE '[]' END) WHERE lower(value)=lower(:a)))", { a: entityArg });
    if (!hit.length) return { ok: true, total: { note: 0, work: 0, raw: 0 }, by_month: {}, by_source: {}, returned: 0, withheld_in_page: 0, offset: 0, items: [], next_offset: null, entities: [], note: `no entity named or aliased ${JSON.stringify(entityArg)}` };
    entities = hit.map((e) => ({ id: e.id, name: e.name }));
    entityIds = [...new Set(hit.flatMap((e) => store.clusterIds(e.id)))];
  }
  const win = (col, args, p) => { let c = ''; if (since) { args[`${p}s`] = since; c += ` AND ${col} >= :${p}s`; } if (until) { args[`${p}u`] = until; c += ` AND ${col} < :${p}u`; } return c; };

  // candidates: [{ kind, id, at }]
  const cand = [];
  // Query shape: a filter must reach its rows through an index, never a table scan. The first version scanned raw_data for an entity (27 s:
  // every row's text is read) and all 19k notes and 5.7k work items for a term (1.6 s). So the id sets come first, from the indexes built for
  // them (mem_search / raw_search full text; mentions and note_entities by entity; a note's cited raw ids), and each table is then read by
  // primary key from the set. list.test.mjs guards the plans.
  const ftsIds = (kind) => [...new Set(store.all('SELECT id FROM mem_search WHERE mem_search MATCH ? AND kind=?', [expr, kind]).map((r) => r.id))];
  const idSet = (args, ids) => { args.ids = JSON.stringify(ids); return '(SELECT value FROM json_each(:ids))'; };
  for (const kind of ['note', 'work']) {
    if (!kinds.includes(kind) || source) continue;
    const isNote = kind === 'note', args = {}, at = isNote ? 'COALESCE(n.at, n.created_at)' : 'w.created_at', t = isNote ? 'n' : 'w';
    const keep = term ? ftsIds(kind) : null;
    if (keep && !keep.length) continue;
    let sql = `SELECT DISTINCT ${t}.id, ${at} AS at FROM ${isNote ? 'notes n' : 'work w'}`;
    if (entityIds) sql += ` JOIN ${isNote ? 'note_entities ne ON ne.note_id=n.id' : 'work_entities we ON we.work_id=w.id'} AND ${isNote ? 'ne' : 'we'}.entity_id IN ${inList(entityIds)}`;
    sql += ` WHERE 1=1${keep ? ` AND ${t}.id IN ${idSet(args, keep)}` : ''}${win(at, args, t)}`;
    for (const r of store.all(sql, args)) cand.push({ kind, id: r.id, at: r.at });
  }
  if (kinds.includes('raw')) {
    const args = { as_of: '9' };
    // raw rows tied to the entity: mentions of it, and the raw ids its notes cite; empty means no raw row can match.
    let tied = null;
    if (entityIds) {
      tied = [...new Set([
        ...store.all(`SELECT raw_id AS id FROM mentions WHERE entity_id IN ${inList(entityIds)} AND raw_id IS NOT NULL`).map((r) => r.id),
        ...store.all(`SELECT j.value AS id FROM note_entities ne JOIN notes n ON n.id=ne.note_id, json_each(n.source_refs) j WHERE ne.entity_id IN ${inList(entityIds)}`).map((r) => r.id),
      ])];
    }
    if (!tied || tied.length) {
      let sql = 'SELECT r.id, r.occurred_at AS at, r.source FROM raw_data r';
      sql += ` WHERE ${store.localOnlyCut} AND ${'(r.occurred_at <= :as_of AND NOT EXISTS (SELECT 1 FROM raw_data n WHERE n.source=r.source AND n.account=r.account AND n.native_id=r.native_id AND n.rowid>r.rowid))'}`;
      if (tied) sql += ` AND r.id IN ${idSet(args, tied)}`;
      if (expr) { args.q = expr; sql += ' AND r.id IN (SELECT id FROM raw_search WHERE raw_search MATCH :q)'; }
      if (source) {
        // A prefix is a range on the indexed column (LIKE cannot use the index here: 22 s for "hevy*" on the live store); case-sensitive, as source names are.
        if (source.endsWith('*')) { const pre = [...source.slice(0, -1)]; if (pre.length) { const last = pre.pop(); args.lo = [...pre, last].join(''); args.hi = [...pre, String.fromCodePoint(last.codePointAt(0) + 1)].join(''); sql += ' AND r.source >= :lo AND r.source < :hi'; } }
        else { args.src = source; sql += ' AND r.source=:src'; }
      }
      sql += win('r.occurred_at', args, 'r');
      for (const r of store.all(sql, args)) cand.push({ kind: 'raw', id: r.id, at: r.at, source: r.source });
    }
  }
  cand.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  if (order === 'desc') cand.reverse();

  const total = { note: 0, work: 0, raw: 0 }, by_month = {}, by_source = {};
  for (const c of cand) {
    total[c.kind]++; if (c.source !== undefined) by_source[c.source] = (by_source[c.source] || 0) + 1;
    const m = monthOf(c.at, tz); (by_month[m] ||= { note: 0, work: 0, raw: 0 })[c.kind]++;
  }
  const page = cand.slice(offset, offset + limit);
  const items = []; let withheld = 0;
  for (const c of page) {
    if (c.kind === 'raw') {
      const row = store.one('SELECT * FROM raw_data WHERE id=?', [c.id]);
      const view = store.rawView(row, true);
      if ('withheld' in view) { withheld++; continue; }
      items.push({ kind: 'raw', id: c.id, at: c.at, local: localStamp(c.at, tz), source: row.source, role: row.role, thread: row.thread, text: clip(row.text, chars), text_chars: view.text_chars });
    } else {
      const head = store.head(c.kind, c.id);
      if (!head) { withheld++; continue; }
      const ents = store.all(`SELECT e.id, e.name FROM ${c.kind === 'note' ? 'note_entities x JOIN entities e ON e.id=x.entity_id WHERE x.note_id' : 'work_entities x JOIN entities e ON e.id=x.entity_id WHERE x.work_id'}=?`, [c.id]);
      items.push({ kind: c.kind, id: c.id, at: c.at, local: localStamp(c.at, tz), text: clip(c.kind === 'note' ? head.body : `${head.title}${head.body ? ' | ' + head.body : ''} [${head.status}]`, chars),
        entities: ents.map((e) => e.name), cites: (head.source_refs || []).slice(0, 6) });
    }
  }
  const end = offset + page.length;
  return { ok: true, window: { since, until, tz, order }, entities, total, by_month, by_source, returned: items.length, withheld_in_page: withheld, offset, next_offset: end < cand.length ? end : null, items };
}
