// Source search on its own thread. The query reads the corpora with synchronous sqlite calls and JS scans, and run on
// the runner's thread that froze the event loop: the model request for a new chat left up to nine seconds late and
// streaming stalled while a prefetch or a source_search tool call ran.
//
// Three roles. workerData.query set: one search, one message, as before. workerData.role 'corpus': a helper this
// worker starts, running single corpora (query.mjs runCorpus) for it. Otherwise a long-lived worker (prefetch.mjs's
// pool): each {id, query, options} message gets {id, partial} (when options.partialMs asks for one) and then {id, done}.
// Why long-lived: a fresh worker per query paid the module load, the config read and the parsed term and people
// tables every time; this thread keeps them (terms.mjs loadDf, corpora.mjs loadPeople cache by mtime).
// Why a helper: with the scans moved to ripgrep the search is bound by this thread's CPU, and decoding the document
// index's candidate rows (tens of MB a query) and ranking ten thousand chat or knowledge lines held back every other
// corpus; TOPHAT_REV6_SEARCH_REMOTE (DEFAULT_REMOTE below, "off" for none) names the corpora the helpers run.
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { shapeAnswer, sourceSearch } from '../retrieval/entries.mjs';
import { loadConfig } from '../retrieval/config.mjs';
import { loadPeople } from '../retrieval/corpora.mjs';
import { runCorpus } from '../retrieval/query.mjs';
import { loadDf } from '../retrieval/terms.mjs';

// people.json (5.5 MB, ~80 MB parsed) only where it is read: the coordinator (the who block's stale note) and the helper
// that runs who; every thread needs the term table for the query context
const warmTables = ({ people = true } = {}) => { try { const cfg = loadConfig({ env: process.env }); if (cfg) { loadDf(cfg.indexDir); if (people) loadPeople(cfg.indexDir); } } catch { /* the query loads them */ } };

// One helper thread per group; TOPHAT_REV6_SEARCH_REMOTE lists the groups, ';' between groups and ',' within one.
const DEFAULT_REMOTE = 'documents;claude.ai-chats,knowledge;who,email,contracts';
const helpers = new Map();
let helperSeq = 0;
function startHelper(group) {
  const w = new Worker(new URL(import.meta.url), { workerData: { role: 'corpus' } }), waiting = new Map(), h = { w, waiting };
  const fail = (why) => { if (helpers.get(group) === h) helpers.delete(group); for (const [, p] of waiting) p.reject(new Error(why)); waiting.clear(); };
  w.on('message', (m) => { const p = waiting.get(m?.id); if (!p) return; waiting.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'corpus helper failed')); });
  w.on('error', (e) => fail(`corpus helper failed: ${String(e?.message || e).slice(0, 200)}`));
  w.on('exit', (code) => fail(`corpus helper exited (${code})`));
  w.postMessage({ warm: true, people: group.split(',').includes('who') });
  helpers.set(group, h);
  return h;
}
const groupsOf = (env) => {
  const spec = String(env?.TOPHAT_REV6_SEARCH_REMOTE ?? process.env.TOPHAT_REV6_SEARCH_REMOTE ?? DEFAULT_REMOTE);
  return spec === 'off' ? [] : spec.split(';').map((g) => g.split(',').map((x) => x.trim()).filter(Boolean)).filter((g) => g.length);
};
function remoteFor(query, options) {
  const groups = groupsOf(options.env);
  if (!groups.length) return null;
  const groupOf = new Map(groups.flatMap((g) => g.map((label) => [label, g.join(',')])));
  // the options query() sees (entries.mjs sourceSearch splits `only`), so the helper builds the same context
  const { onPartial: _p, partialMs: _m, remote: _r, only, ...rest } = options;
  const plain = { ...rest, only: String(only || '').split(',').filter(Boolean) };
  return { labels: new Set(groupOf.keys()), run: (label) => new Promise((resolve, reject) => {
    let h;
    try { h = helpers.get(groupOf.get(label)) || startHelper(groupOf.get(label)); } catch (e) { return reject(e); }
    const id = ++helperSeq;
    h.waiting.set(id, { resolve, reject });
    h.w.postMessage({ id, query, options: plain, label });
  }) };
}

async function answer(query, options, onPartial, { remote = false } = {}) {
  try {
    const partial = onPartial && options.partialMs > 0 ? (p) => onPartial(shapeAnswer(p, options.structured)) : null;
    const rem = remote ? remoteFor(query, options) : null;
    return shapeAnswer(await sourceSearch(query, { ...options, ...(rem ? { remote: rem } : {}), ...(partial ? { onPartial: partial } : { partialMs: 0 }) }), options.structured);
  } catch (error) {
    return { ok: false, reason: 'failed', detail: String(error?.message || error).slice(0, 2000) };
  }
}

if (workerData?.query != null) parentPort.postMessage(await answer(workerData.query, workerData.options, null));
else if (workerData?.role === 'corpus') {
  parentPort.on('message', async ({ id, query, options, label, warm, people }) => {
    if (warm) return warmTables({ people });
    try { const r = await runCorpus(query, options, label); parentPort.postMessage({ id, ok: true, out: r.out, withheld: r.withheld, lateNotes: r.lateNotes }); } catch (e) {
      parentPort.postMessage({ id, ok: false, error: String(e?.stderr || e?.message || e).split('\n')[0].slice(0, 300) });
    }
  });
} else {
  parentPort.on('message', async ({ id, query, options, warm }) => {
    // warm: parse the term and people tables now, and start the helper, ahead of the first query (prefetch.mjs warmSearch)
    if (warm) { warmTables(); try { for (const g of groupsOf(process.env)) if (!helpers.has(g.join(','))) startHelper(g.join(',')); } catch { /* the first query starts them */ } return; }
    const out = await answer(query, options, (partial) => parentPort.postMessage({ id, partial }), { remote: true });
    parentPort.postMessage({ id, done: out });
  });
}
