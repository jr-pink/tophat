// @tophat-md/push: the push plane. One poll cycle =
//   1. sources: every due adapter polled (via @tophat-md/sources), its records ingested into the MemoryStore
//      under the push scopes and marked with this pusher's id; a cursor commits only after the ingest is durable;
//   2. derive: pending records -> model (configured provider, budget-capped) -> entities and notes applied into the push
//      scopes -> derived pages refreshed; repeated until nothing is pending or maxSteps;
//   3. sync: the store's sync() when a hub is configured (syncAfter: true).
// It talks to the store only through the MemoryStore interface, so it runs against any backend.
import { runSources } from '@tophat-md/sources/run';
import { deriveOnce } from './derive.mjs';
import { makeProvider } from './providers.mjs';

export { registerProvider, providerNames, makeProvider } from './providers.mjs';
export { deriveOnce, translate, candidatesFor, PROMPT, promptFor, appendixFor } from './derive.mjs';
export { MODEL_PRESETS, resolveModel } from './presets.mjs';
export { BudgetError, spentOn } from './budget.mjs';

/**
 * cfg: { id, scopes, stateDir, sources: [{ id, family, config, schedule? }], model, budget?, batch?, maxSteps?, syncAfter?, ownerAddresses? }
 * deps: { provider?, fetch?, now? }
 */
export async function pollOnce(store, cfg, deps = {}) {
  for (const k of ['id', 'stateDir']) if (!cfg?.[k]) throw new Error(`push config needs ${k}`);
  if (!Array.isArray(cfg.scopes) || !cfg.scopes.length) throw new Error('push config needs scopes: where ingested and derived rows go');
  const now = deps.now ?? new Date().toISOString();
  const report = { at: now, sources: null, derive: [], sync: null, errors: [] };
  report.sources = await runSources({ sources: cfg.sources || [], stateDir: cfg.stateDir, now, force: deps.force,
    ctx: { ownerAddresses: cfg.ownerAddresses, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
    deliver: (source, raw) => store.ingest(raw, { scopes: cfg.scopes, pusher: cfg.id }) });
  const provider = deps.provider ?? makeProvider(cfg.model, deps);
  for (let i = 0; i < (cfg.maxSteps ?? 10); i++) {
    try {
      const step = await deriveOnce(store, provider, cfg, { now });
      if (!step.records) break;
      report.derive.push(step);
    } catch (e) { report.errors.push({ stage: 'derive', code: e.code || e.constructor.name, message: String(e.message).slice(0, 200) }); break; }
  }
  if (cfg.syncAfter) { try { report.sync = await store.sync(); } catch (e) { report.errors.push({ stage: 'sync', code: e.code || e.constructor.name, message: String(e.message).slice(0, 200) }); } }
  return report;
}
