// @tophat-md/upkeep: one scheduler, a handful of jobs, nothing else.
// Default jobs (intervals from config.upkeep.jobs.<name>.everySeconds; a job without an interval does not run):
//   intake       an instance's intake (config.intake, a push config built from the instance file by @tophat-md/deploy):
//                poll its sources, ingest into its replica, derive with its model, sync through its hub
//   heartbeat    one push cycle (sources -> derive -> sync), or sync alone when no push config
//   consolidate  refresh the derived pages of entities whose notes changed, then checkpoint the store (sqlite backend)
//   health       write <stateDir>/health.json: last run of every job, its error, pending raw records, today's model spend
//   log-rotate   rotate <stateDir>/upkeep.log past maxBytes, keep `keep` files
//   backup       a consistent SQLite backup of the store into backupDir, keep `keep` copies (sqlite backend)
//   retrieval    the one retrieval refresh (per-corpus intervals live in config.retrieval.corpora), when configured
// Optional, off by default (spends model budget): understanding, a command you configure ({ command: [..] }).
// State: <stateDir>/upkeep-state.json, one writer (this process), atomic temp+rename; no locks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';

const DEFAULTS = ['intake', 'heartbeat', 'consolidate', 'health', 'log-rotate', 'backup', 'retrieval'];
export const JOBS = {};
export function registerJob(name, fn) { JOBS[name] = fn; }

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(t, f); };
const log = (stateDir, line) => { fs.mkdirSync(stateDir, { recursive: true }); fs.appendFileSync(path.join(stateDir, 'upkeep.log'), `${new Date().toISOString()} ${line}\n`); };

registerJob('heartbeat', async ({ store, cfg, deps }) => {
  if (cfg.push) {
    const push = deps.push ?? (await import('@tophat-md/push'));
    const r = await push.pollOnce(store, { syncAfter: Boolean(cfg.hub), ...cfg.push }, deps.pushDeps ?? {});
    return { derived: r.derive.reduce((n, s) => n + s.records, 0), errors: r.errors.length + (r.sources?.errors?.length ?? 0) };
  }
  if (cfg.hub) return { sync: await store.sync() };
  return { skipped: 'no push config and no hub' };
});
registerJob('intake', async ({ store, cfg, deps }) => {
  if (!cfg.intake) return { skipped: 'no intake config' };
  // No sources is still a run: the chat transcripts the runner ingested are derived by the same pass (deploy/src/transcripts.mjs).
  const push = deps.push ?? (await import('@tophat-md/push'));
  const r = await push.pollOnce(store, cfg.intake, deps.intakeDeps ?? {});
  const delivered = Object.values(r.sources?.delivered || {});
  const errors = [...r.errors.map((e) => `${e.stage}: ${e.code}`), ...(r.sources?.errors || []).map((e) => `source ${e.source}: ${e.cause || 'unavailable'}`)];
  return { polled: r.sources?.polled ?? 0, stored: delivered.reduce((n, d) => n + (d?.stored?.length ?? 0), 0), derived: r.derive.reduce((n, s) => n + s.records, 0),
    notes: r.derive.reduce((n, s) => n + (s.notes ?? 0), 0), errors };
});
registerJob('consolidate', async ({ store }) => {
  if (!store.store) return { skipped: 'backend has no local replica' };
  const dirty = store.store.all('SELECT entity_id FROM pages WHERE dirty=1 LIMIT 500').map((r) => r.entity_id);
  let refreshed = 0;
  for (const id of dirty) { try { await store.page(id); refreshed++; } catch { /* not visible to this viewer */ } }
  store.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize');
  return { dirty: dirty.length, refreshed };
});
registerJob('health', async ({ store, cfg, stateDir, state }) => {
  const pusher = cfg.push ?? cfg.intake, pushDir = pusher?.stateDir;
  let spend = 0;
  if (pushDir) { try { const today = new Date().toISOString().slice(0, 10); for (const l of fs.readFileSync(path.join(pushDir, 'spend.jsonl'), 'utf8').split('\n')) if (l && JSON.parse(l).at.startsWith(today)) spend += JSON.parse(l).usd; } catch { /* none yet */ } }
  const pending = pusher ? (await store.pending({ pusher: pusher.id, limit: 1000 })).length : null;
  const sources = pushDir ? readJson(path.join(pushDir, 'sources-state.json'), { sources: {} }).sources : {};
  const report = { at: new Date().toISOString(), jobs: state.jobs, pending_raw: pending, spend_today_usd: spend,
    source_errors: Object.fromEntries(Object.entries(sources).filter(([, v]) => v.error).map(([k, v]) => [k, v.error])) };
  report.ok = !Object.values(state.jobs || {}).some((j) => j.error) && !Object.keys(report.source_errors).length;
  writeJson(path.join(stateDir, 'health.json'), report);
  return { ok: report.ok };
});
registerJob('log-rotate', async ({ stateDir, job }) => {
  const f = path.join(stateDir, 'upkeep.log'), max = job.maxBytes ?? 5 * 1024 * 1024, keep = job.keep ?? 3;
  let size = 0; try { size = fs.statSync(f).size; } catch { return { rotated: false }; }
  if (size < max) return { rotated: false, size };
  for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`); } catch { /* gap */ } }
  fs.renameSync(f, `${f}.1`);
  try { fs.rmSync(`${f}.${keep + 1}`); } catch { /* none */ }
  return { rotated: true, size };
});
registerJob('backup', async ({ store, job }) => {
  if (!store.store) return { skipped: 'backend has no local replica' };
  if (!job.dir) throw new Error('upkeep.jobs.backup.dir is required');
  fs.mkdirSync(job.dir, { recursive: true, mode: 0o700 });
  const dest = path.join(job.dir, `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  const src = new DatabaseSync(store.store.path, { readOnly: true });
  try { await sqliteBackup(src, dest); } finally { src.close(); }
  fs.chmodSync(dest, 0o600);
  const all = fs.readdirSync(job.dir).filter((n) => /^memory-.*\.sqlite$/.test(n)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - (job.keep ?? 7)))) fs.rmSync(path.join(job.dir, old));
  return { file: dest, kept: Math.min(all.length, job.keep ?? 7) };
});
registerJob('retrieval', async ({ store, cfg, deps }) => {
  if (!cfg.retrieval) return { skipped: 'no retrieval config' };
  const r = deps.retrieval ?? (await import('@tophat-md/retrieval'));
  return r.refresh(cfg.retrieval, { store });
});
registerJob('understanding', async ({ job }) => {
  if (!Array.isArray(job.command) || !job.command.length) throw new Error('upkeep.jobs.understanding.command must be [program, ...args]');
  return new Promise((resolve, reject) => { const p = spawn(job.command[0], job.command.slice(1), { stdio: 'inherit' }); p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve({ exit: 0 }) : reject(new Error(`exit ${c}`)))); });
});

/** Run every due job once. cfg: the linknotes config (with upkeep: { stateDir, jobs: { name: { everySeconds, ... } } }). */
export async function runDue(store, cfg, { now = Date.now(), deps = {}, only = null } = {}) {
  const up = cfg.upkeep || {};
  if (!up.stateDir) throw new Error('config.upkeep.stateDir is required');
  const stateFile = path.join(up.stateDir, 'upkeep-state.json');
  const state = readJson(stateFile, { jobs: {} });
  const ran = {};
  const names = [...DEFAULTS, ...Object.keys(up.jobs || {}).filter((n) => !DEFAULTS.includes(n))];
  for (const name of names) {
    const job = (up.jobs || {})[name];
    if (only ? !only.includes(name) : (!job?.everySeconds || job.enabled === false)) continue;
    const last = state.jobs[name]?.lastStart ? Date.parse(state.jobs[name].lastStart) : 0;
    if (!only && now - last < job.everySeconds * 1000) continue;
    const fn = JOBS[name];
    if (!fn) { ran[name] = { error: 'unknown job' }; continue; }
    const start = new Date(now).toISOString();
    try {
      const result = await fn({ store, cfg, deps, stateDir: up.stateDir, state, job: job || {} });
      state.jobs[name] = { lastStart: start, lastOk: new Date().toISOString(), error: null };
      ran[name] = result;
      log(up.stateDir, `${name} ok ${JSON.stringify(result).slice(0, 300)}`);
    } catch (e) {
      state.jobs[name] = { ...(state.jobs[name] || {}), lastStart: start, error: `${e.constructor.name}: ${String(e.message).slice(0, 200)}` };
      ran[name] = { error: state.jobs[name].error };
      log(up.stateDir, `${name} failed ${state.jobs[name].error}`);
    }
    writeJson(stateFile, state);
  }
  return ran;
}
