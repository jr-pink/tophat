// Publish and adopt page subtrees. A published subtree is a PageNode record: derived, never a note, never evidence.
// It is stored with scopes = its audience (the groups holding every note it rests on). A viewer adopts a record only
// when its key equals the key of the same node in the viewer's own plan, every note it cites is one the viewer holds,
// its signature verifies and its author is trusted for a group it came through. An own page is a page whose audience
// is only its owner: the same code builds, publishes and adopts both.
import { audience, canonical, nodeKey, recordHash, sign as signRecord, verify } from './keys.mjs';
import { plan, walk } from './plan.mjs';

export const RECORD_TYPE = 'PageNode';

/**
 * Who may write pages for a group: the designated runner by default; every member when the group is small and
 * trusted (`allMembers`).
 */
export function pagewritersFor({ runner = null, members = [], allMembers = false } = {}) {
  return allMembers ? [...new Set(members)].sort() : runner ? [runner] : [];
}

/**
 * Trust: { groups: the viewer's groups, pagewriters: { group: [authors] }, local: [authors the viewer added],
 * publicKeyOf(author) -> PEM or null }. An author is trusted for an entry when the viewer added them, or when they are
 * a pagewriter of a group that both carries the entry and holds the viewer.
 */
export function trustedAuthor(entry, trust) {
  const a = entry.record?.author;
  if (!a) return false;
  if ((trust.local || []).includes(a)) return true;
  const mine = new Set(trust.groups || []);
  return (entry.scopes || []).some((g) => mine.has(g) && (trust.pagewriters?.[g] || []).includes(a));
}

/** Why `entry` may not be adopted at `node` of the viewer's plan (null when it may). viewerIds: Set of the viewer's note ids. */
export function rejectReason(entry, node, viewerIds, trust, { entity, generatorVersion }) {
  const r = entry?.record;
  if (!r || r.type !== RECORD_TYPE) return 'not a page node';
  if (r.entity !== entity || r.generatorVersion !== generatorVersion || r.path !== node.path) return 'different entity, generator or place';
  if (r.key !== node.key) return 'key differs from the viewer\'s own';
  if (!Array.isArray(r.citedNoteIds) || nodeKey(r.entity, r.citedNoteIds, r.generatorVersion, r.path) !== r.key) return 'cited notes do not hash to the key';
  if (!r.citedNoteIds.every((id) => viewerIds.has(id))) return 'cites a note the viewer does not hold';
  if (canonical(r.childKeys || []) !== canonical(node.children.map((c) => c.key))) return 'children differ from the viewer\'s plan';
  if (!verify(r, trust.publicKeyOf?.(r.author))) return 'signature does not verify';
  if (!trustedAuthor(entry, trust)) return 'author is not a trusted pagewriter';
  return null;
}

/** Of adoptable entries for one key: the earliest clock wins, the record hash breaks ties. */
export function pickEarliest(entries) {
  let best = null, bestHash = null;
  for (const e of entries) {
    const h = recordHash(e.record);
    if (!best || e.record.at < best.record.at || (e.record.at === best.record.at && h < bestHash)) { best = e; bestHash = h; }
  }
  return best;
}

/**
 * Adopt or generate, per node, top-down over the viewer's own plan.
 *   view: { entity, notes, facets?, generatorVersion?, leafMax?, levels? } (or a precomputed `tree`)
 *   published: entries { record, scopes } the viewer can read
 * Returns { tree, decisions: Map path -> { action: 'adopt'|'generate', entry?, rejected: [reasons] }, stats }.
 * A node under an adopted ancestor is elided: its record is still looked up by key (the subtree's text came with the
 * ancestor), and generated only when no adoptable record exists for it.
 */
export function decide(view, published, trust) {
  const generatorVersion = view.generatorVersion ?? 'g1';
  const tree = view.tree ?? plan(view.entity, view.notes, { facets: view.facets || [], generatorVersion, leafMax: view.leafMax, levels: view.levels });
  const viewerIds = new Set(tree.noteIds);
  const byKey = new Map();
  for (const e of published || []) { const k = e?.record?.key; if (!k) continue; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
  const decisions = new Map();
  const stats = { nodes: 0, adopted: 0, generated: 0, elided: 0 };
  const go = (node, underAdopted) => {
    stats.nodes++;
    if (underAdopted) stats.elided++;
    const rejected = [];
    const ok = (byKey.get(node.key) || []).filter((e) => { const why = rejectReason(e, node, viewerIds, trust, { entity: view.entity, generatorVersion }); if (why) rejected.push(why); return !why; });
    const entry = pickEarliest(ok);
    decisions.set(node.path, entry ? { action: 'adopt', entry, rejected } : { action: 'generate', rejected });
    stats[entry ? 'adopted' : 'generated']++;
    for (const c of node.children) go(c, underAdopted || !!entry);
  };
  go(tree, false);
  return { tree, decisions, stats };
}

/**
 * Text for every node: adopted text where decide() adopted, else generate(part), leaves before their parents (a
 * parent is re-rolled from its children's texts). Returns { texts: Map path -> text, records: new PageNode records
 * (signed when privateKey is given), adopted: entries }.
 *   generate(part): part is { kind: 'leaf', entity, path, notes } or { kind: 'rollup', entity, path, children: [{ path, text }] }
 */
export async function materialize({ entity, tree, decisions, generatorVersion = 'g1', generate, author, clock, privateKey = null, facetList = [] }) {
  const texts = new Map(), records = [], adopted = [];
  const visit = async (node) => {
    for (const c of node.children) await visit(c);
    const d = decisions.get(node.path);
    if (d?.action === 'adopt') { texts.set(node.path, d.entry.record.text); adopted.push(d.entry); return; }
    const part = node.children.length
      ? { kind: 'rollup', entity, path: node.path, children: node.children.map((c) => ({ path: c.path, text: texts.get(c.path) })) }
      : { kind: 'leaf', entity, path: node.path, notes: node.notes };
    const text = String(await generate(part));
    texts.set(node.path, text);
    const rec = { type: RECORD_TYPE, entity, path: node.path, key: node.key, text, citedNoteIds: node.noteIds, childKeys: node.children.map((c) => c.key),
      facetList: node.path === '' ? facetList : [], generatorVersion, author, at: clock.tick() };
    records.push(privateKey ? signRecord(rec, privateKey) : rec);
  };
  await visit(tree);
  return { texts, records, adopted };
}

/**
 * Publish records to `group`: the mechanical check is that the record's audience (groups holding every note it
 * cites, from scopesOf) includes `group`. Accepted records are appended with scopes = audience, narrowed to
 * `writable` when given. Returns { published: [{ key, path, scopes }], skipped: [{ key, path, audience, reason }] }.
 */
export async function publish(log, records, group, { scopesOf, writable = null }) {
  const published = [], skipped = [];
  for (const r of records) {
    const aud = audience(r.citedNoteIds || [], scopesOf);
    if (r.type !== RECORD_TYPE) { skipped.push({ key: r.key, path: r.path, audience: aud, reason: 'not a page node' }); continue; }
    if (!aud.includes(group)) { skipped.push({ key: r.key, path: r.path, audience: aud, reason: `audience ${JSON.stringify(aud)} does not include ${group}` }); continue; }
    const scopes = writable ? aud.filter((g) => writable.includes(g)) : aud;
    await log.append(r, scopes);
    published.push({ key: r.key, path: r.path, scopes });
  }
  return { published, skipped };
}

/** The facet list of the newest trusted, verified root record for `entity` (to seed a viewer's facet identities). */
export function seedFacets(entries, trust, entity) {
  const roots = (entries || []).filter((e) => e.record?.type === RECORD_TYPE && e.record.entity === entity && e.record.path === ''
    && verify(e.record, trust.publicKeyOf?.(e.record.author)) && trustedAuthor(e, trust));
  roots.sort((a, b) => (a.record.at < b.record.at ? 1 : -1));
  return roots[0]?.record.facetList?.map((f) => ({ ...f })) ?? [];
}

/**
 * The log PageNodes live in, as an interface: append(record, scopes) and list({ entity, groups }) -> entries
 * { record, scopes } whose scopes meet `groups`. memoryLog() is the in-process implementation (tests, one process);
 * a replicated log implements the same two methods.
 */
export function memoryLog() {
  const entries = new Map();
  return {
    async append(record, scopes) { const h = recordHash(record) + (record.sig || ''); if (!entries.has(h)) entries.set(h, { record, scopes: [...scopes].sort() }); return h; },
    async list({ entity = null, groups } = {}) {
      const g = new Set(groups || []);
      return [...entries.values()].filter((e) => (!entity || e.record.entity === entity) && e.scopes.some((s) => g.has(s)));
    },
    get size() { return entries.size; },
  };
}

/**
 * The same interface over a replicated store (@tophat-md/linknotes): page nodes are stored rows, replicated to the
 * other devices and members through the hub like notes, and read back with the store's own rules. append() refuses a
 * record whose scopes are not inside its audience (the groups holding every note it cites, as the store sees them),
 * so publish()'s audience check is a pre-filter, not the enforcement. list() needs an entity: the store reads page
 * nodes per entity, and returns only those the viewer holds a scope of and whose every cited note it reads.
 */
export function storeLog(store) {
  return {
    async append(record, scopes) { return (await store.putPageNode(record, { scopes })).id; },
    async list({ entity = null, groups } = {}) {
      if (!entity) throw new Error('storeLog.list needs an entity (the store reads page nodes per entity)');
      const out = await store.pageNodes({ entity, scopes: groups });
      return out.map((e) => ({ record: e.record, scopes: e.scopes }));
    },
  };
}

export { walk };
