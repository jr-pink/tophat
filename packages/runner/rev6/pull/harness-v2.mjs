// Harness v2: changes to what the agent sees and how its tools answer, each argued from the tool-call audit in
// bench/README.md. All of it is OFF unless TOPHAT_REV6_HARNESS=v2; with the flag unset every caller takes the
// path it took before, byte for byte. Kept in one module so the replay benchmark (bench/replay-ab.mjs) runs the
// same code the runner would.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cut, cutEnd } from '../base/text.mjs';
import { localStamp } from '../base/clock.mjs';

/**
 * The pieces of the harness change, each switchable on its own so the benchmark can ablate them
 * (bench/README.md). TOPHAT_REV6_HARNESS is a comma list: "v2" means every v2 piece, a bare name adds one piece,
 * "-name" removes one ("v2,-shell"). Unknown words are ignored, so an unset or unknown value is the old harness.
 *   batch: the batching rule; prefetchrule: the check-the-prefetch rule; shell: plain-text shell results;
 *   clip: head+tail cuts with the whole output spilled to a file (and its rule); alias: bash/Read/... routed;
 *   early: the prefetch starts with the turn.
 */
export const V2_FEATURES = Object.freeze(['batch', 'prefetchrule', 'shell', 'clip', 'alias', 'early']);
// v3 candidates (each measured on the frozen conversation set before it is kept; bench/README.md):
//   batch2: a stronger batching rule in place of batch; descs: tool descriptions that say how to batch;
//   memstatus: the memory store's status in the Now block, so a turn need not open with memory_status.
//   fastsearch: source search reads the communication threads through the trigram sidecar
//     (retrieval/threads-index.mjs; same output) and the prefetch passes give Spotlight a shorter budget.
//   unify: one `search` tool in place of memory_search and source_search (memory, source corpora, webchat transcripts, public web;
//     unified-search.mjs), and one prefetch block in place of three. The old two stay callable but leave the tool list.
export const V3_FEATURES = Object.freeze(['batch2', 'descs', 'memstatus', 'fastsearch', 'unify']);

/** Search env for fastsearch: the sidecar when it exists (TOPHAT_REV6_THREADS_FTS, else <state>/retrieval/threads-fts.sqlite). */
export function fastSearchEnv(env = process.env, { prefetch = false } = {}) {
  if (!harnessFeatures(env).has('fastsearch')) return env;
  const sidecar = env.TOPHAT_REV6_THREADS_FTS || join(env.TOPHAT_STATE_DIR || join(env.HOME || '', '.local', 'state', 'tophat'), 'retrieval', 'threads-fts.sqlite');
  return { ...env, ASK_RG_ASCII_WB: '1', ...(existsSync(sidecar) ? { TOPHAT_REV6_THREADS_FTS: sidecar } : {}), ...(prefetch ? { ASK_SPOTLIGHT_MS: env.TOPHAT_REV6_PREFETCH_SPOTLIGHT_MS || '800' } : {}) };
}
const KNOWN = new Set([...V2_FEATURES, ...V3_FEATURES]);
export function harnessFeatures(env = process.env) {
  const out = new Set();
  for (const word of String(env.TOPHAT_REV6_HARNESS || '').split(/[\s,]+/u).filter(Boolean)) {
    if (word === 'v2') V2_FEATURES.forEach((f) => out.add(f));
    else if (word === 'v3') [...V2_FEATURES, ...V3_FEATURES].forEach((f) => out.add(f));
    else if (word.startsWith('-')) out.delete(word.slice(1));
    else if (KNOWN.has(word)) out.add(word);
  }
  return out;
}
export const harnessV2 = (env = process.env) => harnessFeatures(env).size > 0;

/**
 * How long the first request of an owner turn may wait for the prefetch passes (ms from the turn's start). Default 0:
 * measured on 30 real owner messages the memory pass takes 1.7 s at the median and source search 7.2 s (p90 28.8 s),
 * while the first request leaves 0.5 s into the turn, so a wait long enough to matter costs more first-token time
 * than the round trips it saves (bench/README.md). The early start is kept; the wait is a knob for when search is fast.
 */
export const prefetchWaitMs = (env = process.env) => { const v = Number(env.TOPHAT_REV6_PREFETCH_WAIT_MS); return Number.isFinite(v) && v >= 0 ? v : 0; };

/** Resolves when every promise settled or `ms` passed, whichever is first. */
export function settleWithin(promises, ms) {
  if (!promises.length || ms <= 0) return Promise.resolve(false);
  let timer;
  return Promise.race([Promise.allSettled(promises).then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), ms); })]).finally(() => clearTimeout(timer));
}

// Names the model reaches for that are not ours (audit: "bash" 15 calls, all "unknown tool"). Routed, not refused.
export const TOOL_ALIASES = Object.freeze({ bash: 'shell', Bash: 'shell', sh: 'shell', terminal: 'shell', Read: 'read_file', cat: 'read_file', Write: 'write_file', Grep: 'search_files', grep: 'search_files', LS: 'list_files', ls: 'list_files' });
export function aliasInput(alias, input = {}) {
  if (alias === 'cat' || alias === 'Read') return { ...input, path: input.path ?? input.file_path ?? input.file };
  if (alias === 'Write') return { ...input, path: input.path ?? input.file_path };
  if (['bash', 'Bash', 'sh', 'terminal'].includes(alias)) return { ...input, command: input.command ?? input.cmd ?? input.script };
  return input;
}

/**
 * A long result kept as head and tail (errors, test summaries and the last lines of a build are at the end), the
 * middle written to a file the model can page with sed -n instead of re-running the command.
 */
export function clipHeadTail(text, max, { spillDir = null, name = 'output' } = {}) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const tail = Math.floor(max * 0.3), head = max - tail;
  let where = '';
  if (spillDir) {
    try { mkdirSync(spillDir, { recursive: true, mode: 0o700 }); const p = join(spillDir, `${String(name).replace(/[^\w.-]/gu, '_').slice(0, 80)}.txt`); writeFileSync(p, s, { mode: 0o600 }); where = `; the whole output (${s.split('\n').length} lines) is saved at ${p}, page it with sed -n 'A,Bp'`; } catch { where = ''; }
  }
  const h = cut(s, head), t = cutEnd(s, tail);
  return `${h}\n[... ${s.length - h.length - t.length} characters omitted from the middle${where}]\n${t}`;
}

const TRAILING_SEARCH = /^(?:\S+\/)?(grep|rg|egrep|fgrep|diff|cmp|test|\[)\b/u;
/**
 * Shell results as plain text with the exit status as a last line, not JSON with escaped newlines (audit: 253 calls,
 * 295k characters wrapped that way, every newline costing a two-character escape). Exit 1 from a trailing
 * grep/rg/diff says what it usually means.
 */
export function shellText({ stdout = '', stderr = '', code = 0, killedAfter = null, interrupted = false, command = '' }, { max, spillDir = null, name, clipper = null } = {}) {
  let body = `${stdout}${stderr ? `${stdout && !stdout.endsWith('\n') ? '\n' : ''}[stderr]\n${stderr}` : ''}`;
  const last = String(command).split(/\||;|&&|\n/u).map((x) => x.trim()).filter(Boolean).pop() || '';
  const notes = [];
  if (interrupted) notes.push('[interrupted by the owner before the command finished]');
  else if (killedAfter) notes.push(`[killed after ${killedAfter}ms; use background=true for slow work]`);
  else if (code === 1 && TRAILING_SEARCH.test(last)) notes.push(`[exit 1 from the last command (${TRAILING_SEARCH.exec(last)[1]}): no match or a difference, not a failure of what ran before it]`);
  else if (code) notes.push(`[exit ${code}]`);
  const room = Math.max(max - 200, Math.floor(max * 0.8));
  body = clipper ? clipper(body, room) : clipHeadTail(body, room, { spillDir, name });
  return [body.trim() ? body.replace(/\n+$/u, '') : '(no output)', ...notes].join('\n');
}

/** Extra root rules: batch independent calls; the prefetched context is already in the first request. */
const RULE_FEATURE = ['batch', 'prefetchrule', 'clip'];
export const v2Rules = (features) => {
  const all = features === true, has = (f) => all || Boolean(features?.has?.(f));
  const rules = V2_RULES.filter((_, i) => has(RULE_FEATURE[i]) && !(i === 0 && !all && has('batch2')));
  if (!all && has('batch2')) rules.unshift(BATCH2_RULE);
  if (!all && has('memstatus')) rules.push(MEMSTATUS_RULE);
  if (!all && has('unify')) { const at = rules.indexOf(V2_RULES[1]); if (at >= 0) rules.splice(at, 1); rules.push(UNIFY_RULE); } // the three named blocks of the prefetchrule no longer exist
  return rules;
};
export const BATCH2_RULE = 'Round trips are what a turn costs: every message carrying tool calls waits a full model round trip (several seconds) before you see any result. Before each tool message, work out everything you will need next that does not depend on a result you have not seen yet, and send all of it in that one message: several files to read, a search together with reading the file you already know about, git status with git diff, memory_search with source_search, a test run with the file it tests. Three files read one per message cost three round trips; read in one message they cost one. Sequence calls only when one needs another\'s result.';
export const UNIFY_RULE = 'There is one search tool, `search`, over memory, source corpora, past chats with you (by date and title) and, for questions not about him, the public web. Call it once with his words (pass the owner message before this one as context when this one is a follow-up like "no, the new one"), read the ranked list, then open the one or two refs that matter; do not run several searches for the same thing. A hit is evidence, not an answer: when a derived note and a newer raw turn disagree, the newer raw turn wins and you say both dates. The "Search" context already in the history is that same search run for his message.';
export const MEMSTATUS_RULE = 'The Now block carries the memory store\'s status (last successful consolidation, intake and health) as last checked; call memory_status only when that line is missing or too old for the question.';

/** The Now-block line for the memory store, from a memory_status result (rev5 cli status JSON). */
export function memoryStatusLine(status, env = process.env, checkedAt = new Date().toISOString()) {
  if (!status || status.ok === false) return null;
  const at = (iso) => (iso ? `${iso} (${localStamp(iso, env)})` : 'unknown');
  const h = status.health || {}, b = status.backlog || {};
  return `Memory store status, checked ${at(checkedAt)}: last successful consolidation ${at(status.last_consolidation?.received_at || h.last_consolidation_at)}; last intake ${at(status.last_batch?.received_at)}; health ${h.status || 'unknown'}${h.why ? ` (${h.why})` : ''}; raw records pending ${b.raw_pending ?? 'unknown'}.`;
}

/** Tool descriptions that say how to batch (descs). Specs are copied, never mutated. */
const DESC_ADD = {
  shell: ' Several shell calls in one message run one after another with no model round trip between them; independent read-only commands can also share one call, separated by `; echo ---;`.',
  read_file: ' To read several files, put several read_file calls in one message: they run in parallel and cost one round trip.',
  search_files: ' Several searches in one message run in parallel.',
  source_search: ' Run it together with memory_search or a file read in the same message when both are needed.',
  memory_search: ' Several searches in one message run in parallel.',
};
export function describeTools(specs, features) {
  if (!features?.has?.('descs')) return specs;
  return specs.map((s) => (DESC_ADD[s.name] ? { ...s, description: `${s.description}${DESC_ADD[s.name]}` } : s));
}
export const V2_RULES = [
  'Tool calls that do not depend on each other go out together in one message: several reads, searches or commands issued at once run in parallel and cost one round trip, where issuing them one per message costs a full model round trip each (several seconds). Sequence calls only when one needs another\'s result.',
  'Retrieval, Source search and Keyword search context fetched for the owner\'s message lands a few seconds into the turn, usually after your first request: once it is in the history, check it before running another search, and search only for what it does not answer.',
  'Long tool output is kept as head and tail with the whole of it saved to a file named in the result; page that file with sed -n rather than re-running the command.',
];
