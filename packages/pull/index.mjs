// @tophat-md/pull: context assembly and a reference runner (the "pull" side: answer from memory).
//
// Interface for a runner (your agent harness implements this, or uses runOnce below):
//   contextFor(store, question, { retrieval?, maxPages?, maxHits? }) -> Promise<{ question, hits, pages, text }>
//     hits: fused retrieval hits (or the store's own search when no retrieval config); pages: derived pages of the entities
//     the hits name, each built from every note the viewer can read across their scopes; text: the packet a model reads.
//   runOnce(store, provider, question, opts) -> Promise<{ answer, context, usage }>
//     one model call over that packet (provider: any @tophat-md/push provider: { complete }).
// A full chat runner (loop, tools, wakes, UI wiring) is out of scope; see COMPONENTS.md.
const SYSTEM = `You answer questions from the user's memory. Use only the CONTEXT. Cite the codes ([H1], [P2]) of the items you rely on.
If the context does not settle the question, say what is missing instead of guessing.`;

export async function contextFor(store, question, { retrieval = null, maxPages = 5, maxHits = 20 } = {}) {
  let hits;
  if (retrieval) {
    const { ask } = await import('@tophat-md/retrieval');
    hits = (await ask(question, retrieval, { store, limit: maxHits })).hits;
  } else {
    const words = String(question).match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) || [];
    const seen = new Map();
    for (const w of words.slice(0, 8)) {
      let r; try { r = await store.search(w, { limit: maxHits }); } catch { continue; }
      for (const h of r.hits) { const k = `${h.kind}:${h.id}`; if (!seen.has(k)) seen.set(k, { id: k, corpus: 'linknotes', title: h.name || h.kind, text: (h.snippet || '').replace(/\s+/g, ' '), ref: { kind: h.kind, id: h.id } }); }
    }
    hits = [...seen.values()].slice(0, maxHits);
  }
  const entityIds = [...new Set(hits.filter((h) => h.ref?.kind === 'entity').map((h) => h.ref.id))].slice(0, maxPages);
  const pages = [];
  for (const id of entityIds) { try { const p = await store.page(id); pages.push({ entity_id: id, outline: p.outline }); } catch { /* not visible */ } }
  const text = ['CONTEXT', ...pages.map((p, i) => `[P${i + 1}] page of ${p.entity_id}\n${p.outline}`), ...hits.map((h, i) => `[H${i + 1}] ${h.corpus}/${h.title}: ${h.text}`)].join('\n\n');
  return { question, hits, pages, text };
}

export async function runOnce(store, provider, question, opts = {}) {
  const context = await contextFor(store, question, opts);
  const reply = await provider.complete({ system: SYSTEM, user: `${context.text}\n\nQUESTION\n${question}`, packet: { question, hits: context.hits, pages: context.pages, records: [], candidates: [] }, maxTokens: opts.maxTokens ?? 1500 });
  return { answer: reply.text, context, usage: reply.usage, model: reply.model };
}
