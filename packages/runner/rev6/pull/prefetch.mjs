// Retrieval for pull, in-process through rev6/retrieval: the source_search tool, and the three passes fetched
// beside a turn for the owner's message (memory store, his sentence, the words in it that name something).
import { Worker } from 'node:worker_threads';
import { localStamp } from '../base/clock.mjs';
import { cut } from '../base/text.mjs';
import { loadConfig } from '../retrieval/config.mjs';
import { shapeAnswer, sourceSearch } from '../retrieval/entries.mjs';
import { rare } from '../retrieval/terms.mjs';
import { freshnessLine, messagesConfigured } from '../tools/runner/messages.mjs';
import { contextBlock, memoryBlock } from './context.mjs';
import { fastSearchEnv } from './harness-v2.mjs';
import { startUnifiedSearch } from './unified-search.mjs';
import { linkPeople } from './link.mjs';

/** Source search is on where the webchat turns it on (TOPHAT_RUNNER_ASK_PATH), as for rev5; the query itself runs in-process. */
export const askConfigured = (env = process.env) => Boolean(env.TOPHAT_RUNNER_ASK_PATH);
let cached = null;
function config(env) {
  const key = `${env.TOPHAT_RETRIEVAL_CONFIG || ''}|${env.TOPHAT_CONFIG_DIR || ''}|${env.HOME || ''}`;
  if (cached?.key !== key) { let cfg = null; try { cfg = loadConfig({ env }); } catch { cfg = null; } cached = { key, cfg }; }
  return cached.cfg;
}
export const askRoot = (env = process.env) => env.TOPHAT_RUNNER_ASK_ROOT || config(env)?.knowledgeRoot || null;

const WORKER = new URL('./search-worker.mjs', import.meta.url);
/** The query on a worker thread, never on the runner's. Its synchronous reads block whichever thread runs them, and on the
 * runner's thread that delayed the model request and every streamed token. TOPHAT_REV6_SEARCH_INLINE=1 runs it in-process
 * (tests, and a host with no worker threads).
 *
 * Workers are pooled and kept warm (one search at a time each, up to TOPHAT_REV6_SEARCH_WORKERS, default 2, per distinct
 * env): a fresh worker per query paid module load, config and the parsed term/people tables on every search, and a
 * prefetch pays it on the turn's critical path. An idle worker is unref'd (it never holds the process open) and ends
 * after ten idle minutes; a search that outlives its own timeout by 15 s takes its worker down with it, so a wedged
 * thread cannot hold a slot. options.onPartial (not cloneable) stays here and is called with the worker's partial answer.
 */
const pools = new Map();
const IDLE_MS = 10 * 60_000;
function poolFor(workerEnv) {
  const key = JSON.stringify(Object.entries(workerEnv || {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  let pool = pools.get(key);
  if (!pool) { pool = { key, env: workerEnv, slots: [], queue: [], max: Math.max(1, Number(workerEnv?.TOPHAT_REV6_SEARCH_WORKERS) || 2) }; pools.set(key, pool); }
  return pool;
}
function spawnSlot(pool) {
  const slot = { worker: new Worker(WORKER, { env: { ...pool.env } }), job: null, idle: null, seq: 0 };
  const retire = (why) => {
    pool.slots = pool.slots.filter((s) => s !== slot);
    clearTimeout(slot.idle);
    const job = slot.job; slot.job = null;
    if (job) job.finish({ ok: false, reason: 'failed', detail: why });
    try { slot.worker.terminate(); } catch { /* already gone */ }
    drain(pool);
  };
  slot.retire = retire;
  slot.worker.on('message', (m) => {
    const job = slot.job;
    if (!job || m?.id !== job.id) return;
    if (m.partial) { try { job.onPartial?.(m.partial); } catch { /* the caller's problem */ } return; }
    slot.job = null; job.finish(m.done); release(pool, slot);
  });
  slot.worker.on('error', (error) => retire(`search worker failed: ${String(error?.message || error).slice(0, 500)}`));
  slot.worker.on('exit', (code) => retire(`search worker exited (${code}) without an answer`));
  slot.worker.unref();
  pool.slots.push(slot);
  return slot;
}
function release(pool, slot) {
  slot.worker.unref();
  clearTimeout(slot.idle);
  slot.idle = setTimeout(() => { if (!slot.job) slot.retire('idle'); }, IDLE_MS);
  slot.idle.unref?.();
  drain(pool);
}
function drain(pool) {
  while (pool.queue.length) {
    const slot = pool.slots.find((s) => !s.job) || (pool.slots.length < pool.max ? (() => { try { return spawnSlot(pool); } catch { return null; } })() : null);
    if (!slot) { if (!pool.slots.length) { const job = pool.queue.shift(); job.finish({ ok: false, reason: 'failed', detail: 'search worker did not start' }); continue; } return; }
    run(slot, pool.queue.shift());
  }
}
function run(slot, job) {
  clearTimeout(slot.idle);
  slot.job = job; slot.worker.ref();
  job.id = ++slot.seq;
  const hard = (Number(job.options.env?.TOPHAT_RUNNER_ASK_MS) || 45000) + 15000;
  job.timer = setTimeout(() => { if (slot.job === job) slot.retire(`search worker gave no answer in ${hard}ms`); }, hard);
  job.timer.unref?.();
  slot.worker.postMessage({ id: job.id, query: job.query, options: job.options });
}
function searchOffThread(query, options, env, onPartial = null) {
  return new Promise((done) => {
    const { cfg: _cfg, env: workerEnv, ...rest } = options;
    let settled = false;
    const job = { query, options: { ...rest, env: workerEnv }, onPartial, finish: (value) => { if (settled) return; settled = true; clearTimeout(job.timer); done(value); } };
    const pool = poolFor(workerEnv);
    pool.queue.push(job);
    try { drain(pool); } catch (error) { job.finish({ ok: false, reason: 'failed', detail: `search worker did not start: ${error.message}` }); }
  });
}
/** Start a warm search worker for this env ahead of the first search (the pull process calls it at start). */
export function warmSearch(env = process.env) {
  // the pre-search linker's name index and word list (about a second, once) load off the first turn's critical path
  if (env.TOPHAT_RUNNER_DB && env.TOPHAT_REV6_LINK !== '0') { const t = setTimeout(() => { try { linkPeople('warm', { dbPath: env.TOPHAT_RUNNER_DB, env }); } catch { /* the first turn builds it */ } }, 1500); t.unref?.(); }
  if (!askConfigured(env) || env.TOPHAT_REV6_SEARCH_INLINE === '1') return;
  const pool = poolFor(fastSearchEnv(env, { prefetch: true }));
  if (!pool.slots.length) { try { const slot = spawnSlot(pool); slot.worker.postMessage({ warm: true }); release(pool, slot); } catch { /* the first search spawns one */ } }
}

const WEBCHAT_WORKER = new URL('./webchat-worker.mjs', import.meta.url);
/** The unified search's webchat leg off the runner's thread (webchat-worker.mjs); rejects on failure, as the in-process read throws. */
export function webchatOffThread(asks) {
  return new Promise((done, fail) => {
    let settled = false, worker;
    const finish = (fn, value) => { if (settled) return; settled = true; try { worker?.terminate(); } catch { /* already gone */ } fn(value); };
    try { worker = new Worker(WEBCHAT_WORKER, { workerData: { asks } }); } catch (error) { return finish(fail, error); }
    worker.once('message', (m) => (m?.ok ? finish(done, m.answers) : finish(fail, new Error(m?.detail || 'webchat worker failed'))));
    worker.once('error', (error) => finish(fail, error));
    worker.once('exit', (code) => finish(fail, new Error(`webchat worker exited (${code}) without an answer`)));
  });
}

/**
 * threads: false drops the current-thread block (the unified leg reads it only for full: true). partialMs + onPartial: the
 * answer over the corpora finished by then, in the same shape plus `partial: true, pending: [labels]`, once, if any is
 * still running (query.mjs); the promise still resolves to the whole answer.
 */
export async function search(query, { only, full = false, env = process.env, maxChars, asOf = null, structured = false, threads = true, partialMs = 0, onPartial = null } = {}) {
  if (!askConfigured(env)) return { ok: false, reason: 'not_configured', detail: 'source search not configured (TOPHAT_RUNNER_ASK_PATH unset)' };
  const early = typeof onPartial === 'function' && partialMs > 0;
  const options = { only, full, env, ...(maxChars ? { maxChars } : {}), ...(asOf ? { asOf } : {}), ...(structured ? { structured: true } : {}), ...(threads === false ? { threads: false } : {}), ...(early ? { partialMs } : {}) };
  const rooted = (r) => (r.ok ? { ...r, root: askRoot(env) || r.root } : r);
  const partial = early ? (p) => onPartial(rooted(p)) : null;
  let r;
  if (env.TOPHAT_REV6_SEARCH_INLINE === '1') {
    r = shapeAnswer(await sourceSearch(query, { ...options, cfg: config(env), ...(partial ? { onPartial: (p) => partial(shapeAnswer(p, structured)) } : {}) }), structured);
  } else r = await searchOffThread(query, options, env, partial);
  return rooted(r);
}

export function resultText(result, env = process.env, now = new Date().toISOString()) {
  let fresh = '';
  if (messagesConfigured(env)) { try { fresh = `\n${freshnessLine(env, now)}`; } catch (error) { fresh = `\n[freshness check failed: ${String(error.message).slice(0, 120)}]`; } }
  return `[source root: ${result.root || 'unknown'}; relative paths under it]${fresh}\n${result.output}`;
}

export async function sourceSearchText(input, { env = process.env, now } = {}) {
  const found = await search(input.query, { only: input.only, full: input.full, env: fastSearchEnv(env) });
  return found.ok ? resultText(found, env, now) : { error: `source search ${found.reason}: ${found.detail}` };
}

/**
 * The three prefetch passes for an owner message, each a promise of a context block (or null) with its timing key.
 * `memory` is the memory-store search (rev5/cli.py); a failed pass says so rather than looking empty.
 */
export function prefetchPasses(text, saidAt, { env = process.env, now = () => new Date().toISOString(), memorySearch, storeInstalled = false, unified = null } = {}) {
  if (env.TOPHAT_RUNNER_NO_RETRIEVAL === '1') return [];
  // Harness unify: the three passes below are one search, the same one the `search` tool runs (unified-search.mjs), with the owner's
  // previous message as context so a follow-up ("no, the new one we made last week") still has a topic. One block, not three.
  // Staged (a third element): `ready` is when the fast legs (webchat, memory) are back, which is what the first request's
  // hold waits for; `take()`, called before each request, hands over whatever has settled as a partial Search block
  // (or the whole one when everything has), once; the promise then carries the rest as a "Search, continued" block, or
  // the whole block when nothing was taken. Earlier blocks are never rewritten, so the cached prefix holds.
  if (unified) {
    const head = `for the owner message at ${saidAt} (${localStamp(saidAt, env)}): `;
    const run = startUnifiedSearch({ query: cut(text, 2000), context: unified.context || '', scope: 'auto', limit: 10 }, { ...unified.deps, now: saidAt });
    let given = null; // null: nothing handed over yet; 'full'; or the partial snapshot that was
    const failed = (error) => `search failed (${String(error?.message || error).slice(0, 160)})`;
    const done = run.done.then((r) => {
      if (given === null) { given = 'full'; return contextBlock('Search', head + r.text); }
      if (given === 'full') return null;
      const more = run.rest(given);
      return more ? contextBlock('Search, continued', head + more) : null;
    }, (error) => {
      if (given === null) { given = 'full'; return contextBlock('Search', `${head}${failed(error)}; the corpora are unknown for this message.`); }
      return given === 'full' ? null : contextBlock('Search, continued', `${head}the rest of the ${failed(error)}; ${given.pending.join(' and ')} are unknown for this message.`);
    });
    const take = () => {
      if (given !== null) return null;
      const snap = run.snapshot();
      if (!snap) return null;
      given = snap.complete ? 'full' : snap;
      return contextBlock('Search', head + snap.text);
    };
    return [['unified_ms', done, { ready: run.fast, take, partial: () => given !== null && given !== 'full', summary: () => (given && given !== 'full' ? `${given.summary}; pending ${given.pending.join(',')}` : '') }]];
  }
  const head = `for the owner message at ${saidAt} (${localStamp(saidAt, env)}): `, chars = Number(env.TOPHAT_RUNNER_ASK_PREFETCH_CHARS) || 10_000;
  const passes = [];
  if (storeInstalled) passes.push(['retrieval_ms', memorySearch({ query: cut(text, 2000), limit: 8, as_of: saidAt }).then((found) => memoryBlock(found, saidAt, env))]);
  if (askConfigured(env)) {
    const fast = fastSearchEnv(env, { prefetch: true });
    passes.push(['source_search_ms', search(cut(text, 2000), { env: fast }).then((f) => contextBlock('Source search', f.ok ? head + resultText(f, env, now()).slice(0, chars)
      : `${head}source search ${f.reason} (${f.detail}); the raw corpora are unknown for this message.`))]);
    const words = rare(text);
    if (words.terms.length) {
      const lead = `for the owner message at ${saidAt} (${localStamp(saidAt, env)}), searched on the words that name something in it: ${words.query}\nThis is what we already have on those words. Read it before building anything new.\n`;
      passes.push(['keyword_search_ms', search(words.query, { env: fast }).then((f) => contextBlock('Keyword search', f.ok ? lead + resultText(f, env, now()).slice(0, chars) : `${lead}keyword search ${f.reason} (${f.detail}).`))]);
    }
  }
  return passes;
}
