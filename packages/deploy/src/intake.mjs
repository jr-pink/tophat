// The instance's intake: the upkeep job `intake` (@tophat-md/upkeep) run against the runner's own replica, with the
// sources, the model and the schedule the instance file names. One run polls every due source (@tophat-md/sources),
// ingests what they return into the instance's write scope, derives entities and notes from it with the intake model
// (@tophat-md/push), and syncs through the hub when the instance has one. Nothing here holds a credential value: the
// model key and source secrets are resolved from their references when a run starts and reach the push providers and
// the source adapters through an environment object, never argv, never a file this code writes.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentDir } from './start.mjs';
import { claimTranscripts } from './transcripts.mjs';
import { instanceEnv, pusherId, resolveRef } from './instance.mjs';

export const INTAKE_KEY_ENV = 'TOPHAT_INTAKE_MODEL_KEY';
export const INTAKE_WORKSPACE_ENV = 'TOPHAT_INTAKE_MODEL_WORKSPACE';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The intake model as a @tophat-md/push model config, and the credential and workspace references its key and header come from. */
function intakeModel(c) {
  const m = c.intake.model;
  const entry = typeof m === 'string' ? { provider: c.models[m].provider ?? (m === 'chat' ? 'anthropic' : 'openai'), ...c.models[m] } : { ...m };
  const credential = entry.credential ?? null, workspace = entry.workspace ?? null;
  for (const k of ['credential', 'workspace']) delete entry[k];
  return { model: { ...entry, ...(credential ? { apiKeyEnv: INTAKE_KEY_ENV } : {}), ...(workspace ? { workspaceEnv: INTAKE_WORKSPACE_ENV } : {}) }, credential, workspace };
}

/** A source's config with credential references turned into what the adapters read (lib/secrets.mjs): an absolute file. */
function sourceFor(src, c, secretEnv) {
  const config = {};
  for (const [k, v] of Object.entries(src.config || {})) {
    if (!isObj(v) || !(v.file || v.keyring || v.env)) { config[k] = v; continue; }
    if (v.file) config[k] = v.file;
    else if (v.keyring) config[k] = path.join(c.paths.secrets, v.keyring);
    else { config[k] = v.env; secretEnv[`LINKNOTES_SECRET_${v.env.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = process.env[v.env] ?? ''; }
  }
  return { ...src, config };
}

/**
 * The upkeep config for an instance's intake: { upkeep: { stateDir, jobs: { intake } }, intake, hub }, plus the credential
 * reference of the intake model (resolved by runIntake). Null when the instance file has no intake block.
 */
export function intakeConfig(c) {
  if (!c.intake) return null;
  const { model, credential, workspace } = intakeModel(c);
  const secretEnv = {};
  const intake = {
    id: pusherId(c),
    scopes: [c.scope.default ?? c.name],
    stateDir: path.join(c.paths.state, 'intake'),
    sources: c.sources.filter((s) => s.enabled !== false).map((s) => sourceFor(s, c, secretEnv)),
    model,
    ownerAddresses: c.owner.addresses,
    syncAfter: Boolean(c.hub),
    ...(c.intake.wake ? { wake: c.intake.wake === true ? {} : c.intake.wake } : {}),
    ...(c.intake.maxSteps ? { maxSteps: c.intake.maxSteps } : {}),
    ...(c.intake.batch !== undefined ? { batch: c.intake.batch } : {}),
    ...(c.intake.budget !== undefined ? { budget: c.intake.budget } : {}),
  };
  return { cfg: { upkeep: { stateDir: path.join(c.paths.state, 'upkeep'), jobs: { intake: { everySeconds: c.intake.everySeconds } } }, intake, hub: c.hub },
    credential, workspace, secretEnv };
}

/**
 * One upkeep pass over the instance's replica: the intake job when it is due (force: now, whatever the schedule).
 * deps: { now, push, pushDeps, env } for tests; the replica is the runner's (TOPHAT_RUNNER_DB, opened as the instance scope).
 */
export async function runIntake(c, { force = false, now = Date.now(), deps = {}, env = process.env } = {}) {
  const plan = intakeConfig(c);
  if (!plan) return { skipped: 'the instance file has no intake block' };
  const runner = componentDir('runner'), upkeep = componentDir('upkeep');
  if (!runner || !upkeep) throw new Error('intake needs the runner and upkeep packages installed');
  const { openStore } = await import(path.join(runner, 'store/memory.mjs'));
  const { runDue } = await import(path.join(upkeep, 'index.mjs'));
  const { chatScopeVerdict } = await import(path.join(runner, 'rev6/pull/chat-scope.mjs'));
  const ienv = instanceEnv(c);
  const store = openStore(ienv.TOPHAT_RUNNER_DB, ienv);
  const key = plan.credential ? resolveRef(plan.credential, { env, keyringDir: c.paths.secrets }) : null;
  if (plan.credential && !key) throw new Error('intake.model.credential does not resolve to a key');
  const workspace = plan.workspace ? resolveRef(plan.workspace, { env, keyringDir: c.paths.secrets }) : null;
  if (plan.workspace && !workspace) throw new Error('intake.model.workspace does not resolve to a workspace id');
  // Source secrets named by environment reference reach the adapters as LINKNOTES_SECRET_* for this process only.
  for (const [k, v] of Object.entries(plan.secretEnv)) if (v) process.env[k] = v;
  const pushDeps = { ...(deps.pushDeps || {}), env: { ...(deps.pushDeps?.env || env), ...(key ? { [INTAKE_KEY_ENV]: key } : {}), ...(workspace ? { [INTAKE_WORKSPACE_ENV]: workspace } : {}) } };
  // Chat transcripts the runner ingested are claimed for this intake's derive first (transcripts.mjs, behind the chat-scope gate).
  const transcripts = claimTranscripts(store, { pusher: plan.cfg.intake.id, env: ienv, scopeVerdict: chatScopeVerdict });
  const result = await runDue(store, plan.cfg, { now, only: force ? ['intake'] : null, deps: { ...deps, intakeDeps: pushDeps } });
  if (transcripts.claimed || transcripts.held.length) result.transcripts = { claimed: transcripts.claimed, held: transcripts.held.length };
  // Arrivals that need someone wake a chat after every pass, not only when the intake job is due: the wake keeps its own ledger.
  if (plan.cfg.intake.wake) {
    const push = componentDir('push');
    if (!push) throw new Error('intake.wake needs the push package installed');
    const { makeProvider } = await import(pathToFileURL(path.join(push, 'providers.mjs')).href);
    const { runWake } = await import('./wake.mjs');
    const token = resolveRef({ file: path.join(c.paths.secrets, 'webchat-service-token') });
    const w = await runWake({ store, pusher: plan.cfg.intake.id, stateDir: plan.cfg.intake.stateDir, webchatDb: ienv.WEBCHAT_DB, webchatUrl: ienv.TOPHAT_WEBCHAT_URL, token,
      provider: deps.wakeProvider ?? makeProvider(plan.cfg.intake.model, pushDeps), model: plan.cfg.intake.model, budget: plan.cfg.intake.budget, push, now: new Date(now).toISOString(),
      ...plan.cfg.intake.wake }, { fetch: deps.wakeFetch });
    if (w) result.wake = w;
  }
  return result;
}
