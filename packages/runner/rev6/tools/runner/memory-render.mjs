import { localStamp } from '../../base/clock.mjs';
import { cut } from '../../base/text.mjs';

const BLURB_CHARS = 400;
const INDENT = '    ';

const stampOf = (o, key, env) => (o && typeof o === 'object' ? o[`${key}_local`] || (typeof o[key] === 'string' ? localStamp(o[key], env) || o[key] : null) : null);
const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const terms = (query) => String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_'-]+/u).filter(Boolean);

const unmark = (text, words) => String(text ?? '').replace(/\[([\p{L}\p{N}_'-]+)\]/gu, (whole, word) =>
  (words.some((t) => t === word.toLowerCase() || (Math.min(t.length, word.length) >= 4 && (word.toLowerCase().startsWith(t) || t.startsWith(word.toLowerCase())))) ? word : whole));

function cap(text, max = BLURB_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = cut(s, max);
  const space = head.lastIndexOf(' ');
  const kept = space > max * 0.6 ? head.slice(0, space) : head;
  return `${kept} [... ${s.length - kept.length} more characters]`;
}

function rawLine(r, env, prefix = 'raw ') {
  const author = String(r.author || r.role || '').trim();
  const others = (Array.isArray(r.participants) ? r.participants : []).map(String).filter((p) => p && p !== author && !author.endsWith(`:${p}`));
  const parts = [`${prefix}${r.id}`, others.length ? `${author} to ${others.join(', ')}`.trim() : author, stampOf(r, 'occurred_at', env)];
  const gap = Math.abs(Date.parse(r.available_at || '') - Date.parse(r.occurred_at || ''));
  if (gap > 3600_000) parts.push(`available ${stampOf(r, 'available_at', env)}`);
  if (r.testimony && r.testimony !== 'primary') parts.push(String(r.testimony));
  const p = r.policy || {};
  if ((p.model ?? 'allow') !== 'allow' || (p.publish ?? 'none') !== 'none' || p.reason) parts.push(`policy ${p.model ?? 'allow'}/${p.publish ?? 'none'}${p.reason ? ` (${collapse(p.reason)})` : ''}`);
  if (r.account) parts.push(`account ${r.account}`);
  if (r.thread && !String(r.id ?? '').includes(String(r.thread))) parts.push(`thread ${r.thread}`);
  if (typeof r.text_chars === 'number') parts.push(r.text_chars >= 1000 ? `${(r.text_chars / 1000).toFixed(1)}k chars` : `${r.text_chars} chars`);
  if (r.withheld) parts.push(`withheld: ${collapse(r.withheld)}`);
  return parts.filter(Boolean).join(' | ');
}

function itemLine(kind, it, env) {
  const parts = [`${kind} ${it.id}`];
  if (kind === 'entity') parts.push(it.name, it.type, Array.isArray(it.aliases) && it.aliases.length ? `aka ${it.aliases.join(', ')}` : null);
  else parts.push(it.title, it.status, kind === 'note' ? it.author : null);
  if (typeof it.version === 'number') parts.push(`v${it.version}`);
  const updated = stampOf(it, 'updated_at', env);
  parts.push(updated ? `updated ${updated}` : stampOf(it, 'at', env) || stampOf(it, 'created_at', env));
  if (it.merged_into) parts.push(`merged into ${it.merged_into}`);
  return parts.filter(Boolean).map(String).join(' | ');
}

function blurb(hit, words, env) {
  const snippet = collapse(unmark(hit.snippet, words));
  if (hit.kind === 'raw') return `${rawLine(hit, env)}\n${INDENT}${cap(snippet)}`;
  if (hit.kind === 'page') return `page ${hit.id}${hit.page_revision ? ` | revision ${hit.page_revision}` : ''}${hit.dirty ? ' | dirty' : ''}\n${INDENT}${cap(snippet)}`;
  if (hit.kind === 'entity') {
    const line = itemLine('entity', hit, env);
    const known = collapse(`${hit.name || ''} ${hit.type || ''} ${(hit.aliases || []).join(' ')}`).toLowerCase();
    return known.includes(snippet.toLowerCase()) ? line : `${line}\n${INDENT}${cap(snippet)}`;
  }
  if (hit.kind === 'note' || hit.kind === 'work') return `${itemLine(hit.kind, hit, env)}\n${INDENT}${cap(collapse(hit.body) || snippet)}`;
  return `${hit.kind || 'item'} ${hit.id ?? ''}`.trim() + (snippet ? `\n${INDENT}${cap(snippet)}` : '');
}

export function renderMemorySearch(result, env = process.env) {
  if (!result || typeof result !== 'object' || result.ok === false || !Array.isArray(result.hits)) return null;
  if (result.hits.some((hit) => !hit || typeof hit !== 'object')) return null;
  const words = terms(result.query);
  const coverage = result.coverage && typeof result.coverage === 'object' ? result.coverage : {};
  const kinds = Array.isArray(coverage.kinds) ? coverage.kinds.map(String) : [];
  const asOf = stampOf(result, 'as_of', env);
  const head = [`memory search ${JSON.stringify(String(result.query ?? ''))}`, kinds.length === 1 ? `kind ${kinds[0]}` : null,
    result.hits.length ? `${result.hits.length} hits` : 'no hits', asOf ? `store as of ${asOf}` : null];
  const withheld = coverage.raw_withheld_by_policy_not_searched;
  const foot = [kinds.length ? `kinds ${kinds.join(', ')}` : null, typeof coverage.limit === 'number' ? `limit ${coverage.limit}` : null, typeof coverage.derived === 'number' ? `derived ${coverage.derived}` : null,
    withheld > 0 ? `${withheld} raw withheld by policy, not searched` : null].filter(Boolean);
  const body = result.hits.length ? result.hits.map((hit) => blurb(hit, words, env)).join('\n') : 'nothing in the store matched.';
  return [`[${head.filter(Boolean).join(' | ')}]`, body, foot.length ? `[${foot.join(' | ')}]` : null].filter(Boolean).join('\n\n');
}

function pageBlock(page, env) {
  const outline = page.outline && typeof page.outline === 'object' ? page.outline : null;
  const asOf = stampOf(page, 'as_of', env);
  const head = ['page', page.revision ? `revision ${page.revision}` : null, asOf ? `as of ${asOf}` : null,
    outline ? `${outline.shown ?? outline.total} of ${outline.total} points shown` : `${page.node_count ?? 0} points`, page.dirty ? 'dirty' : null];
  const lines = [head.filter(Boolean).join(' | '), outline?.text || '(no page yet)'];
  for (const node of Array.isArray(page.nodes) ? page.nodes : []) {
    const text = String(node.text ?? '');
    if (node.id && outline?.node_ids?.includes(node.id)) continue;
    lines.push(`${node.num ? `${node.num}. ` : ''}${text}${node.id ? ` [${node.id}]` : ''}`);
  }
  if (page.unknown_nodes?.length) lines.push(`unknown node ids: ${page.unknown_nodes.join(', ')}`);
  return lines.join('\n');
}

function readText(result, env = process.env) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok === false) return null;
  const kind = ['raw', 'work', 'note', 'entity'].find((k) => result[k] && typeof result[k] === 'object' && !Array.isArray(result[k]));
  const page = result.page && typeof result.page === 'object' ? result.page : null;
  if (!kind && !page) return null;
  const blocks = [];
  if (kind === 'raw') {
    blocks.push(rawLine(result.raw, env));
    if (typeof result.raw.text === 'string') blocks.push(result.raw.text);
    if (result.cited_by_notes?.length) blocks.push(`cited by notes: ${result.cited_by_notes.join(', ')}`);
  } else if (kind) {
    const record = result[kind];
    blocks.push(itemLine(kind, record, env));
    if (record.body) blocks.push(String(record.body));
    if (record.entities?.length) blocks.push(`entities: ${record.entities.join(', ')}`);
    if (record.batch_id) blocks.push(`written by batch ${record.batch_id}`);
  }
  if (page) blocks.push(pageBlock(page, env));
  for (const linked of ['notes', 'work']) {
    const list = Array.isArray(result[linked]) ? result[linked] : [];
    if (list.length) blocks.push([`${linked} (${list.length})`, ...list.map((it) => `${itemLine(linked === 'notes' ? 'note' : 'work', it, env)}${it.body ? `\n${it.body}` : ''}`)].join('\n\n'));
  }
  const sources = Array.isArray(result.sources) ? result.sources.filter((s) => s && typeof s === 'object') : [];
  if (sources.length) blocks.push([`sources (${sources.length})`, ...sources.map((s) => `${INDENT}${rawLine(s, env, '')}`)].join('\n'));
  const history = Array.isArray(result.history) ? result.history.filter((h) => h && typeof h === 'object') : [];
  if (history.length) blocks.push([`history (${history.length})`, ...history.map((h) => `${INDENT}${[`seq ${h.seq}`, h.op || 'changed', stampOf(h, 'at', env), h.batch_id ? `batch ${h.batch_id}` : null].filter(Boolean).join(' | ')}`)].join('\n'));
  return blocks.join('\n\n');
}

export const MEMORY_READ_MAX_CHARS = 30_000;
export function memoryReadBudget(value) {
  if (value === undefined || value === null) return MEMORY_READ_MAX_CHARS;
  if (!Number.isInteger(value) || value < 1024) throw new Error('memory_read budget must be an integer >= 1024 characters (room for coverage and continuation)');
  return Math.min(value, MEMORY_READ_MAX_CHARS);
}

export function renderMemoryRead(result, env = process.env, { budget } = {}) {
  const max = memoryReadBudget(budget);
  const full = readText(result, env);
  if (full === null) return null;
  const kind = ['raw', 'work', 'note', 'entity'].find(k => result[k] && typeof result[k] === 'object' && !Array.isArray(result[k]));
  const record = kind ? result[kind] : null;
  const page = result.page;
  const unrendered = [result.mentions?.length ? `mentions (${result.mentions.length} returned)` : null,
    record?.identities?.length ? `identities (${record.identities.length} returned)` : null,
    result.revisions?.length ? `raw revision metadata (${result.revisions.length} returned)` : null].filter(Boolean);
  const fieldNote = unrendered.length ? `[Not rendered: ${unrendered.join(', ')}. These fields have no continuation in this tool.]` : '';
  const complete = [full, fieldNote].filter(Boolean).join('\n\n');
  if (complete.length <= max) return complete;

  const groups = [];
  const add = (name, items) => { if (items.length) groups.push({ name, items }); };
  if (record) add(kind, [{ label: `${kind} ${record.id}`, text: readText({ [kind]: record }, env) }]);
  if (page) {
    const { nodes, ...outlinePage } = page;
    add('page', [...(nodes || []).map(n => ({ label: `node ${n.id}`, text: `${n.num ? `${n.num}. ` : ''}${n.text || ''} [${n.id}]` })),
      { label: `page ${result.entity?.id || '(requested page)'}`, text: pageBlock(outlinePage, env).replace('points shown', 'points returned by store') }]);
  }
  for (const [plural, singular] of [['work', 'work'], ['notes', 'note']]) {
    if (Array.isArray(result[plural])) add(plural, result[plural].map(it => ({ label: `${singular} ${it.id}`, text: readText({ [singular]: it }, env) })));
  }
  add('sources', (result.sources || []).map(s => ({ label: `raw ${s.id}`, text: rawLine(s, env) })));
  add('history', (result.history || []).map(h => ({ label: `history seq ${h.seq}`, text: `${h.op || 'changed'} | ${stampOf(h, 'at', env) || ''} | batch ${h.batch_id || ''}` })));
  const handles = [...new Set(groups.flatMap(g => g.items.map(i => i.label)).concat(
    (page?.outline?.omitted || []).map(n => `node ${n.id}`),
    (record?.source_refs || []).map(id => `raw ${id}`)))];
  const heading = [
    `[memory_read PARTIAL rendering; whole-response budget ${max} characters. Coverage counts rendered text blocks from this response, not complete records or store totals.]`,
    page ? `Store page: revision ${page.revision || 'none'}; ${page.dirty ? 'dirty' : 'clean'}; as of ${stampOf(page, 'as_of', env) || 'unknown'}; outline ${page.outline?.shown ?? 0}/${page.outline?.total ?? page.node_count ?? 0} points returned, NOT necessarily displayed below.` : null,
    page?.unknown_nodes?.length ? `Unknown requested nodes: ${page.unknown_nodes.join(', ')}` : null,
    fieldNote || null,
    'Continuation: memory_read kind note/work/raw with the IDs below; for page nodes use kind page, the same entity id and nodes:[node_id]. Increase budget up to 30000 or read a smaller branch. Leaf offsets and outline-point IDs absent from the store response have no continuation here. Partial leaf offset continuation is UNSUPPORTED; fetch the original through its cited source/locator with source tools. Repeating the same capped read does not fetch its missing tail.',
    'Returned/hidden-node handles (bodies may be omitted): ' + handles.join('; ')
  ].filter(Boolean).join('\n');
  if (heading.length + 600 > max) {
    const note = '[memory_read PARTIAL: no bodies shown; coverage/handle directory exceeds this budget. Request one known note/work/raw ID or page node, or increase budget up to 30000. Complete directory/leaf offset continuation is UNSUPPORTED by this tool.]';
    const lines = [note];
    for (const line of heading.split('\n').slice(1, -1)) if (lines.join('\n').length + line.length + 1 <= max) lines.push(line);
    for (const handle of handles) {
      if (lines.join('\n').length + handle.length + 1 > max) break;
      lines.push(handle);
    }
    return lines.join('\n');
  }
  let left = max - heading.length - 600;
  const rendered = [], counts = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let share = Math.floor(left / (groups.length - gi));
    let used = 0, whole = 0, partial = 0;
    const pieces = [];
    for (const item of group.items) {
      const text = `${item.label}\n${item.text}`;
      const room = share - used;
      if (text.length + 2 <= room) { pieces.push(text); used += text.length + 2; whole++; continue; }
      const marker = `\n[PARTIAL ${item.label}; tail not read; leaf offset continuation unsupported]`;
      if (room > item.label.length + marker.length + 80) {
        const excerpt = cut(text, room - marker.length - 2);
        pieces.push(excerpt + marker); used += excerpt.length + marker.length + 2; partial++;
      }
      break;
    }
    left -= used;
    counts.push(`${group.name}: ${whole} full, ${partial} partial, ${group.items.length - whole - partial} omitted of ${group.items.length} returned`);
    rendered.push(...pieces);
  }
  return [heading, `[Rendered coverage: ${counts.join('; ')}]`, ...rendered].join('\n\n');
}
