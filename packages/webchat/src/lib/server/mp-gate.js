// The privacy gate for multiplayer mode.
//
// A room conversation is driven by the real runner, with the real tools and the real context hook,
// so everything the model side emits is assumed to be about the owner until a classifier says
// otherwise. Nothing reaches a room client unclassified: assistant text is released one sentence
// at a time and each span is judged before it is broadcast, never after.
//
// It fails closed. A classifier that errors, times out or answers something unparseable blocks the
// span, because the failure mode worth avoiding is a leak, not a redaction.

import { readSecret } from './auth.js';
import { owner, ownerPossessive } from '../../../../runner/owner.mjs';

const ENDPOINT = process.env.MP_GATE_ENDPOINT || 'https://api.anthropic.com/v1/messages';
export const GATE_MODEL = process.env.MP_GATE_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.MP_GATE_TIMEOUT_MS || 12_000);

export const GATE_SYSTEM = `You are the privacy gate on a public group chat. The assistant in that chat is ${ownerPossessive()} own assistant, running on his machine with access to his files, mail, messages and accounts. Strangers are in the room.

Decide whether the candidate text divulges anything personal or private about ${owner()} or anyone he knows: real names of family, friends, coworkers, counterparties or clients; home, work or shipping addresses; phone numbers, emails, handles; organisation internals, finances, revenue, banking, cards, orders, invoices, legal matters; health, sleep, workouts, relationships; calendar, location or travel; credentials, tokens, filesystem paths or machine names; the contents of his documents, notes, messages, email or code; what he is working on that is not already public.

Allowed: general knowledge, public facts, reasoning, arithmetic, code that is not his, public web content, the participants' own words quoted back to them, and the assistant's own refusals. The first name "${owner()}" alone, and the fact that this is his assistant, are allowed.

Answer with JSON only: {"verdict":"allow"} or {"verdict":"block","reason":"<five words or fewer>"}.`;

const cache = new Map();
const CACHE_MAX = 2_000;

/** Text with nothing in it to leak: short acknowledgements, punctuation, whitespace. */
export function trivial(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return trimmed.length < 12 && !/\d/u.test(trimmed);
}

export function parseVerdict(raw) {
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open < 0 || close <= open) throw new Error('no json in verdict');
  const parsed = JSON.parse(raw.slice(open, close + 1));
  if (parsed.verdict === 'allow') return { verdict: 'allow' };
  if (parsed.verdict === 'block') return { verdict: 'block', reason: String(parsed.reason || 'personal') };
  throw new Error(`unknown verdict ${parsed.verdict}`);
}

async function classify(text, fetchImpl) {
  const key = readSecret('anthropic-api-key', 'ANTHROPIC_API_KEY');
  const workspace = readSecret('anthropic-workspace-id', 'ANTHROPIC_WORKSPACE_ID');
  if (!key) throw new Error('no anthropic key');
  const headers = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  };
  if (workspace) headers['anthropic-workspace-id'] = workspace;
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: GATE_MODEL,
      max_tokens: 64,
      system: GATE_SYSTEM,
      messages: [{ role: 'user', content: `Candidate text:\n<<<${text}>>>` }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`gate ${res.status}`);
  const data = await res.json();
  return parseVerdict((data.content || []).map(block => block.text || '').join(''));
}

/**
 * Judge one span. Returns { verdict: 'allow' } or { verdict: 'block', reason }.
 * Identical spans are judged once; the cache is bounded because a long run produces many.
 */
export async function gate(text, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const trimmed = String(text ?? '').trim();
  if (trivial(trimmed)) return { verdict: 'allow' };
  const candidate = trimmed.slice(0, 4_000);
  if (cache.has(candidate)) return cache.get(candidate);
  const promise = classify(candidate, fetchImpl).catch((cause) => {
    // A failure blocks this span (fail closed) but is not remembered: the next ask judges it again.
    if (cache.get(candidate) === promise) cache.delete(candidate);
    return { verdict: 'block', reason: `gate unavailable (${String(cause.message).slice(0, 40)})` };
  });
  cache.set(candidate, promise);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return promise;
}

/** What the room sees in place of a blocked span. */
export const redaction = (reason) => `[redacted: ${reason}]`;

/** Gate a whole block of text at once: tool output, a tool's input, a settled message. */
export async function gatedText(text, options) {
  const verdict = await gate(text, options);
  return verdict.verdict === 'allow' ? String(text ?? '') : redaction(verdict.reason);
}

export function clearGateCache() { cache.clear(); }
