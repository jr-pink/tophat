// Entity pages (rev5 pages.py): one numbered outline per entity where every parent compresses its
// subtree, written from accepted notes and current work only. The model sees letter codes, never ids;
// code keeps node identity, refs, human edits, structure and the change log.
import { withOwner } from '../base/owner.mjs';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cpLen, cpSlice, digest, firstJson, instant, isObj, nowIso, pyDumpsOrdered, pyRepr, pyStr, sha256 } from './common.mjs';

export const PROMPT_PATH = new URL('./prompts/page_prompt.txt', import.meta.url);
/** The page system prompt as sent: the owner named from config.json profile. Hashed rendered, so a name that renders
 *  the pre-template text ("the owner") keeps every cached page key. */
export const pagePrompt = () => withOwner(readFileSync(PROMPT_PATH, 'utf8'));
export const WORK_STATES = ['todo', 'done', 'dropped'];
export const DEFAULT_BUDGET = { max_input_chars: 160000, max_note_chars: 3000, max_nodes: 200, max_depth: 6, max_node_chars: 900, max_work_chars: 40000 };
const NUM = /^\d+(\.\d+)*$/u;

export function codeFor(i) { let out = ''; i += 1; while (i) { const r = (i - 1) % 26; i = Math.floor((i - 1) / 26); out = String.fromCharCode(65 + r) + out; } return out; }
const numKey = (num) => num.split('.').map(Number);
const cmpKey = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] === undefined) return -1; if (b[i] === undefined) return 1; if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
const orderOf = (n) => { const v = n.order === null || n.order === undefined || n.order === '' || typeof n.order === 'boolean' ? NaN : Number(n.order); return Number.isFinite(v) ? v : 0; };

/** Nodes with num and depth, depth-first, siblings by order (stable); throws on a dangling parent or a cycle. */
export function numbered(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n])), children = new Map();
  for (const n of nodes) {
    const p = n.parent ?? null;
    if (p !== null && !byId.has(p)) throw new Error(`node ${pyStr(n.id)} has dangling parent ${pyStr(p)}`);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(n);
  }
  const out = [], seen = new Set();
  const walk = (parent, prefix, depth) => {
    const kids = [...(children.get(parent) || [])].map((n, i) => [n, i]).sort((a, b) => orderOf(a[0]) - orderOf(b[0]) || a[1] - b[1]).map(([n]) => n);
    kids.forEach((n, i) => {
      if (seen.has(n.id)) throw new Error(`cycle through node ${pyStr(n.id)}`);
      seen.add(n.id);
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push({ ...n, num, depth });
      walk(n.id, num, depth + 1);
    });
  };
  walk(null, '', 1);
  if (out.length !== nodes.length) throw new Error('nodes unreachable from the root: a cycle or an orphan');
  return out;
}

export function renderBfs(nodes, budget = null, refs = false) {
  const ordered = numbered(nodes).sort((a, b) => a.depth - b.depth || cmpKey(numKey(a.num), numKey(b.num)));
  const lines = [], omitted = []; let used = 0;
  for (const n of ordered) {
    const line = `${n.num}. ${n.text}` + (refs && n.refs?.length ? ` [refs: ${n.refs.join(', ')}]` : '');
    if (omitted.length || (budget !== null && used + cpLen(line) + 1 > budget)) omitted.push(n);
    else { used += cpLen(line) + 1; lines.push(line); }
  }
  if (omitted.length) {
    const hidden = new Set(omitted.map((n) => n.id));
    lines.push(`[${ordered.length - omitted.length} of ${ordered.length} points shown; hidden text is not absent data. Expand by node id:]`);
    for (const n of omitted) {
      if (hidden.has(n.parent)) continue;
      const words = String(n.text).split(/\s+/u).filter(Boolean);
      lines.push(`${n.num} (${n.id}): ${words.slice(0, 24).join(' ')}${words.length > 24 ? ' …' : ''}`);
    }
  }
  const text = lines.join('\n');
  return { text, shown: ordered.length - omitted.length, total: ordered.length, chars: cpLen(text), body_chars: Math.max(0, used - 1),
    navigation_chars: cpLen(text) - Math.max(0, used - 1), omitted: omitted.map((n) => ({ id: n.id, num: n.num, depth: n.depth })) };
}

export function checkInput(inp) {
  const errors = [], entity = inp.entity || {};
  if (!entity.id || !entity.name) errors.push('entity needs id and name');
  let asOf = null;
  try { if (!('as_of' in inp)) throw new Error("'as_of'"); asOf = instant(inp.as_of); } catch (e) { errors.push(`as_of missing or unreadable: ${e.message}`); }
  const notes = [], later = [], ids = new Set();
  (inp.notes || []).forEach((note, i) => {
    const nid = note.id;
    if (!nid || ids.has(nid) || !String(note.text ?? '').trim()) { errors.push(`notes[${i}] needs a unique id and text`); return; }
    ids.add(nid);
    let at = null;
    try { at = note.at ? instant(note.at) : null; } catch { errors.push(`note ${nid} has unreadable at`); return; }
    (asOf && at && at > asOf ? later : notes).push({ ...note, at });
  });
  const workIds = new Set();
  (inp.work || []).forEach((w, i) => { if (!w.id || workIds.has(w.id) || !WORK_STATES.includes(w.status)) errors.push(`work[${i}] needs a unique id and a status in ('todo', 'done', 'dropped')`); workIds.add(w.id); });
  try { numbered(inp.page?.nodes || []); } catch (e) { errors.push(`existing page is not a tree: ${e.constructor.name === 'Error' ? 'ValueError' : e.constructor.name}: ${e.message}`); }
  return { errors, as_of: asOf, notes, later };
}

export function buildPacket(inp, checked, budget) {
  const entity = inp.entity, base = numbered(inp.page?.nodes || []);
  const codes = new Map(base.map((n, i) => [n.id, codeFor(i)]));
  const lines = [`ENTITY: ${entity.name} (id ${entity.id}; type ${entity.type ?? 'unknown'})`];
  if (entity.aliases?.length) lines.push('ALSO CALLED: ' + entity.aliases.join('; '));
  lines.push(`AS OF: ${checked.as_of}`);
  if (inp.scope) lines.push(`SCOPE: ${inp.scope}`);
  lines.push('\nCURRENT OUTLINE' + (base.length ? '' : ' (empty; write the first one)'));
  const carried = new Set(inp.carried || []);
  for (const n of base) lines.push(`${n.num} [${codes.get(n.id)}]${n.author === 'human' ? ' [HUMAN EDIT: keep verbatim]' : ''}${carried.has(n.id) ? ' [CARRIED: its notes are older than those shown; keep it with "from" and no citations to carry it verbatim, or cite shown notes to revise it]' : ''} ${n.text}`);
  const work = inp.work || [];
  const workLine = (w, i, clipAt = null) => { const text = clipAt && cpLen(w.text) > clipAt ? cpSlice(w.text, 0, clipAt) + ' […]' : w.text; return `W${i + 1} [${w.status}] ${text}${w.progress ? ` | progress: ${w.progress}` : ''}${w.updated_at ? ` | updated ${instant(w.updated_at)}` : ''}`; };
  let shownWork = work.map((w, i) => [i, workLine(w, i)]);
  const workChars = shownWork.reduce((a, [, l]) => a + cpLen(l) + 1, 0);
  if (workChars > budget.max_work_chars) {
    // A hub carries hundreds of open tasks; the page names the live threads in one point, so it sees
    // the newest open work first, then recent closures, clipped.
    const order = work.map((w, i) => [w, i]).sort((a, b) => (a[0].status === 'todo') !== (b[0].status === 'todo') ? (a[0].status === 'todo' ? -1 : 1) : String(b[0].updated_at || '').localeCompare(String(a[0].updated_at || '')));
    let used = 0; shownWork = [];
    for (const [w, i] of order) { const l = workLine(w, i, 300); if (used + cpLen(l) + 1 > budget.max_work_chars) continue; used += cpLen(l) + 1; shownWork.push([i, l]); }
    shownWork.sort((a, b) => a[0] - b[0]);
    lines.push(`\nCURRENT WORK (${shownWork.length} of ${work.length} shown: open work newest first, then recent closures, each clipped; the rest stay in the task store)`);
  } else lines.push('\nCURRENT WORK' + (work.length ? '' : ' (none)'));
  lines.push(...shownWork.map(([, l]) => l));
  const rendered = [], truncated = [];
  [...checked.notes].sort((a, b) => ((a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach((note, i) => {
    let text = String(note.text).trim();
    if (cpLen(text) > budget.max_note_chars) { truncated.push(note.id); text = cpSlice(text, 0, budget.max_note_chars) + ` [cut at ${budget.max_note_chars} chars]`; }
    rendered.push([`N${i + 1}`, note, `N${i + 1} ${note.at || 'undated'}${note.author ? `; ${note.author}` : ''}${note.refs?.length ? ` refs=${note.refs.join(',')}` : ''}\n${text}`]);
  });
  let used = lines.reduce((s, l) => s + cpLen(l), 0); const shown = [], omitted = [];
  for (const r of [...rendered].reverse()) { if (used + cpLen(r[2]) + 2 > budget.max_input_chars) omitted.push(r[1].id); else { used += cpLen(r[2]) + 2; shown.push(r); } }
  shown.reverse(); omitted.reverse();
  lines.push(`\nNOTES (${shown.length} of ${rendered.length} shown` + (omitted.length ? `; ${omitted.length} older notes omitted for budget, so coverage is partial` : '') + (checked.later.length ? `; ${checked.later.length} notes later than AS OF excluded` : '') + ')');
  lines.push(...shown.map((r) => r[2]));
  return { text: lines.join('\n'), codes: Object.fromEntries([...codes].map(([id, c]) => [c, id])), base, notes: Object.fromEntries(shown.map(([l, n]) => [l, n])), omitted,
    truncated: truncated.filter((id) => !omitted.includes(id)), work: Object.fromEntries(shownWork.map(([i]) => [`W${i + 1}`, work[i]])) };
}

export function parseResponse(text) {
  let parsed;
  try { parsed = firstJson(text); } catch (e) {
    const body = String(text).trim().replace(/^```(?:json)?|```$/gmu, '').trim();
    const start = body.indexOf('{'); if (start < 0) throw new Error('no JSON object in response');
    const key = body.indexOf('"outline"', start), bracket = key >= 0 ? body.indexOf('[', key) : -1;
    if (bracket < 0) throw new Error(`unparseable response: ${e.message}`);
    parsed = { outline: firstArray(body.slice(bracket)), dropped: [], truncated: 'response cut after the outline; dropped list lost' };
  }
  if (!isObj(parsed) || !Array.isArray(parsed.outline)) throw new Error('response lacks an outline list');
  return parsed;
}
function firstArray(text) { try { return JSON.parse(text); } catch { /* fall through */ } const s = JSON.stringify; void s; let d = 0, q = false, e = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '[' || c === '{') d++; else if (c === ']' || c === '}') { d--; if (!d) return JSON.parse(text.slice(0, i + 1)); } } throw new Error('outline cut'); }

export function applyOutline(parsed, packet, inp, checked, budget) {
  const outline = parsed.outline;
  if (!outline.length) throw new Error('empty outline');
  if (outline.length > budget.max_nodes) throw new Error(`${outline.length} nodes exceeds max_nodes ${budget.max_nodes}`);
  const byNum = new Map(), usedCodes = new Set(), warnings = [];
  for (const entry of outline) {
    const num = pyStr(entry.num ?? '').trim(), text = pyStr(entry.text ?? '').trim();
    if (!NUM.test(num) || byNum.has(num)) throw new Error(`bad or duplicate num ${pyRepr(num)}`);
    if (!text) throw new Error(`point ${num} has no text`);
    if (cpLen(text) > budget.max_node_chars) warnings.push(`point ${num} is ${cpLen(text)} chars, over max_node_chars ${budget.max_node_chars}`);
    if (num.split('.').length > budget.max_depth) throw new Error(`point ${num} deeper than max_depth ${budget.max_depth}`);
    for (const kind of ['notes', 'work']) for (const l of entry[kind] || []) if (!(l in packet[kind])) throw new Error(`point ${num} cites unknown ${kind.slice(0, -1)} ${l}`);
    const carriedFrom = entry.from && packet.carried?.has(packet.codes[entry.from]);
    if (!(entry.notes?.length || entry.work?.length) && !carriedFrom) throw new Error(`point ${num} cites no note or work item`);
    const code = entry.from;
    if (code !== null && code !== undefined) { if (!(code in packet.codes) || usedCodes.has(code)) throw new Error(`point ${num} names unknown or reused code ${pyRepr(code)}`); usedCodes.add(code); }
    byNum.set(num, entry);
  }
  for (const num of byNum.keys()) if (num.includes('.') && !byNum.has(num.slice(0, num.lastIndexOf('.')))) throw new Error(`point ${num} has no parent point`);
  const baseById = new Map(packet.base.map((n) => [n.id, n])), nodes = [], idByNum = new Map(), refused = [];
  for (const num of [...byNum.keys()].sort((a, b) => cmpKey(numKey(a), numKey(b)))) {
    const entry = byNum.get(num);
    const notes = [...new Set(entry.notes || [])], work = [...new Set(entry.work || [])];
    const refs = [...notes.flatMap((l) => packet.notes[l].refs || []), ...work.flatMap((l) => packet.work[l].evidence || [])];
    let text = pyStr(entry.text).trim(), author = 'model';
    const old = entry.from ? baseById.get(packet.codes[entry.from]) : null;
    if (old && old.author === 'human') { author = 'human'; if (text !== old.text) { refused.push({ node: old.id, kept: old.text, proposed: text }); text = old.text; } }
    // A carried point (its support older than the notes shown) keeps its hidden support; with no
    // citation of its own it keeps its text verbatim too, since nothing shown could support an edit.
    const hiddenSupport = old && packet.hidden ? (old.notes || []).filter((id) => packet.hidden.has(id)) : [];
    if (old && packet.carried?.has(old.id) && !notes.length && !work.length) text = old.text;
    const nid = old ? old.id : 'p_' + digest([inp.entity.id, checked.as_of, num, text]).slice(0, 10);
    idByNum.set(num, nid);
    const k = numKey(num);
    const noteIds = [...new Set([...notes.map((l) => packet.notes[l].id), ...hiddenSupport])];
    for (const id of hiddenSupport) refs.push(...(packet.hidden.get(id)?.refs || []));
    nodes.push({ id: nid, parent: num.includes('.') ? idByNum.get(num.slice(0, num.lastIndexOf('.'))) ?? null : null, order: k[k.length - 1], text, author,
      notes: noteIds, work: work.map((l) => packet.work[l].id), refs: [...new Set(refs)] });
  }
  const kept = new Set(nodes.map((n) => n.id));
  for (const old of packet.base) if (old.author === 'human' && !kept.has(old.id)) {
    const parent = kept.has(old.parent) ? old.parent : null;
    const order = 1 + Math.max(0, ...nodes.filter((n) => n.parent === parent).map((n) => n.order));
    nodes.push({ id: old.id, parent, order, text: old.text, author: 'human', notes: old.notes || [], work: old.work || [], refs: old.refs || [] });
    refused.push({ node: old.id, kept: old.text, proposed: null });
  }
  numbered(nodes);
  return [nodes, refused, warnings];
}

export function changesBetween(base, nodes) {
  const old = new Map(numbered(base).map((n) => [n.id, n])), now = new Map(numbered(nodes).map((n) => [n.id, n])), out = [];
  for (const [id, n] of now) {
    if (!old.has(id)) { out.push({ op: 'added', node: id, num: n.num, text: n.text }); continue; }
    const o = old.get(id);
    if (o.text !== n.text) out.push({ op: 'edited', node: id, num: n.num, before: o.text, after: n.text });
    if ((o.parent ?? null) !== (n.parent ?? null) || o.num !== n.num) out.push({ op: 'moved', node: id, from_num: o.num, to_num: n.num });
  }
  for (const [id, p] of old) if (!now.has(id)) out.push({ op: 'removed', node: id, num: p.num, text: p.text });
  return out;
}

function coverageOf(nodes, packet, checked, inp, parsed) {
  const citedNotes = new Set(nodes.flatMap((n) => n.notes || [])), citedWork = new Set(nodes.flatMap((n) => n.work || []));
  const declared = new Map();
  for (const d of parsed.dropped || []) {
    const labels = isObj(d) && Array.isArray(d.notes) ? d.notes : isObj(d) ? [d.note] : [];
    for (const l of labels) if (l in packet.notes) declared.set(packet.notes[l].id, pyStr(d.why ?? '').trim());
  }
  const shown = Object.values(packet.notes).map((n) => n.id), up = inp.coverage || {};
  const uncited = shown.filter((i) => !citedNotes.has(i) && !declared.has(i));
  return { notes_total: checked.notes.length, notes_shown: shown.length, notes_omitted_for_budget: packet.omitted, notes_cited: citedNotes.size,
    notes_declared_dropped: [...declared].filter(([k]) => !citedNotes.has(k)).map(([id, why]) => ({ id, why })), notes_uncited: uncited, notes_truncated: packet.truncated,
    accounting_complete: !uncited.length && !parsed.truncated, notes_later_excluded: checked.later.map((n) => n.id),
    work_total: (inp.work || []).length, work_cited: citedWork.size, work_uncited: (inp.work || []).filter((w) => !citedWork.has(w.id)).map((w) => w.id),
    withheld_upstream: up.withheld ?? null, complete_input: !packet.omitted.length && !packet.truncated.length && !up.withheld && up.complete !== false };
}

/** One entity, one proposed page; model trouble returns refused/failed with the base untouched.
 *
 * Three routes, chosen by code. Everything fits the input budget: one call, as always. A base page exists and every
 * note newer than it fits: one call that shows the newest notes and CARRIES the base points whose support is older
 * (they keep their notes and text). Otherwise the page is a hub too big for one packet, and it is built hierarchically:
 * one sub-outline per period part (month, split to week, day, then size), cached by content in `parts` so a later cycle
 * rebuilds only the parts whose notes changed, then a top outline over the parts' branches.
 */
export function proposePage(inp, callModel, { now, budget, parts = null, facets = null } = {}) {
  budget = { ...DEFAULT_BUDGET, ...(budget || {}), ...(inp.budget || {}) };
  now = instant(now || nowIso());
  const checked = checkInput(inp), basePage = inp.page || {}, baseNodes = basePage.nodes || [];
  const result = { entity_id: inp.entity?.id ?? null, as_of: checked.as_of, generated_at: now, expected_base_revision: basePage.revision ?? null, budget, model: null, nodes: baseNodes, revision: basePage.revision ?? null, changes: [] };
  if (checked.errors.length) return { ...result, status: 'failed', reason: 'invalid input', errors: checked.errors };
  result.input_digest = digest([checked.as_of, checked.notes.map((n) => [n.id, n.text, n.at]), (inp.work || []).map((w) => [w.id, w.status, w.text ?? null, w.progress ?? null])]);
  if (!checked.notes.length && !(inp.work || []).length) return { ...result, status: 'unchanged', reason: 'no notes or work within as_of' };
  if (baseNodes.length && basePage.input_digest === result.input_digest) return { ...result, status: 'unchanged', reason: 'input digest matches the base page' };
  const packet = buildPacket(inp, checked, budget);
  if (!packet.omitted.length) return writeOutline(inp, checked, packet, callModel, budget, result, {});
  // A hub too big for one packet is built from content facets (facets.mjs) when the caller supplies a facet context.
  if (facets) return facets.build(inp, checked, callModel, budget, result, { now, parts });
  let baseAsOf = null; try { baseAsOf = basePage.as_of ? instant(basePage.as_of) : null; } catch { baseAsOf = null; }
  const byId = new Map(checked.notes.map((n) => [n.id, n]));
  const newerHidden = packet.omitted.some((id) => !baseAsOf || !byId.get(id)?.at || byId.get(id).at > baseAsOf);
  if (baseNodes.length && !newerHidden) return carryForward(inp, checked, packet, callModel, budget, result, byId);
  return buildHub(inp, checked, callModel, budget, result, { now, parts });
}

/** The base page's points whose support the budget hides are carried, not refused. */
function carryForward(inp, checked, packet, callModel, budget, result, byId) {
  const hidden = new Map(packet.omitted.map((id) => [id, byId.get(id)]));
  const carried = numbered(inp.page.nodes).filter((n) => (n.notes || []).length && n.notes.every((id) => hidden.has(id))).map((n) => n.id);
  const inp2 = { ...inp, carried };
  const packet2 = { ...buildPacket(inp2, checked, budget), hidden, carried: new Set(carried) };
  const out = writeOutline(inp2, checked, packet2, callModel, budget, result, {});
  if (out.coverage) out.coverage = { ...out.coverage, route: 'carry-forward', carried_points: carried.length };
  return out;
}

/** One model call over a built packet: validate, map codes back, log changes, account coverage. */
export function writeOutline(inp, checked, packet, callModel, budget, result, { meta = {}, extra = {} } = {}) {
  const system = pagePrompt();
  const response = callModel({ system, user: packet.text, ...extra, meta: { entity_id: inp.entity.id, as_of: checked.as_of, input_chars: cpLen(packet.text), ...meta } }) || {};
  result = { ...result, model: { ...Object.fromEntries(['model', 'usage', 'elapsed_ms', 'stop_reason'].filter((k) => k in response).map((k) => [k, response[k]])),
    prompt_sha256: sha256(system).slice(0, 16), input_chars: cpLen(packet.text), output_chars: cpLen(response.text || '') } };
  if (!response.ok) return { ...result, status: response.reason === 'refused' ? 'refused' : 'failed', reason: response.reason ?? 'no response', detail: response.detail ?? null };
  let parsed, nodes, refused, warnings;
  try { parsed = parseResponse(response.text ?? ''); [nodes, refused, warnings] = applyOutline(parsed, packet, inp, checked, budget); } catch (e) { return { ...result, status: 'failed', reason: `unusable outline: ${e.message}`, raw: response.text ?? null }; }
  if (parsed.truncated) warnings.push(parsed.truncated);
  const coverage = coverageOf(nodes, packet, checked, inp, parsed);
  if (!coverage.accounting_complete) warnings.push(`coverage accounting incomplete: ${coverage.notes_uncited.length} notes have no citation or declared drop`);
  if (parsed.truncated && coverage.notes_uncited.length) return { ...result, status: 'failed', reason: 'output cap cut coverage accounting; existing page retained', warnings, coverage, raw: response.text ?? null };
  const baseNodes = inp.page?.nodes || [];
  const changes = changesBetween(baseNodes, nodes);
  return { ...result, status: !changes.length && baseNodes.length ? 'unchanged' : 'ok', nodes, revision: digest(nodes.map((n) => [n.id, n.parent, n.order, n.text])), changes, refused_edits: refused, warnings, coverage, raw: response.text ?? null };
}

// ---- hub pages: built from parts ----
// Parts are compression of dated notes, so they run at low reasoning effort; the top outline keeps the default.
export const HUB = { part_chars: 130000, top_note_chars: 6000, max_levels: 4, version: 'hub-v1', part_effort: 'low' };
const noteCost = (n, budget) => 48 + cpLen(n.author || '') + (n.refs || []).join(',').length + Math.min(cpLen(String(n.text).trim()), budget.max_note_chars + 30);
const cost = (notes, budget) => notes.reduce((a, n) => a + noteCost(n, budget) + 2, 0);
/** True when the notes alone do not fit one packet: the page is built from parts. */
export function isHub(inp, budget = DEFAULT_BUDGET) { return cost(inp.notes || [], { ...DEFAULT_BUDGET, ...budget }) > ({ ...DEFAULT_BUDGET, ...budget }).max_input_chars - 20000; }

function weekOf(at) { const d = new Date(at.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return 'week of ' + d.toISOString().slice(0, 10); }
function sizeSplit(items, label, limit, budget) {
  const out = []; let cur = [], used = 0;
  for (const n of items) { const c = noteCost(n, budget) + 2; if (cur.length && used + c > limit) { out.push(cur); cur = []; used = 0; } cur.push(n); used += c; }
  if (cur.length) out.push(cur);
  return out.length === 1 ? [{ label, notes: out[0] }] : out.map((notes, i) => ({ label: `${label} (${i + 1} of ${out.length})`, notes }));
}
/** Stable period parts: a note added today changes only today's part. */
export function partition(notes, limit, budget = DEFAULT_BUDGET) {
  const sorted = [...notes].sort((a, b) => ((a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : a.id < b.id ? -1 : 1));
  const grains = [(n) => (n.at ? n.at.slice(0, 7) : 'undated'), (n) => (n.at ? weekOf(n.at) : 'undated'), (n) => (n.at ? n.at.slice(0, 10) : 'undated')];
  const split = (items, depth, label) => {
    if (cost(items, budget) <= limit) return [{ label, notes: items }];
    if (depth >= grains.length) return sizeSplit(items, label, limit, budget);
    const groups = new Map();
    for (const n of items) { const k = grains[depth](n); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
    const name = (k) => (depth === 1 ? `${label} / ${k}` : k);
    if (groups.size === 1) return depth + 1 >= grains.length ? sizeSplit(items, name([...groups.keys()][0]), limit, budget) : split(items, depth + 1, name([...groups.keys()][0]));
    return [...groups].flatMap(([k, g]) => split(g, depth + 1, name(k)));
  };
  // Adjacent small periods share a part (oldest first, so new notes only ever change the newest part).
  const merged = [];
  for (const g of split(sorted, 0, 'all')) {
    const last = merged[merged.length - 1];
    if (last && cost(last.notes, budget) + cost(g.notes, budget) <= limit) { last.notes = [...last.notes, ...g.notes]; last.last = g.label; }
    else merged.push({ label: g.label, notes: g.notes, last: g.label });
  }
  return merged.map((g) => ({ label: g.last === g.label ? g.label : `${g.label} to ${g.last}`, notes: g.notes }));
}

/** A part's outline as notes for the level above: one per top-level branch, carrying its subtree. */
export function branchesOf(nodes, key, underlying, budget) {
  const shape = numbered(nodes), kids = new Map();
  for (const n of shape) { const p = n.parent ?? null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
  const out = [];
  for (const top of kids.get(null) || []) {
    const lines = [top.text], ids = new Set(top.notes || []), refs = new Set(top.refs || []);
    const walk = (id, depth) => { for (const c of kids.get(id) || []) { lines.push(`${'  '.repeat(depth)}- ${c.text}`); (c.notes || []).forEach((x) => ids.add(x)); (c.refs || []).forEach((x) => refs.add(x)); walk(c.id, depth + 1); } };
    walk(top.id, 1);
    const real = new Set(); for (const id of ids) for (const r of underlying.get(id) || [id]) real.add(r);
    let text = lines.join('\n'); if (cpLen(text) > HUB.top_note_chars) text = cpSlice(text, 0, HUB.top_note_chars - 40) + ' [branch cut for length]';
    const ats = [...real].map((id) => underlying.at.get(id)).filter(Boolean).sort();
    out.push({ id: 'h_' + digest([key, top.id], 12), text, at: ats[ats.length - 1] || null, refs: [], allRefs: [...refs].sort(), underlying: [...real] });
  }
  void budget;
  return out;
}

/** Parts first (each cached by its content), then levels until the branches fit, then the top. */
function buildHub(inp, checked, callModel, budget, result, { now, parts }) {
  const promptSha = sha256(pagePrompt()).slice(0, 16);
  const underlying = new Map(); underlying.at = new Map(checked.notes.map((n) => [n.id, n.at]));
  const used = new Set(), built = { parts: 0, cached: 0, calls: 0, levels: 0, usage: [] };
  const partBudget = { ...budget, max_input_chars: Math.max(budget.max_input_chars, HUB.part_chars + 25000) };
  const runPart = (label, notes, k, n, level) => {
    const key = digest([HUB.version, inp.entity.id, level, label, notes.map((x) => [x.id, x.text, x.at]), promptSha]);
    used.add(key);
    const hit = parts?.get(key);
    if (hit) { built.cached++; return { ok: true, key, nodes: hit.nodes }; }
    const scope = level === 0
      ? `PART ${k} of ${n} of a hub page too large for one outline: only the notes dated ${label}. Write this period's outline compactly: 6 to 12 top-level points, at most 3 sub-points under each, every point under 400 characters; a top outline over all parts is written from it, so keep every decision, amount, date, name and open thread this period holds, and say when it happened.`
      : `LEVEL ${level} GROUP ${k} of ${n}: each NOTE below is one branch of a period outline (its sub-points indented), standing for the notes it cites. Merge them into one compact outline for the span they cover (6 to 14 top-level points, at most 3 sub-points each, every point under 400 characters), keeping dates, decisions, amounts, names and open threads.`;
    const sub = { entity: inp.entity, as_of: checked.as_of, scope, notes: notes.map(({ underlying: _u, allRefs: _r, ...x }) => x), work: [], page: { nodes: [] } };
    const subChecked = checkInput(sub);
    const packet = buildPacket(sub, subChecked, partBudget);
    built.calls++;
    const res = writeOutline(sub, subChecked, packet, callModel, partBudget, { entity_id: inp.entity.id, as_of: checked.as_of }, { meta: { purpose: 'page', hub_part: label, level, source_refs: [...new Set(notes.flatMap((x) => x.allRefs || x.refs || []))].sort() }, extra: { reasoning_effort: HUB.part_effort } });
    if (res.model?.usage) built.usage.push(res.model.usage);
    if (res.status !== 'ok') return { ok: false, res, label };
    built.parts++;
    parts?.set(key, { label, level, nodes: res.nodes, built_at: now, model: res.model?.model ?? null });
    return { ok: true, key, nodes: res.nodes };
  };
  const fail = (bad, total) => ({ ...result, status: bad.res.status === 'refused' ? 'refused' : 'failed', reason: bad.res.reason === 'budget' ? 'budget' : `hub part ${bad.label} not built: ${bad.res.reason}`, detail: bad.res.detail ?? null,
    hub: { ...built, parts_total: total }, model: bad.res.model });
  const groups = partition(checked.notes, HUB.part_chars, budget);
  let items = [];
  for (let i = 0; i < groups.length; i++) {
    const r = runPart(groups[i].label, groups[i].notes, i + 1, groups.length, 0);
    if (!r.ok) return fail(r, groups.length);
    for (const b of branchesOf(r.nodes, r.key, underlying, budget)) { underlying.set(b.id, b.underlying); items.push(b); }
  }
  const topBudget = { ...budget, max_note_chars: HUB.top_note_chars };
  const frame = buildPacket({ ...inp, notes: [], scope: 'x'.repeat(400) }, { ...checked, notes: [], later: [] }, topBudget);
  const room = budget.max_input_chars - cpLen(frame.text) - 2000;
  for (let level = 1; level < HUB.max_levels && cost(items, topBudget) > room; level++) {
    built.levels = level;
    const chunks = sizeSplit(items, `level ${level}`, HUB.part_chars, topBudget), next = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = runPart(chunks[i].label, chunks[i].notes, i + 1, chunks.length, level);
      if (!r.ok) return fail(r, groups.length);
      for (const b of branchesOf(r.nodes, r.key, underlying, budget)) { underlying.set(b.id, b.underlying); next.push(b); }
    }
    items = next;
  }
  const top = { entity: inp.entity, aliases: inp.entity.aliases, as_of: checked.as_of, work: inp.work, page: inp.page, coverage: inp.coverage,
    scope: `TOP OUTLINE of a hub page built from ${groups.length} period parts: each NOTE below is one branch of a part's outline (its sub-points indented), dated by its newest underlying note, standing for every note it cites. Write the whole page from them and the current work; citing a branch cites its notes.`,
    notes: items.map(({ underlying: _u, allRefs: _r, ...x }) => x) };
  const topChecked = checkInput(top), packet = buildPacket(top, topChecked, topBudget);
  built.calls++;
  const out = writeOutline(top, topChecked, packet, callModel, topBudget, result, { meta: { purpose: 'page', hub_part: 'top', source_refs: [...new Set(items.flatMap((x) => x.allRefs || []))].sort() } });
  if (out.model?.usage) built.usage.push(out.model.usage);
  if (!['ok', 'unchanged'].includes(out.status)) return { ...out, hub: { ...built, parts_total: groups.length } };
  const byId = new Map(checked.notes.map((n) => [n.id, n])), workById = new Map((inp.work || []).map((w) => [w.id, w]));
  const nodes = out.nodes.map((n) => {
    // Human points the model dropped come back with their own real notes; branch ids expand to theirs.
    const notes = [...new Set((n.notes || []).flatMap((id) => underlying.get(id) || [id]))];
    const refs = [...new Set([...notes.flatMap((id) => byId.get(id)?.refs || []), ...(n.work || []).flatMap((id) => workById.get(id)?.evidence || []), ...(n.author === 'human' && !notes.length ? n.refs || [] : [])])];
    return { ...n, notes, refs };
  });
  parts?.keep(used);
  const cited = new Set(nodes.flatMap((n) => n.notes));
  return { ...out, nodes, input_digest: result.input_digest,
    coverage: { route: 'hub', notes_total: checked.notes.length, notes_cited: cited.size, parts: groups.length, part_labels: groups.map((g) => g.label), levels: built.levels,
      branches_top: items.length, branches_omitted_for_budget: packet.omitted.length, work_total: (inp.work || []).length, work_cited: new Set(nodes.flatMap((n) => n.work || [])).size,
      notes_later_excluded: checked.later.map((n) => n.id), complete_input: !packet.omitted.length, withheld_upstream: inp.coverage?.withheld ?? null },
    hub: { ...built, parts_total: groups.length } };
}

/** A content-addressed cache of built parts, one JSON file per entity; `keep` prunes after a top.
 * Writes re-read the file and merge, so two processes never erase each other's parts, and `lease`
 * lets one process build an entity's hub at a time (the heartbeat defers to a manual `pages` run). */
export class PartsCache {
  constructor(file) { this.file = file; this.data = this.read(); }
  read() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; } }
  get(key) { return this.data[key] || this.read()[key] || null; }
  set(key, value) { this.data = { ...this.read(), ...this.data, [key]: value }; this.save(); this.lease(); }
  keep(keys) { const all = { ...this.read(), ...this.data }; this.data = Object.fromEntries(Object.entries(all).filter(([k]) => keys.has(k))); this.save(); }
  save() { mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(this.data)); renameSync(tmp, this.file); }
  /** Take or refresh the build lease; false when another live process holds a fresh one. */
  lease(minutes = 20) {
    const file = this.file.replace(/\.json$/u, '.lease');
    try {
      const held = JSON.parse(readFileSync(file, 'utf8'));
      let alive = false; try { process.kill(held.pid, 0); alive = true; } catch { alive = false; }
      if (held.pid !== process.pid && alive && Date.now() - Date.parse(held.at) < minutes * 60e3) return false;
    } catch { /* no lease */ }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return true;
  }
  release() { const file = this.file.replace(/\.json$/u, '.lease'); try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file); } catch { /* none */ } }
}

/** Provider-free route: one point per work item and note. */
export function stubPageModel(request) {
  const outline = [...request.user.matchAll(/^(W\d+) \[/gmu)].map((m, i) => ({ num: String(i + 1), text: `Work ${m[1]} as stated in the input.`, work: [m[1]] }));
  for (const m of request.user.matchAll(/^(N\d+) (\S+)/gmu)) outline.push({ num: String(outline.length + 1), text: `Note ${m[1]} (${m[2]}) as stated in the input.`, notes: [m[1]] });
  return { ok: true, text: pyDumpsOrdered({ outline }), model: 'stub' };
}
