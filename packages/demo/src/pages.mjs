// Model-written entity pages for the demo's graph snapshot, rebuilt at most once a day.
//
// The store's own page (linknotes pageFor) is a mechanical outline: the entity, then one line per note. This step writes the
// dense kind instead: for each entity it builds the page writer's input (the entity, the notes the instance scope reads, work
// if any), calls the configured model once through the push providers, and stores the outline as signed PageNode records in the
// instance scope (putPageNode). The snapshot (seed.mjs) prefers those records and falls back to the mechanical page.
//
//   - once a day: the state file (<instance state>/demo-pages/state.json) records the day and time of the last run; a second run
//     the same day returns { skipped } without opening the store (`force` overrides). A run that fails on every entity still counts
//     as the day's run, so a broken model never spends the cap more than once a day.
//   - unchanged entities cost nothing: the page writer hashes its input (notes, their text and times, work, as_of) and the state
//     keeps the hash and the prompt's hash of each written page; an entity whose hash and prompt match is skipped before any call.
//   - a model failure (transport, refusal, unusable outline) leaves the entity's existing page untouched; nothing is written for it.
//   - the per-run cap, the token limit and the input budget are demo.json `pages` (README, Config); nothing here defaults them.
//
// The page writer (linknotes vendor/rev6/push/pages.mjs proposePage) takes a synchronous model callback and the push providers are
// asynchronous, so each entity is two passes over the same deterministic function: the first captures the request the writer
// would send, the model is awaited, and the second pass feeds the reply back. The writer's own checks (cited labels, tree shape,
// coverage) run on the real reply; an unusable reply is a failure, never a stored page.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clock, keypair, nodeKey, sign } from '@tophat-md/groups';
import { makeProvider } from '@tophat-md/push/providers';
import { openStore } from '@tophat-md/runner/store/memory.mjs';
import { DEFAULT_BUDGET, buildPacket, checkInput, numbered, pagePrompt, proposePage } from '@tophat-md/linknotes/pages';

export const PAGE_AUTHOR = 'tophat-demo-pages';
export const GENERATOR = 'outline-1';
const KEY_ENV = 'TOPHAT_DEMO_PAGES_MODEL_KEY';
const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const iso = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** demo.json `pages`: { model (the instance models entry), maxCalls, maxTokens, maxInputChars }. A missing or malformed value is an error. */
export function pagesConfig(c) {
  const p = c?.pages;
  if (!p || typeof p !== 'object') throw new Error('demo.json pages is required: { model, maxCalls, maxTokens, maxInputChars } (packages/demo/README.md, Config)');
  if (typeof p.model !== 'string' || !p.model) throw new Error('demo.json pages.model is required: the name of an entry of the instance file models');
  const num = (k) => { if (!Number.isInteger(p[k]) || p[k] < 1) throw new Error(`demo.json pages.${k} is required: a positive integer`); return p[k]; };
  return { model: p.model, maxCalls: num('maxCalls'), maxTokens: num('maxTokens'), maxInputChars: num('maxInputChars') };
}

// ---- state: the day of the last run and the input hash of every written page ----
const stateFile = (dir) => path.join(dir, 'state.json');
function readState(dir) {
  try { const s = JSON.parse(readFileSync(stateFile(dir), 'utf8')); return { day: s.day ?? null, builtAt: s.builtAt ?? null, entities: s.entities && typeof s.entities === 'object' ? s.entities : {} }; }
  catch (e) { if (e.code === 'ENOENT') return { day: null, builtAt: null, entities: {} }; throw e; }
}
function writeState(dir, state) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${stateFile(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
  renameSync(tmp, stateFile(dir));
}
function signingKey(dir) {
  const f = path.join(dir, 'signing-key.pem');
  if (existsSync(f)) return readFileSync(f, 'utf8');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey } = keypair();
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, privateKey, { mode: 0o600 });
  renameSync(tmp, f);
  return privateKey;
}

// ---- PageNode records <-> the outline the page writer and the snapshot use ----
/** The records of one page: a node per outline point (path = its number, "1", "1.2"), then the root ('') that names the top-level points. */
export function recordsFor({ entity, nodes, generatorVersion, author = PAGE_AUTHOR, clock, privateKey }) {
  const ordered = numbered(nodes);
  const kids = new Map();
  for (const n of ordered) { const k = n.parent ?? null; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(n); }
  const cited = new Map();
  const citedOf = (n) => {
    if (cited.has(n.id)) return cited.get(n.id);
    const own = [...new Set(n.notes || [])];
    const ids = own.length ? own : [...new Set((kids.get(n.id) || []).flatMap(citedOf))];
    cited.set(n.id, ids);
    return ids;
  };
  const every = [...new Set(ordered.flatMap(citedOf))].sort();
  // a point that rests on current work alone cites no note; a PageNode must cite one, so it takes the page's notes
  const notesOf = (n) => (citedOf(n).length ? citedOf(n) : every);
  const keyOf = new Map(ordered.map((n) => [n.id, nodeKey(entity.id, notesOf(n), generatorVersion, n.num)]));
  const out = ordered.map((n) => ({ type: 'PageNode', entity: entity.id, path: n.num, key: keyOf.get(n.id), text: n.text, citedNoteIds: notesOf(n),
    childKeys: (kids.get(n.id) || []).map((k) => keyOf.get(k.id)), facetList: [], generatorVersion, author, at: clock.tick() }));
  out.push({ type: 'PageNode', entity: entity.id, path: '', key: nodeKey(entity.id, every, generatorVersion, ''), text: `${entity.name} (${entity.type})`, citedNoteIds: every,
    childKeys: (kids.get(null) || []).map((k) => keyOf.get(k.id)), facetList: [], generatorVersion, author, at: clock.tick() });
  return out.map((r) => sign(r, privateKey));
}

/**
 * The newest complete model-written page in `entries` (store.pageNodes of one entity): { nodes: [{ id, parent, order, text, notes }], generation, at }, or null.
 * A generation is the records sharing a generator version; it is complete when its root ('') is there and every child key a record names is too, so a
 * run that died half way, or a note retracted since, never shows as a page with holes (the caller falls back to the mechanical page).
 */
export function modelPageOf(entries) {
  const gens = new Map();
  for (const e of entries || []) {
    const r = e.record;
    if (!r || r.type !== 'PageNode' || r.author !== PAGE_AUTHOR || !String(r.generatorVersion).startsWith(`${GENERATOR}:`)) continue;
    if (!gens.has(r.generatorVersion)) gens.set(r.generatorVersion, new Map());
    const byKey = gens.get(r.generatorVersion), seen = byKey.get(r.key);
    if (!seen || seen.at < r.at) byKey.set(r.key, r);
  }
  const complete = [];
  for (const [generation, byKey] of gens) {
    const root = [...byKey.values()].find((r) => r.path === '');
    if (!root) continue;
    const nodes = [];
    let ok = true;
    const walk = (record, parent) => {
      record.childKeys.forEach((k, i) => {
        const r = byKey.get(k);
        if (!r) { ok = false; return; }
        nodes.push({ id: `n${r.path}`, parent, order: i + 1, text: r.text, author: 'model', notes: r.citedNoteIds });
        walk(r, `n${r.path}`);
      });
    };
    walk(root, null);
    if (ok && nodes.length) complete.push({ nodes, generation, at: root.at });
  }
  complete.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return complete[0] || null;
}

// ---- the build ----
const visibleEntities = (s, groups) => s.all("SELECT id, name, type FROM entities WHERE merged_into IS NULL AND id IN (SELECT pk FROM mc_acl WHERE t='entities' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [groups]);

/** The page writer's input for one entity, with the notes cut to what one call can carry (the newest that fit; the writer drops the oldest it cannot show). */
function inputFor(s, entity, base, maxInputChars) {
  const notes = s.entityNotes(entity.id, { limit: 1_000_000 }).map((n) => ({ id: n.id, text: n.body, at: iso(n.at || n.created_at), author: n.author || null })).filter((n) => String(n.text || '').trim());
  const work = (() => { try { return s.entityWork(entity.id).filter((w) => s.aclVisible('work', w.id)).map((w) => ({ id: w.id, status: w.status, text: w.title + (w.body ? `: ${w.body}` : ''), updated_at: w.updated_at })); } catch { return []; } })();
  const dated = notes.map((n) => n.at).filter(Boolean).sort();
  const as_of = dated.at(-1) || '1970-01-01T00:00:00.000Z';
  let inp = { entity: { id: entity.id, name: entity.name, type: entity.type }, as_of, notes, work, page: base, budget: { max_input_chars: maxInputChars } };
  const checked = checkInput(inp);
  if (checked.errors.length) return { inp, cut: 0 };
  const packet = buildPacket(inp, checked, { ...DEFAULT_BUDGET, ...inp.budget });
  let cut = 0;
  if (packet.omitted.length) { const drop = new Set(packet.omitted); cut = drop.size; inp = { ...inp, notes: notes.filter((n) => !drop.has(n.id)) }; }
  return { inp, cut };
}

/**
 * Write the day's pages. { db, scope } name the replica and the instance scope (as seed does); `provider` is a push provider ({ complete });
 * `limits` is pagesConfig(); `stateDir` holds state.json and the signing key. Returns a report; never throws for a model problem.
 */
export async function buildPages({ db, scope, stateDir, provider, limits, now = new Date(), force = false }) {
  const day = now.toISOString().slice(0, 10);
  const state = readState(stateDir);
  if (!force && state.day === day) return { skipped: 'already built today', day, builtAt: state.builtAt };
  const b = openStore(db, { TOPHAT_SCOPE: scope });
  const s = b.store;
  s.setViewer(s.user);
  const groups = JSON.stringify(s.viewer.groups);
  const privateKey = signingKey(stateDir), clock = new Clock('demo-pages');
  const promptSha = sha(pagePrompt()).slice(0, 16);
  const ents = visibleEntities(s, groups).map((e) => ({ ...e, n: s.entityNotes(e.id, { limit: 1_000_000 }).length })).filter((e) => e.n).sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));
  const report = { day, entities: ents.length, calls: 0, written: 0, unchanged: 0, failed: 0, capped: 0, usage: { input_tokens: 0, output_tokens: 0 }, errors: [] };
  const nowIso = now.toISOString();
  for (const e of ents) {
    const prior = state.entities[e.id];
    const existing = modelPageOf(await b.pageNodes({ entity: e.id }));
    const base = existing ? { nodes: existing.nodes, revision: prior?.revision ?? null, as_of: prior?.as_of ?? null, input_digest: prior && prior.prompt_sha === promptSha ? prior.input_digest : null } : {};
    const { inp } = inputFor(s, e, base, limits.maxInputChars);
    let request = null;
    const first = proposePage(inp, (r) => { request = r; return { ok: false, reason: 'capture' }; }, { now: nowIso });
    if (first.status === 'unchanged') { report.unchanged++; continue; }
    if (!request) { report.failed++; report.errors.push({ entity: e.name, reason: first.reason || first.status }); continue; }
    if (report.calls >= limits.maxCalls) { report.capped++; continue; }
    report.calls++;
    let reply;
    try { reply = await provider.complete({ system: request.system, user: request.user, maxTokens: limits.maxTokens }); }
    catch (err) { report.failed++; report.errors.push({ entity: e.name, reason: `model call failed: ${err.code || err.message}`.slice(0, 160) }); continue; }
    report.usage.input_tokens += reply?.usage?.input_tokens ?? 0;
    report.usage.output_tokens += reply?.usage?.output_tokens ?? 0;
    const done = proposePage(inp, () => ({ ok: true, text: reply?.text ?? '', model: reply?.model, usage: reply?.usage }), { now: nowIso });
    if (done.status === 'unchanged') { report.unchanged++; state.entities[e.id] = { ...(prior || {}), input_digest: done.input_digest, prompt_sha: promptSha, as_of: inp.as_of, at: nowIso }; continue; }
    if (done.status !== 'ok') { report.failed++; report.errors.push({ entity: e.name, reason: String(done.reason || done.status).slice(0, 160) }); continue; }
    try {
      const generatorVersion = `${GENERATOR}:${done.revision}`;
      for (const r of recordsFor({ entity: e, nodes: done.nodes, generatorVersion, clock, privateKey })) await b.putPageNode(r, { scopes: [scope] });
      state.entities[e.id] = { input_digest: done.input_digest, prompt_sha: promptSha, revision: done.revision, as_of: inp.as_of, at: nowIso, model: reply?.model ?? null };
      report.written++;
    } catch (err) { report.failed++; report.errors.push({ entity: e.name, reason: `store refused the page: ${err.message}`.slice(0, 160) }); }
  }
  writeState(stateDir, { day, builtAt: nowIso, entities: state.entities });
  return report;
}

/** buildPages for a parsed demo.json: the instance file names the models, the state directory and where the model key lives. */
export async function buildPagesFromConfig(c, { force = false, now = new Date() } = {}) {
  const limits = pagesConfig(c);
  const inst = JSON.parse(readFileSync(c.instance, 'utf8'));
  const entry = inst.models?.[limits.model];
  if (!entry) throw new Error(`demo.json pages.model "${limits.model}" names no entry of the instance file models`);
  const stateDir = path.join(expand(inst.paths.state), 'demo-pages');
  if (!force && readState(stateDir).day === now.toISOString().slice(0, 10)) return { skipped: 'already built today', day: now.toISOString().slice(0, 10), builtAt: readState(stateDir).builtAt };
  const secrets = expand(inst.paths?.secrets || path.join(expand(inst.paths?.config || `~/.config/tophat/${inst.name}`), 'secrets'));
  const { resolveRef } = await import('@tophat-md/deploy/instance');
  const { credential, workspace, ...rest } = entry;
  const key = credential ? resolveRef(credential, { keyringDir: secrets }) : null;
  if (credential && !key) throw new Error(`the key of instance models.${limits.model} does not resolve (${Object.keys(credential)[0]} ${Object.values(credential)[0]})`);
  const provider = makeProvider({ provider: 'openai', ...rest, ...(key ? { apiKeyEnv: KEY_ENV } : {}) }, { env: { [KEY_ENV]: key } });
  return buildPages({ db: c.db, scope: c.scope, stateDir, provider, limits, now, force });
}
