// The tool surface: specs declared in tools.json and validated here, one dispatch, and the core handlers
// (shared tasks, memory, files, shell, background jobs, goals, subagents). Mail, messages, documents, web,
// browser and computer use keep their handlers in rev5 until the tools piece ports them; they plug in below.
// Safety mechanics live here: every result is scrubbed of known secrets, the shell gets no credential env,
// plan mode refuses mutating tools.
import { runForeground, killGroup } from './shell-group.mjs';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageRef, publicPrompt, viewableImage } from './context.mjs';
import { localStamp, withLocalTimes } from '../base/clock.mjs';
import { clip, cut } from '../base/text.mjs';
import { memoryDb } from '../base/paths.mjs';
import { sharedSecretIndex } from '../base/redact.mjs';
import { renderMemoryRead, renderMemorySearch, memoryReadBudget } from '../tools/runner/memory-render.mjs';
import { messagesConfigured, messagesToolSpec, messagesText, recentMessages } from '../tools/runner/messages.mjs';
import { attachmentsConfigured, readDocument, readDocumentToolSpec } from '../tools/runner/attachments.mjs';
import { createMailTools, mailConfigured, mailToolSpecs } from '../tools/runner/mail.mjs';
import { createWebTools, searchWeb, webConfig, webConfigured, webToolSpecs } from '../tools/runner/web.mjs';
import { SEARCH_TOOL, unifiedSearch } from './unified-search.mjs';
import { CHATS_TOOL, chatsTool } from '../../rev5/chats-tool.mjs';
import { linkPeople } from './link.mjs';
import { readerFailure, warmMemory, warmMemoryCall } from './memory-worker.mjs';
import { LIST_DOC, LIST_PROPS, listCall } from '../base/memory-list.mjs';
import { GROUPS_DOC, confineToScope, groupedApplyCall, scopedWriteError, wantsGroups } from '../base/memory-groups.mjs';
import { runnerChatVerdict } from './chat-scope.mjs';
import { scrubForStore } from '../../src/vault/scrub-store.mjs';
import { createCua } from '../tools/runner/cua.mjs';
import { createTabWatcher } from '../tools/runner/cua.mjs';
import { checkDrop, goalHandlers, taskRequest } from './goals.mjs';
import { ensureTables } from './ledger.mjs';
import { askRoot, askConfigured, search as sourceSearchStructured, sourceSearchText, webchatOffThread } from './prefetch.mjs';
import { INCOGNITO_TOOLS_OFF, incognitoMemoryRefusal, isIncognito } from './incognito.mjs';
import { TOOL_ALIASES, aliasInput, clipHeadTail, describeTools, fastSearchEnv, harnessFeatures, shellText } from './harness-v2.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const RESULT_CHARS = 30_000;
const FILE_BYTES = 200_000, SHELL_MS = 120_000, JOB_OUTPUT_CHARS = 200_000, MEMORY_MS = 60_000;
// The serving process's own listen settings: the webchat's PORT reached every tool shell, so a dev server or a test
// harness the model started tried to bind the webchat's port. Tools pick their own.
const SERVER_ENV = /^PORT$/;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|_FILE$|^SSH_AUTH_SOCK$|^SSH_AGENT_PID$/i;

// ---- specs as data.
const DATA = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
// memory_apply's groups field: its text lives once, in memory-groups.mjs, shared with rev5/tools.mjs.
DATA.core.memory_apply.properties.groups = { type: 'array', items: { type: 'string' }, description: GROUPS_DOC };
// memory_list sits right after memory_read; its text and properties live once, in memory-list.mjs, shared with rev5/tools.mjs.
DATA.core = Object.fromEntries(Object.entries(DATA.core).flatMap(([k, v]) => (k === 'memory_read' ? [[k, v], ['memory_list', { description: LIST_DOC, properties: LIST_PROPS }]] : [[k, v]])));
const prop = (p) => (typeof p !== 'string' ? p : { type: { s: 'string', i: 'integer', b: 'boolean' }[p[0]], description: p.slice(2) });
const expand = (group, edit = (d) => d) => Object.entries(group).map(([name, t]) => ({ name, description: edit(t.description, name),
  input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(t.properties).map(([k, v]) => [k, prop(typeof v === 'string' ? edit(v, name, k) : v)])), required: t.required || [], additionalProperties: false } }));
export const coreSpecs = () => expand(DATA.core);
export const goalSpecs = () => expand(DATA.goals);
export const agentSpecs = () => expand(DATA.agents);
export const chatSpecs = () => expand(DATA.chat);
export const sourceSearchSpec = () => expand({ source_search: DATA.source_search })[0];
export const browserBackend = (env = process.env) => env.TOPHAT_RUNNER_BROWSER_BACKEND || 'cdp';
export const browserConfigured = (env = process.env) => Boolean(env.TOPHAT_RUNNER_BROWSER_CDP) || env.TOPHAT_RUNNER_BROWSER_BACKEND === 'chrome-devtools-mcp';
export function browserSpecs(env = process.env) {
  if (browserBackend(env) !== 'chrome-devtools-mcp') return expand(DATA.browser);
  return expand(DATA.browser, (d, name, key) => (key && d.startsWith('s:CSS selector of ') ? `s:element UID of ${d.slice(18)}, exactly as printed in the browser_read snapshot (e.g. 1_2)`
    : !key && name === 'browser_read' ? 'Read a leased tab as an accessibility snapshot: each element carries a uid= you pass to click, type and fill (capped; element values and filled credentials are redacted).' : d));
}

/** The one validation of a spec list: unique API-legal names, object schemas, required keys declared. Returns problems. */
export function validateSpecs(specs) {
  const problems = [], seen = new Set();
  for (const s of specs) {
    const where = s?.name || '(unnamed)';
    if (typeof s?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.name)) problems.push(`${where}: name must match ^[a-zA-Z0-9_-]{1,64}$`);
    if (seen.has(s?.name)) problems.push(`${where}: duplicate name`);
    seen.add(s?.name);
    if (typeof s?.description !== 'string' || !s.description.trim()) problems.push(`${where}: no description`);
    const sc = s?.input_schema;
    if (!sc || sc.type !== 'object' || typeof sc.properties !== 'object' || Array.isArray(sc.properties)) { problems.push(`${where}: input_schema must be an object schema with properties`); continue; }
    for (const r of sc.required || []) if (!(r in sc.properties)) problems.push(`${where}: required "${r}" is not a property`);
    for (const [k, v] of Object.entries(sc.properties)) if (!v || typeof v !== 'object' || (!v.type && !v.enum && !v.anyOf)) problems.push(`${where}.${k}: property has no type`);
  }
  return problems;
}

// The store lists raw hits before derived ones and cuts the whole list at
// `limit`, so an unkinded memory_search on a common word came back as raw rows
// only, never a note, entity or work item. The store's `derived` allowance
// lists up to `limit` raw hits unchanged plus up to this many derived ones. A
// kinded search is already one kind and gets none (the store ignores it there
// too).
export const memoryDerivedAllowance = (input = {}) => (input.kind ? undefined : Math.max(5, Math.ceil(Number(input.limit ?? 10) / 2)));

export const PARALLEL = new Set(['task_list', 'memory_status', 'memory_search', 'memory_read', 'memory_list', 'read_file', 'read_document', 'list_files', 'search_files', 'source_search', 'web_search', 'web_open', 'web_find', 'job_status', 'job_wait', 'Agent', 'agent_wait', 'agent_list']);
/** Tools rev6 added; PARALLEL stays byte-equal to rev5's (fuzz.test.mjs). */
export const PARALLEL_EXTRA = new Set(['search', 'chats']);
export const MUTATING = new Set(['task_update', 'memory_apply', 'write_file', 'shell', 'mail_send', 'browser_acquire', 'browser_navigate', 'browser_click', 'browser_type', 'browser_release', 'credential_fill_login', 'credential_fill_totp']);

// ---- environment and filesystem boundary.
export function toolPath(env = process.env) {
  const want = [join(env.HOME || homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const have = String(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean), seen = new Set(have);
  return [...want.filter((d) => !seen.has(d) && existsSync(d)), ...have].join(':');
}
export function scrubbedEnv(env = process.env) {
  const keep = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && !SERVER_ENV.test(k)) keep[k] = v;
  return { ...keep, HOME: env.HOME || homedir(), PATH: toolPath(env), LANG: env.LANG || 'en_US.UTF-8' };
}
const TRUSTED = ['TOPHAT_RUNNER_API_KEY_FILE', 'TOPHAT_RUNNER_OPENAI_API_KEY_FILE', 'TOPHAT_RUNNER_CHATGPT_AUTH_FILE', 'TOPHAT_RUNNER_WORKSPACE_ID_FILE', 'TOPHAT_RUNNER_MODEL', 'TOPHAT_RUNNER_MAX_TOKENS',
  'TOPHAT_RUNNER_API_BASE', 'TOPHAT_RUNNER_TIMEOUT_MS', 'TOPHAT_RUNNER_RETRIES', 'TOPHAT_RUNNER_DB', 'TOPHAT_RUNNER_TRACE_DIR',
  // the replica's hub token and device key are file paths the store opens for sync, never values
  'TOPHAT_HUB_TOKEN_FILE', 'TOPHAT_DEVICE_KEY_FILE'];
/** The memory CLI's env: scrubbed, plus the key-file handles push needs to call the model. */
export function trustedEnv(env = process.env) {
  const out = scrubbedEnv(env);
  for (const n of TRUSTED) if (env[n] !== undefined) out[n] = env[n];
  return { ...out, TOPHAT_RUNNER_NODE: process.execPath };
}
export const rootAgentId = (conversationId) => `root_${createHash('sha256').update(String(conversationId ?? '')).digest('hex').slice(0, 8)}`;
export const agentEnv = (agentId, env = process.env) => ({ ...env, TOPHAT_AGENT_ID: agentId });

function canonical(abs) {
  let probe = abs;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  return join(realpathSync(probe), relative(probe, abs));
}
export function createRoots(roots) {
  const list = roots.filter(Boolean).map((r) => canonical(resolve(r)));
  return { list, check(path, cwd) {
    const resolved = canonical(isAbsolute(path) ? path : resolve(cwd, path));
    if (!list.some((root) => resolved === root || resolved.startsWith(`${root}/`))) throw new Error(`refused: ${path} is outside the allowed roots`);
    return resolved;
  } };
}
export function createFilesystem({ cwd, roots = [], env = process.env }) {
  if (env.TOPHAT_RUNNER_CONFINE === '1') return { ...createRoots([cwd, ...roots]), confined: true };
  return { list: ['/'], confined: false, check: (path, at) => canonical(isAbsolute(path) ? path : resolve(at || cwd, path)) };
}

// ---- the memory store (rev5/cli.py).
// In the public prompt mode a tool result never shows the home directory (an error trace names its files): it reads as `~`.
export function withoutHome(result, home) {
  if (!home || home === '/') return result;
  const swap = (text) => (typeof text === 'string' ? text.split(home).join('~') : text);
  if (typeof result?.content === 'string') return { ...result, content: swap(result.content) };
  if (Array.isArray(result?.content)) return { ...result, content: result.content.map((b) => (b?.type === 'text' ? { ...b, text: swap(b.text) } : b)) };
  return result;
}
export function memoryStore(env = process.env) {
  return { db: resolve(memoryDb(env)), installed: true, python: process.execPath, cli: join(REPO, 'store', 'cli.mjs'), cwd: REPO };
}
// search and read go to a warm reader (memory-worker.mjs, rev5/cli.py serve) unless TOPHAT_RUNNER_MEMORY_WORKER=0 or the
// caller asks for the one-shot process (spawn: true); anything else, and any reader that cannot take it, spawns the CLI.
const WARM_COMMANDS = new Set(['search', 'read']);
const warmWanted = (command, env, oneShot) => !oneShot && WARM_COMMANDS.has(command) && env.TOPHAT_RUNNER_MEMORY_WORKER !== '0';
export function warmMemoryStore(env = process.env) {
  const store = memoryStore(env);
  if (store.installed && warmWanted('search', env, false)) warmMemory({ store, env: trustedEnv(env) });
  const ents = entityStore(env);
  if (ents.installed && !readerFailure(ents)) warmMemory({ store: ents, env: trustedEnv(env) });
}
// The entity lookup reader (rev5/entity_lookup.py via `rev5.cli serve --entities`): the same store, read-only, in the
// rev5/entity_deps venv the heartbeat's entity step keeps beside the store (<stateDir>/rev5/entity-venv), since it needs
// spaCy. Pure code, no model call. TOPHAT_REV6_ENTITIES=0 turns the leg off.
export function entityStore(env = process.env) {
  const base = memoryStore(env);
  const python = env.TOPHAT_RUNNER_ENTITY_PYTHON || join(dirname(base.db), 'entity-venv', 'bin', 'python');
  return { ...base, python, args: ['--entities'], announcesReady: true,
    installed: false, // the entity reader is a separate natural-language service, not part of this package
    notReady: (w) => ({ ok: false, reason: w?.failed ? 'failed' : 'warming', detail: w?.readyError ? `entity reader could not start: ${String(w.readyError).slice(0, 200)}` : 'entity reader still loading spaCy and the entity index' }) };
}
export const ENTITY_MS = 150;
export function entityLookup(payload, { env = process.env, timeoutMs = Number(env.TOPHAT_REV6_ENTITY_MS) || ENTITY_MS } = {}) {
  const store = entityStore(env);
  if (!store.installed) return Promise.resolve({ ok: false, reason: 'not_installed', detail: 'entity reader needs <stateDir>/rev5/entity-venv and rev5/entity_lookup.py' });
  if (incognitoMemoryRefusal('search', payload, env)) return Promise.resolve({ ok: false, reason: 'refused', detail: 'incognito' });
  return warmMemoryCall({ store, env: trustedEnv(env), command: 'entities', payload, timeoutMs, keepOnTimeout: true,
    fallback: () => ({ ok: false, reason: 'busy', detail: 'both entity readers busy' }) });
}
export function memoryCli(command, payload, { env = process.env, timeoutMs = command === 'push' ? Number(env.TOPHAT_RUNNER_PUSH_TIMEOUT_MS) || 0 : MEMORY_MS, readOnly = false, spawn: oneShot = false } = {}) {
  const store = memoryStore(env);
  const refused = incognitoMemoryRefusal(command, payload, env);
  if (refused) return Promise.resolve(refused);
  if (isIncognito(env)) readOnly = true;
  if (!store.installed) return Promise.resolve({ ok: false, reason: 'not_installed', detail: 'no memory store on this machine' });
  // memory_apply bodies and pushed transcript slices are model-written: exact vault values out first.
  payload = scrubForStore(payload ?? {}, { env, label: 'memory' }).value;
  // A batch that names groups is written by the Node store through the memory cloud (rev6/base/memory-groups.mjs).
  const grouped = command === 'apply' && wantsGroups(payload);
  const listed = command === 'list';
  if (grouped && readOnly) return Promise.resolve({ ok: false, reason: 'refused', detail: 'read-only memory: a grouped apply writes' });
  if (warmWanted(command, env, oneShot)) {
    return warmMemoryCall({ store, env: trustedEnv(env), command, payload, timeoutMs, fallback: () => memoryCli(command, payload, { env, timeoutMs, readOnly, spawn: true }) });
  }
  return new Promise((done) => {
    const [bin, argv, request] = listed ? listCall(store, payload, trustedEnv(env)) : grouped ? groupedApplyCall(store, payload, trustedEnv(env)) : [store.python, [store.cli, '--db', store.db, ...(readOnly ? ['--read-only'] : []), command], payload];
    const child = execFile(bin, argv, { cwd: store.cwd, env: trustedEnv(env), timeout: grouped ? Math.max(timeoutMs, GROUPED_MS) : timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
      if (parsed && typeof parsed === 'object') return done({ ...parsed, ok: parsed.ok !== false && !(error && error.code !== 2) });
      if (error) return done({ ok: false, reason: error.killed ? 'timeout' : 'failed', detail: clip(stderr || error.message, 2000) });
      done({ ok: false, reason: 'failed', detail: 'the store printed no JSON' });
    });
    child.stdin.end(JSON.stringify(request ?? {}));
  });
}
// a grouped apply also runs one hub sync round (memory-cloud.json syncTimeoutMs, 20 s) after the write
const GROUPED_MS = 60_000;
export function receiptComplete(records, receipt) {
  if (!receipt || receipt.ok === false) return { complete: false, reason: receipt?.reason || receipt?.error || 'ingest refused', rejected: receipt?.rejected || [] };
  const accounted = (receipt.stored?.length || 0) + (receipt.duplicates?.length || 0);
  if (receipt.rejected?.length || accounted !== records.length) return { complete: false, reason: `ingest accounted for ${accounted} of ${records.length} records`, rejected: receipt.rejected || [] };
  return { complete: true, reason: null, rejected: [] };
}

// ---- background jobs: shell commands started with background=true, and tool calls moved off the turn.
export function createJobs(db, { sessionId, cwd, env = process.env, now = () => new Date().toISOString(), redact = (t) => t }) {
  ensureTables(db);
  const live = new Map(), get = db.prepare('SELECT * FROM jobs WHERE id = ? AND session_id = ?');
  const finish = db.prepare('UPDATE jobs SET status = ?, exit_code = ?, output = ?, ended_at = ? WHERE id = ?');
  const insert = (id, tool, input, pid) => db.prepare('INSERT INTO jobs (id, session_id, tool, input, status, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, tool, JSON.stringify(input), 'running', pid, now());
  for (const row of db.prepare("SELECT id, pid FROM jobs WHERE session_id = ? AND status = 'running'").all(sessionId)) {
    let alive = false;
    try { process.kill(row.pid, 0); alive = true; } catch { /* gone */ }
    finish.run('uncertain', null, `[runner restarted mid-job; pid ${row.pid} ${alive ? 'alive, unobserved' : 'gone'}; outcome is unknown]`, now(), row.id);
  }
  const describe = (r) => ({ job_id: r.id, tool: r.tool, status: r.status, exit_code: r.exit_code, started_at: r.started_at, ended_at: r.ended_at,
    output_tail: r.output.length > 4000 ? `[... ${r.output.length - 4000} earlier characters]\n${r.output.slice(-4000)}` : r.output });
  const newId = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const settle = (id, entry, status, code, output) => { finish.run(status, code, redact(output), now(), id); entry.done = true; live.delete(id); for (const w of entry.waiters) w(); };
  return {
    start(tool, input, command, at = cwd) {
      const id = newId(), child = spawn('/bin/bash', ['-c', command], { cwd: at, env: scrubbedEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      insert(id, tool, input, child.pid ?? null);
      let output = '';
      const take = (chunk) => { output = `${output}${chunk}`.slice(-JOB_OUTPUT_CHARS); };
      child.stdout.on('data', take); child.stderr.on('data', take);
      const entry = { child, waiters: [], done: false };
      live.set(id, entry);
      child.on('error', (error) => take(`\n[spawn error: ${error.code || error.message}]`));
      child.on('close', (code, signal) => settle(id, entry, entry.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed', code, signal && !entry.cancelled ? `${output}\n[ended by signal ${signal}]` : output));
      child.unref();
      return { job_id: id, status: 'running', pid: child.pid ?? null };
    },
    adopt(tool, input, promise) {
      const id = newId(), entry = { child: null, waiters: [], done: false };
      insert(id, tool, input, null);
      live.set(id, entry);
      Promise.resolve(promise).then((r) => [r?.isError ? 'failed' : 'done', r?.isError ? 1 : 0, Array.isArray(r?.content) ? JSON.stringify(r.content) : String(r?.content ?? '')],
        (error) => ['failed', 1, `[the backgrounded ${tool} call threw: ${error?.message || error}]`]).then(([s, c, o]) => settle(id, entry, s, c, o.slice(-JOB_OUTPUT_CHARS)));
      return { job_id: id, status: 'running', pid: null };
    },
    status(id) { const r = get.get(id, sessionId); return r ? describe(r) : { error: `no job ${id} in this conversation` }; },
    async wait(id, timeoutMs = 30_000) {
      const entry = live.get(id);
      if (entry && !entry.done) await new Promise((r) => { const t = setTimeout(r, Math.min(Math.max(timeoutMs, 0), 300_000)); t.unref?.(); entry.waiters.push(() => { clearTimeout(t); r(); }); });
      return this.status(id);
    },
    cancel(id) {
      const entry = live.get(id);
      if (!entry) return this.status(id);
      if (!entry.child) return { ...this.status(id), note: 'backgrounded tool call: no process to signal; await it' };
      entry.cancelled = true;
      try { process.kill(-entry.child.pid, 'SIGTERM'); } catch { try { entry.child.kill('SIGTERM'); } catch { /* gone */ } }
      setTimeout(() => { try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
      return { job_id: id, status: 'cancelling' };
    },
    undelivered() {
      const rows = db.prepare("SELECT * FROM jobs WHERE session_id = ? AND status != 'running' AND delivered_at IS NULL ORDER BY ended_at").all(sessionId);
      const stamp = db.prepare('UPDATE jobs SET delivered_at = ? WHERE id = ?');
      for (const r of rows) stamp.run(now(), r.id);
      return rows.map(describe);
    },
    running() { return db.prepare("SELECT id, tool, started_at FROM jobs WHERE session_id = ? AND status = 'running'").all(sessionId); },
    stopAll() {
      for (const [id, entry] of live) {
        entry.cancelled = true;
        if (entry.child) try { process.kill(-entry.child.pid, 'SIGKILL'); } catch { try { entry.child.kill('SIGKILL'); } catch { /* gone */ } }
        finish.run('cancelled', null, entry.child ? '[runner stopped; job killed, output not kept]' : '[runner stopped; backgrounded call outcome unknown]', now(), id);
      }
      live.clear();
    },
  };
}

function jobText(job, env) {
  if (!job || typeof job !== 'object' || job.error) return job;
  const stamp = (iso) => (iso ? localStamp(iso, env) || iso : null);
  const head = [`job ${job.job_id}`, job.tool, job.status, typeof job.exit_code === 'number' ? `exit ${job.exit_code}` : null,
    job.started_at ? `started ${stamp(job.started_at)}` : null, job.ended_at ? `ended ${stamp(job.ended_at)}` : null].filter(Boolean);
  return [`[${head.join(' | ')}]`, job.note, 'output_tail' in job ? job.output_tail || '(no output)' : null].filter(Boolean).join('\n');
}

/** Blocks a handler result carries beside its JSON text (a symbol key, so JSON.stringify leaves it out). */
export const RESULT_BLOCKS = Symbol('result blocks');

/**
 * read_document on an image file also returns the image itself as a block the model views (hydrated from the vision
 * copy when the request is built), so any image path can be looked at, not only an attachment and not only its OCR.
 */
export function withImage(out, env = process.env, { ref = imageRef } = {}) {
  const path = out?.origin?.kind === 'file' ? out.origin.path : null;
  if (!path || !viewableImage(path)) return out;
  const r = ref(path, { env });
  if (r.reason) return { ...out, vision: `this image could not be attached for viewing (${r.reason}); the spans are local OCR of visible text only` };
  const res = { ...out, vision: `the image itself follows as an image block you can see (${r.block.width}x${r.block.height}${r.block.derived ? ', a downscaled or converted JPEG copy' : ''}); the spans are local OCR of visible text only` };
  res[RESULT_BLOCKS] = [r.block];
  return res;
}

export function redactToolResult(result, index) {
  if (index && result && Array.isArray(result.content)) {
    // A block list: each text block is redacted; image references carry a path, not content.
    let hits = [];
    const content = result.content.map((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return b;
      const r = redactToolResult({ content: b.text }, index);
      if (r.redacted) hits = hits.concat(r.redacted);
      return r.content === b.text ? b : { ...b, text: r.content };
    });
    return hits.length ? { ...result, content, redacted: hits } : content.some((b, k) => b !== result.content[k]) ? { ...result, content } : result;
  }
  if (!index || !result || typeof result.content !== 'string') return result;
  try { const { text, hits } = index.redact(result.content); return hits.length ? { ...result, content: text, redacted: hits } : result; }
  catch (error) { return { ...result, content: `${result.content}\n[secret redaction failed: ${error?.message || error}]` }; }
}

/**
 * What the unified `search` tool reads from: the memory store, the source corpora (in-process, off the runner's thread),
 * the webchat transcripts and, when web tools are on, SearXNG only (never the third-party fallbacks the owner switched off).
 * One definition, used by the tool handler and by the bench.
 */
export function searchDeps({ env = process.env, sessionId = null, clock = () => new Date().toISOString(), memoryRead = null, readFile = null, asOf = null, now = null } = {}) {
  const store = memoryStore(env);
  const web = webConfigured(env) ? { ...env, TOPHAT_RUNNER_WEB_SEARCH_ORDER: 'searxng', TOPHAT_RUNNER_WEB_JINA: '0' } : null;
  return {
    env, now: now || clock(), asOf,
    exclude: [...new Set([sessionId, env.TOPHAT_CONVERSATION_ID].filter(Boolean))],
    memorySearch: store.installed ? (payload) => memoryCli('search', payload, { env }) : null,
    entityLookup: entityStore(env).installed ? (payload) => entityLookup(payload, { env }) : null,
    // pre-search linking of the people his message names (link.mjs), read-only on the memory store
    linkPeople: env.TOPHAT_REV6_LINK !== '0' && existsSync(store.db) ? (text, o = {}) => linkPeople(text, { dbPath: store.db, sessionId, at: o.at, context: o.context, env }) : null,
    sourceSearch: askConfigured(env) ? (query, opts = {}) => sourceSearchStructured(query, { env: { ...fastSearchEnv(env, { prefetch: true }), ASK_BEST_MAX: env.ASK_BEST_MAX || '16' }, asOf: opts.asOf, structured: true,
      threads: opts.threads !== false, partialMs: opts.partialMs || 0, onPartial: opts.onPartial || null }) : null,
    webSearch: web && webConfig(web).searxng ? (query, opts = {}) => searchWeb(query, { count: opts.count, env: web }) : null,
    // the transcript read off the runner's thread (webchat-worker.mjs); TOPHAT_REV6_SEARCH_INLINE=1 keeps it in-process
    ...(env.TOPHAT_REV6_SEARCH_INLINE === '1' ? {} : { webchatRun: webchatOffThread }),
    memoryRead, readFile,
  };
}

/**
 * Tools for one agent (root or child). `agents`, `goals` and `chat` (chat_rename/chat_archive, root only: chat.mjs) are optional; `factories` replaces the plug-ins
 * (cua, tabs, browser) in tests. run() always returns {content, isError} scrubbed of known secrets.
 */
export function createTools({ db, sessionId, cwd, roots = [], env = process.env, permissionMode = 'bypassPermissions', now, browserFactory = null, agents = null, goals = null, chat = null, onPath = null, mail = true, secrets, factories = {} }) {
  const fs = createFilesystem({ cwd, roots: [...roots, askConfigured(env) ? askRoot(env) : null], env });
  const noting = (set) => ({ ...set, check(path, at) { const r = set.check(path, at); try { onPath?.(r); } catch { /* best effort */ } return r; } });
  const boundary = noting(fs), writable = fs.confined ? noting(createRoots([cwd, ...roots])) : boundary;
  const clock = now || (() => new Date().toISOString());
  const mailTools = mail && mailConfigured(env) ? createMailTools({ db, sessionId, env, now: clock }) : null;
  const secretIndex = secrets === undefined ? sharedSecretIndex(env) : secrets;
  const jobs = createJobs(db, { sessionId, cwd, env, now, redact: (text) => redactToolResult({ content: text }, secretIndex).content });
  const web = webConfigured(env) ? createWebTools({ env, now: clock }) : null;
  const cua = (factories.cua || createCua)({ env, sessionId });
  const tabs = (factories.tabs || createTabWatcher)({ db, env, sessionId });
  const foreground = new Set();
  let readOnly = permissionMode === 'plan', browserBundle = null;
  // TOPHAT_RUNNER_TOOLS_ALLOW (off by default): a comma-separated list of the only tools this runner offers and runs. An instance that
  // serves strangers (a public demo) names its few read-only tools here; every other tool is absent from the model's list and refused
  // if called by name.
  const toolAllowed = env.TOPHAT_RUNNER_TOOLS_ALLOW ? new Set(String(env.TOPHAT_RUNNER_TOOLS_ALLOW).split(',').map((n) => n.trim()).filter(Boolean)) : null;
  // TOPHAT_REV6_HARNESS=v2 (off by default): plain-text shell results, head+tail cuts with the whole output spilled
  // to a file, and the tool names the model reaches for routed (harness-v2.mjs; evidence in bench/README.md).
  const hf = harnessFeatures(env), v2Shell = hf.has('shell'), v2Clip = hf.has('clip'), v2Alias = hf.has('alias');
  const spillDir = () => join(env.TOPHAT_REV6_SPILL_DIR || env.TOPHAT_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'tophat'), 'rev5', 'tool-output', String(sessionId || 'session').replace(/[^\w.-]/gu, '_'));

  async function browserTools() {
    if (browserBundle) return browserBundle;
    if (!browserConfigured(env) && !browserFactory) throw new Error('browser not configured: set TOPHAT_RUNNER_BROWSER_CDP or TOPHAT_RUNNER_BROWSER_BACKEND=chrome-devtools-mcp');
    const [{ createBrowserTools }, { createCredentialTools }] = await Promise.all([import('../tools/runner/browser.mjs'), import('../tools/runner/browser.mjs')]);
    const browser = browserFactory ? browserFactory({ sessionId }) : createBrowserTools({ sessionId, endpoint: env.TOPHAT_RUNNER_BROWSER_CDP, backend: browserBackend(env) });
    browserBundle = { browser, credentials: createCredentialTools({ browser, configDir: env.TOPHAT_VAULT_DIR ? dirname(env.TOPHAT_VAULT_DIR) : join(env.HOME || homedir(), '.config', 'tophat') }) };
    return browserBundle;
  }
  const viaBrowser = (fn) => async (i) => { const b = await browserTools(); try { return await fn(b, i); } catch (error) { return { error: String(error?.message || 'browser step failed').split('\n')[0].slice(0, 200) }; } };
  const viaWeb = (name) => async (i) => (web ? web[name](i) : { error: 'web tools off (TOPHAT_RUNNER_WEB=0)' });

  const handlers = {
    async task_list(i) { return { ...taskRequest({ ...i, op: 'list' }, env), caller_chat: sessionId }; },
    async task_update(i, call) {
      // The same rule as goal_close: a blocker is never a drop. `why` is ours, not a task field.
      for (const task of i.tasks || []) {
        if (task?.status !== 'dropped') continue;
        const refusal = checkDrop({ why: task.why, note: task.body });
        if (refusal) return { error: `${refusal} (task_update status dropped; put the proof in body)` };
      }
      const tasks = (i.tasks || []).map((task) => { if (!task || !('why' in task)) return task; const { why, ...rest } = task; return rest; });
      try { return taskRequest({ op: 'apply', op_id: `task:${sessionId}:${call.id}`, actor: `chat:${sessionId}`, tasks }, env); }
      catch (error) { return { error: error.message, ...(error.current ? { current: error.current } : {}) }; }
    },
    ...(messagesConfigured(env) ? { async messages_recent(i) { const out = recentMessages(i, env, clock()); return out.error ? out : messagesText(out, env); } } : {}),
    ...(attachmentsConfigured(env) ? { async read_document(i) { return withImage(await readDocument(i, { env, cwd, checkPath: (p, at) => boundary.check(p, at) }), env); } } : {}),
    ...(mailTools ? { mail_search: (i) => mailTools.mail_search(i), mail_read: (i) => mailTools.mail_read(i), mail_send: (i) => mailTools.mail_send(i) } : {}),
    ...(goals ? goalHandlers(goals) : {}),
    ...(chat ? { chat_rename: (i) => chat.chat_rename(i), chat_archive: (i) => chat.chat_archive(i), chat_workspace: (i) => chat.chat_workspace(i), chat_handoff: (i) => chat.chat_handoff(i) } : {}),
    ...(agents ? { Agent: (i, call) => agents.spawn(i, call?.id), agent_send: (i) => agents.send(i), agent_list: async () => ({ agents: agents.list() }), agent_wait: (i) => agents.wait(i), agent_cancel: async (i) => agents.cancel(i) } : {}),
    web_search: viaWeb('web_search'), web_open: viaWeb('web_open'), web_find: viaWeb('web_find'),
    browser_acquire: viaBrowser((b, i) => b.browser.acquire(i.isolated ? { isolated: true } : {})),
    browser_navigate: viaBrowser((b, i) => b.browser.navigate({ lease: i.lease, url: i.url })),
    browser_read: viaBrowser((b, i) => b.browser.read({ lease: i.lease })),
    browser_click: viaBrowser((b, i) => b.browser.click({ lease: i.lease, selector: i.selector })),
    browser_type: viaBrowser((b, i) => b.browser.type({ lease: i.lease, selector: i.selector, text: i.text })),
    browser_release: viaBrowser((b, i) => b.browser.release({ lease: i.lease })),
    credential_list: viaBrowser((b, i) => b.credentials.list({ lease: i.lease })),
    credential_fill_login: viaBrowser((b, i) => b.credentials.fillLogin({ lease: i.lease, handle: i.handle, usernameSelector: i.usernameSelector, passwordSelector: i.passwordSelector })),
    credential_fill_totp: viaBrowser((b, i) => b.credentials.fillTotp({ lease: i.lease, handle: i.handle, otpSelector: i.otpSelector })),
    async memory_status() { return memoryCli('status', {}, { env }); },
    async memory_search(i) { const out = withLocalTimes(await memoryCli('search', { query: i.query, kind: i.kind, limit: i.limit ?? 10, derived: memoryDerivedAllowance(i), as_of: clock() }, { env }), env); return renderMemorySearch(out, env) ?? out; },
    async memory_list(i) { const { entity, term, source, kinds, since, until, tz, order, limit, offset, chars } = i; const out = withLocalTimes(await memoryCli('list', { entity, term, source, kinds, since, until, tz, order, limit, offset, chars }, { env, readOnly: true }), env); return out; },
    async memory_read(i) { const budget = memoryReadBudget(i.budget); const out = withLocalTimes(await memoryCli('read', { kind: i.kind, id: i.id, nodes: i.nodes, budget, as_of: clock() }, { env }), env); return renderMemoryRead(out, env, { budget }) ?? out; },
    async memory_apply(i) {
      if ((i.changes?.work || []).some((w) => w.id && !w.id.startsWith('$') && !Number.isInteger(w.expected_version))) return { error: 'Existing work updates require expected_version. Read task_list, then use task_update.' };
      const request = { batch_id: i.batch_id, changes: i.changes, source_refs: i.source_refs, ...(i.groups !== undefined ? { groups: i.groups } : {}) };
      // A chat outside this instance's write scope files only under its own scope's group, never the instance default (chat-scope.mjs, memory-groups.mjs). Scopes off: no verdict, nothing changes.
      const held = runnerChatVerdict(sessionId, env);
      if (!held) return memoryCli('apply', request, { env });
      if (held.retry) return { ok: false, reason: 'refused', error: `memory_apply refused: ${held.why}, so this chat's scope is not known and nothing was written; try again` };
      const confined = confineToScope(request, held.scope);
      if (confined.error) return scopedWriteError(held.scope, env.TOPHAT_SCOPE, confined.error);
      const out = await memoryCli('apply', confined.payload, { env });
      return out?.ok === false && /group|acl/iu.test(`${out.detail || ''} ${out.error || ''}`) ? scopedWriteError(held.scope, env.TOPHAT_SCOPE, `the store refused: ${String(out.detail || out.error).slice(0, 300)}`) : out;
    },
    async read_file(i) {
      const path = boundary.check(i.path, cwd), size = statSync(path).size, max = Math.min(i.max_bytes || FILE_BYTES, FILE_BYTES), text = readFileSync(path, 'utf8');
      return size > max ? `${cut(text, max)}\n[... file is ${size} bytes; showing the first ${max}]` : text;
    },
    async source_search(i) { return sourceSearchText(i, { env, now: clock() }); },
    async search(i) {
      const deps = searchDeps({ env, sessionId, clock, memoryRead: (r) => handlers.memory_read(r), readFile: (p) => handlers.read_file({ path: p }) });
      const out = await unifiedSearch(i, deps);
      return out.error ? { error: out.text } : out.text;
    },
    // The webchat chat store, read-only (rev5/chats-tool.mjs): list chats, read a chat's last turns or final replies.
    async chats(i) { return chatsTool(i, { env }); },
    async write_file(i) {
      const path = writable.check(i.path, cwd), content = String(i.content ?? '');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return { wrote: path, bytes: Buffer.byteLength(content), at: clock() };
    },
    async list_files(i) { return readdirSync(boundary.check(i.path || '.', cwd), { withFileTypes: true }).slice(0, 500).map((d) => `${d.isDirectory() ? 'd ' : '  '}${d.name}`).join('\n') || '(empty)'; },
    async search_files(i) {
      const path = boundary.check(i.path || '.', cwd);
      return new Promise((done) => execFile('grep', ['-rnIE', '--exclude-dir=node_modules', '--exclude-dir=.git', '-m', '50', '--', i.pattern, path], { env: scrubbedEnv(env), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error && error.code === 1) return done('(no matches)');
        if (error) return done({ error: `search failed: ${error.killed ? 'timeout' : error.code || error.message}` });
        done(stdout.split('\n').slice(0, 200).join('\n'));
      }));
    },
    async shell(i) {
      const at = i.cwd ? boundary.check(i.cwd, cwd) : cwd;
      if (i.background) return jobs.start('shell', i, i.command, at);
      return new Promise((done) => {
        const timeout = Math.min(i.timeout_ms || SHELL_MS, 600_000);
        const child = runForeground(i.command, { cwd: at, env: scrubbedEnv(env), timeout }, (error, stdout, stderr) => {
          foreground.delete(child);
          if (v2Shell) return done(shellText({ stdout, stderr, code: error ? (error.code ?? 1) : 0, killedAfter: error?.killed && !child.interrupted ? timeout : null, interrupted: Boolean(child.interrupted), command: i.command },
            { max: RESULT_CHARS, spillDir: spillDir(), name: `${Date.now()}-shell`, clipper: v2Clip ? null : (text, n) => clip(text, n) }));
          const body = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
          if (child.interrupted) return done({ error: 'interrupted by the owner before the command finished', output: clip(body, 8000) });
          if (error?.killed) return done({ error: `killed after ${timeout}ms; use background=true for slow work`, output: clip(body, 8000) });
          done(error ? { exit_code: error.code ?? null, output: clip(body) } : clip(body) || '(no output)');
        });
        foreground.add(child);
      });
    },
    async job_status(i) { return jobText(jobs.status(i.job_id), env); },
    async job_wait(i) { return jobText(await jobs.wait(i.job_id, i.timeout_ms ?? 30_000), env); },
    async job_cancel(i) { return jobText(jobs.cancel(i.job_id), env); },
  };
  if (factories.handlers) Object.assign(handlers, factories.handlers);

  async function runUnscrubbed(name, input = {}, call = null) {
    if (toolAllowed && !toolAllowed.has(name)) return { content: `${name} is not available in this instance`, isError: true };
    if (name.startsWith('mcp__cua_repl__')) {
      if (readOnly) return { content: 'Computer use refused in plan mode (read-only)', isError: true };
      try { return await tabs.around(() => cua.run(name, input)); } catch (error) { return { content: error.message, isError: true }; }
    }
    if (v2Alias && !handlers[name] && TOOL_ALIASES[name] && handlers[TOOL_ALIASES[name]]) { input = aliasInput(name, input); name = TOOL_ALIASES[name]; }
    const handler = handlers[name];
    if (!handler) return { content: `unknown tool ${name}`, isError: true };
    if (isIncognito(env) && INCOGNITO_TOOLS_OFF.has(name)) return { content: `${name} is unavailable in an incognito chat: it writes nothing to memory or tasks`, isError: true };
    if (readOnly && MUTATING.has(name)) return { content: `${name} refused in plan mode (read-only)`, isError: true };
    try {
      const out = await handler(input, call);
      const isError = Boolean(out && typeof out === 'object' && (out.error || out.ok === false));
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      if (name === 'memory_read') {
        const max = memoryReadBudget(input.budget), head = '[memory_read PARTIAL JSON fallback; remainder not read; offset continuation unsupported]\n';
        return { content: text.length <= max ? text : head + cut(text, max - head.length), isError };
      }
      const content = v2Clip ? clipHeadTail(text, RESULT_CHARS, { spillDir: spillDir(), name: `${Date.now()}-${name}` }) : clip(text, RESULT_CHARS);
      // A result that carries blocks beside its JSON (read_document on an image: the image itself) is a block list.
      const extra = out && typeof out === 'object' ? out[RESULT_BLOCKS] : null;
      return { content: extra?.length ? [{ type: 'text', text: content }, ...extra] : content, isError };
    } catch (error) { return { content: `${name} failed: ${error.code || ''} ${error.message}`.trim(), isError: true }; }
  }

  const unified = hf.has('unify');
  const HIDDEN_BY_UNIFY = new Set(['memory_search', 'source_search']);
  // Under unify the raw ids come from `search` (its memory hits are memory_read refs); the data file stays byte-equal to rev5's text.
  const forUnify = (spec) => (unified && spec.name === 'memory_apply' ? { ...spec, description: spec.description.replace('First memory_search kind=raw and memory_read to obtain real raw IDs', 'First find real raw IDs with `search` (its memory hits are memory_read refs) and memory_read them') } : spec);
  const specList = () => [...cua.specs, ...(unified ? [SEARCH_TOOL] : []), ...coreSpecs().filter((spec) => !(unified && HIDDEN_BY_UNIFY.has(spec.name))).map(forUnify), CHATS_TOOL, ...(attachmentsConfigured(env) ? [readDocumentToolSpec()] : []), ...(askConfigured(env) && !unified ? [sourceSearchSpec()] : []),
    ...(messagesConfigured(env) ? [messagesToolSpec()] : []), ...(mailTools ? mailToolSpecs(env) : []), ...(web ? webToolSpecs() : []), ...(goals ? goalSpecs() : []), ...(chat ? chatSpecs() : []),
    ...(agents ? agentSpecs() : []), ...(browserConfigured(env) || browserFactory ? browserSpecs(env) : [])]
    .filter((spec) => !(isIncognito(env) && INCOGNITO_TOOLS_OFF.has(spec.name)))
    .filter((spec) => !toolAllowed || toolAllowed.has(spec.name));
  return {
    ready: () => cua.ready(), computerPrompt: () => cua.prompt(),
    get specs() { return describeTools(specList(), hf); },
    jobs, mail: mailTools, roots: boundary.list, confined: Boolean(fs.confined),
    async closeBrowser() { cua.close(); if (browserBundle) { try { await browserBundle.browser.close(); } catch { /* already closed */ } browserBundle = null; } },
    setPermissionMode(mode) { readOnly = mode === 'plan'; },
    abortForeground() { for (const child of foreground) { child.interrupted = true; killGroup(child); } },
    async run(name, input = {}, call = null) { const result = redactToolResult(await runUnscrubbed(name, input, call), secretIndex); return publicPrompt(env) ? withoutHome(result, env.HOME || homedir()) : result; },
  };
}
