// One derivation step: the oldest pending raw records of this pusher -> a packet (records coded R1.., candidate entities
// coded E1.. found by searching the store) -> one model call through the configured provider (under the budget) ->
// changes translated back to store ids -> MemoryStore.apply into the push scopes, acknowledging the records -> the
// derived page of every entity touched is refreshed. Works against any MemoryStore backend.
import { readFileSync } from 'node:fs';
import { check, record } from './budget.mjs';

export const PROMPT = readFileSync(new URL('./prompts/derive.txt', import.meta.url), 'utf8');
const NAMES = /\b[A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+)*\b/gu;

/** Candidate entities for a set of records: search the store for the capitalized terms they contain. */
export async function candidatesFor(store, records, { perTerm = 3, max = 40 } = {}) {
  const terms = new Set();
  for (const r of records) for (const m of r.text.match(NAMES) || []) if (m.length > 2) terms.add(m);
  for (const r of records) if (r.author) terms.add(String(r.author));
  const out = new Map();
  for (const t of [...terms].slice(0, 60)) {
    let hits = [];
    try { hits = (await store.search(t, { kind: 'entity', limit: perTerm })).hits; } catch { continue; }
    for (const h of hits) if (!out.has(h.id) && out.size < max) out.set(h.id, { id: h.id, name: h.name, type: h.type });
  }
  return [...out.values()].map((c, i) => ({ ...c, code: `E${i + 1}` }));
}

export function packetText(packet, maxChars) {
  const rec = packet.records.map((r) => `${r.code} | ${r.time} | ${r.author || 'unknown'}${r.thread ? ` | thread ${r.thread}` : ''}\n${r.text.slice(0, maxChars)}`).join('\n\n');
  const cand = packet.candidates.map((c) => `${c.code} | ${c.name} (${c.type})`).join('\n') || '(none)';
  return `RECORDS\n${rec}\n\nCANDIDATE ENTITIES\n${cand}\n`;
}

/** Model JSON -> store changes. Codes the model invented are dropped, never guessed. */
export function translate(text, packet) {
  let j; try { j = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw Object.assign(new Error('the model answered with something that is not JSON'), { code: 'derive-bad-json' }); }
  const cand = new Map(packet.candidates.map((c) => [c.code, c.id])), raw = new Map(packet.records.map((r) => [r.code, r.id]));
  const refs = new Set();
  const entities = (Array.isArray(j.entities) ? j.entities : []).filter((e) => e && /^\$[\w-]+$/.test(e.ref || '') && typeof e.name === 'string' && e.name.trim())
    .map((e) => { refs.add(e.ref); return { id: e.ref, name: e.name.trim(), type: typeof e.type === 'string' ? e.type : 'topic', aliases: Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string') : [] }; });
  const notes = [];
  for (const n of Array.isArray(j.notes) ? j.notes : []) {
    if (!n || typeof n.body !== 'string' || !n.body.trim()) continue;
    const ents = (n.entities || []).map((x) => (cand.has(x) ? cand.get(x) : refs.has(x) ? x : null)).filter(Boolean);
    const src = (n.sources || []).map((x) => raw.get(x)).filter(Boolean);
    if (!ents.length) continue;
    notes.push({ body: n.body.trim(), entities: [...new Set(ents)], source_refs: src.length ? [...new Set(src)] : [...raw.values()] });
  }
  const used = new Set(notes.flatMap((n) => n.entities));
  return { entities: entities.filter((e) => used.has(e.id)), notes };
}

/**
 * One step. cfg: { id (pusher), scopes, batch?, maxRecordChars?, model: { provider, maxTokens?, price? }, budget?, stateDir }
 * Returns { records, notes, entities, pages, model, usd } or { records: 0 } when nothing is pending.
 */
export async function deriveOnce(store, provider, cfg, { now = new Date().toISOString() } = {}) {
  const pending = await store.pending({ pusher: cfg.id, limit: cfg.batch ?? 40 });
  if (!pending.length) return { records: 0 };
  const packet = { records: pending.map((r, i) => ({ ...r, code: `R${i + 1}` })), candidates: await candidatesFor(store, pending) };
  const user = packetText(packet, cfg.maxRecordChars ?? 4000), maxTokens = cfg.model?.maxTokens ?? 4000;
  check({ stateDir: cfg.stateDir, budget: cfg.budget, price: cfg.model?.price, now, inTok: Math.ceil((PROMPT.length + user.length) / 4), maxOut: maxTokens });
  const reply = await provider.complete({ system: PROMPT, user, packet, maxTokens });
  const usd = record({ stateDir: cfg.stateDir, now, provider: cfg.model?.provider, model: reply.model, usage: reply.usage, price: cfg.model?.price });
  const changes = translate(reply.text, packet);
  const ids = pending.map((r) => r.id);
  const res = await store.apply(changes, { scopes: cfg.scopes, sourceRefs: ids, ackRaw: ids, batchId: `push-${cfg.id}-${ids[0]}-${ids.length}` });
  const touched = [...new Set((res.notes || []).flatMap((n) => n.entities || []))];
  const pages = [];
  for (const e of touched) { try { const p = await store.page(e); pages.push({ entity_id: e, key: p.key, notes: p.note_ids.length }); } catch { /* not visible to this viewer */ } }
  return { records: ids.length, notes: (res.notes || []).length, entities: (res.entities || []).length, pages, model: reply.model, usd };
}
