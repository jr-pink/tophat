// Port of tools/tophat-cdp's plumbing; the nine gotchas in tools/README-tophat-cdp.md are encoded here:
//  1 Origin: Node's WebSocket sends no Origin header, so Chrome's 403 cannot happen; never add one.
//  2 /json/new is 405: tabs are made with Target.createTarget over the browser socket (createTarget).
//  3 every target, iframes included, attaches at ws://HOST/devtools/page/<id> (targetSocketUrl).
//  4 input goes to the PAGE at hit-tested coordinates (Resolver.clickAt / routeToPage).
//  5 a frame is the <iframe> element that embeds it, never its url (Resolver.resolve, frameIdOf).
//  6/7 fill is focus + selectAll editing command + Input.insertText, never .value or Backspace.
//  8 scroll innermost-first, wait for it to stop, hit-test (Resolver.locate / hitTest).
//  9 key events into a background tab need Emulation.setFocusEmulationEnabled (Conn.focusEmulation).
// Protected targets refuse every mutating verb. Never: guess a port (no 9222 default), act on a tab
// another live job holds without steal, or touch a protected target without force.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CliError } from '../../lib/cli.mjs';
import { configDir, configFile, envGet, stateDir } from '../../lib/paths.mjs';

export class CdpError extends CliError {
  constructor(message, kind = 'target_not_found', detail) { super(message, { tool: 'cdp', kind, detail }); this.name = 'CdpError'; }
}
const E = (m, k) => new CdpError(m, k);
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const up = (s) => String(s || '').toUpperCase();
/** Python's repr() of a str (what the Python tool's %r put in messages); null -> None. */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  const s = String(v), q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').split(q).join(`\\${q}`) + q;
}
/** str(float) in Python: 30 -> '30.0'. */
export const pyFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

// ---- endpoint ---------------------------------------------------------------
export function discover(env = process.env) {
  const file = configFile(env);
  const namedVar = ['TOPHAT_CDP_ENDPOINT', 'TOPHAT_RUNNER_BROWSER_CDP', 'TOPHAT_REV5_BROWSER_CDP'].find((n) => envGet(env, n));
  const named = namedVar && envGet(env, namedVar);
  let endpoint = named;
  if (!endpoint) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch {
      throw E(`No browser configuration at ${file}; set TOPHAT_CDP_ENDPOINT or browserCdp in that file (inspect local configuration instead of guessing a port)`, 'usage');
    }
    try { const c = JSON.parse(raw); endpoint = c?.browserCdp || c?.rev5?.browserCdp; } catch { endpoint = null; }
  }
  if (!endpoint) throw E('No browserCdp configured; set TOPHAT_CDP_ENDPOINT or browserCdp in the config file (inspect local configuration instead of guessing a port)', 'usage');
  let u;
  try { u = new URL(endpoint); } catch { throw E('Expected a local HTTP CDP endpoint', 'usage'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host) || u.username || u.password) {
    throw E('Expected a local HTTP CDP endpoint', 'usage');
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), source: namedVar || `${file}#browserCdp` };
}

// Chrome is usually owned by a KeepAlive launchd agent; a refused connection means it is down. When
// TOPHAT_CDP_LAUNCHD_LABEL names that agent, the error says how to bring it back.
export const CDP_LAUNCHD_LABEL = (env = process.env) => envGet(env, 'TOPHAT_CDP_LAUNCHD_LABEL') || '';
export const refusedHint = (code, env = process.env) => {
  const label = CDP_LAUNCHD_LABEL(env);
  return /ECONNREFUSED|refused/i.test(String(code || ''))
    ? `; Chrome is not listening.${label ? ` It is owned by the launchd agent ${label}: \`launchctl kickstart -k gui/$(id -u)/${label}\` (if not loaded: \`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist\`)` : ' Start Chrome with --remote-debugging-port.'}`
    : '';
};

export async function httpJson(endpoint, p, timeout = 5) {
  let res;
  try { res = await fetch(endpoint + p, { signal: AbortSignal.timeout(timeout * 1000) }); } catch (e) {
    const code = e?.cause?.code || e?.name || e;
    throw E(`CDP endpoint ${endpoint} unreachable: ${code}${refusedHint(code)}`, 'endpoint_down');
  }
  if (!res.ok) throw E(`${p} returned HTTP ${res.status} (note: /json/new is 405 on this Chrome; use \`new\`, which goes through Target.createTarget)`, 'endpoint_down');
  try { return await res.json(); } catch { throw E(`${p} returned non-JSON`, 'endpoint_down'); }
}

export async function browserSocketUrl(endpoint) {
  const version = await httpJson(endpoint, '/json/version');
  if (!version.webSocketDebuggerUrl) throw E('Endpoint did not return a CDP browser socket', 'endpoint_down');
  return { url: version.webSocketDebuggerUrl, version };
}
export const targetSocketUrl = (endpoint, id) => `ws://${new URL(endpoint).host}/devtools/page/${id}`;

// ---- one DevTools socket ----------------------------------------------------
export class Conn {
  static open(url, timeout = 20) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(E(`could not open DevTools socket ${url}: ${e.message}`, 'endpoint_down')); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(E(`could not open DevTools socket ${url}: timed out`, 'endpoint_down')); }, timeout * 1000);
      ws.onopen = () => { clearTimeout(timer); resolve(new Conn(ws, timeout)); };
      ws.onerror = (ev) => { clearTimeout(timer); reject(E(`could not open DevTools socket ${url}: ${ev?.message || 'handshake failed'}`, 'endpoint_down')); };
    });
  }
  constructor(ws, timeout) {
    Object.assign(this, { ws, timeout, nextId: 0, pending: new Map(), events: [], waiters: [] });
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const p = msg.id !== undefined && this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(E(`${p.method} failed: ${msg.error.message} (${msg.error.code})`, 'target_not_found'));
        else p.resolve(msg.result || {});
      } else if (msg.method) { this.events.push(msg); for (const w of this.waiters.splice(0)) w(); }
    };
    ws.onclose = () => { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(E(`${p.method} failed on the socket: closed`, 'endpoint_down')); } this.pending.clear(); };
  }
  send(method, params = {}, timeout) {
    const id = ++this.nextId, wait = timeout || this.timeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(E(`${method} timed out after ${Math.round(wait)}s`, 'timeout')); }, wait * 1000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(E(`${method} failed on the socket: ${e.message}`, 'endpoint_down')); }
    });
  }
  async focusEmulation(enabled = true) {
    try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: !!enabled }); return true; } catch { return false; }
  }
  /** The first queued or arriving event named `method` within ms, else null. */
  async waitEvent(method, ms) {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.events.find((e) => e.method === method);
      if (hit) return hit.params || {};
      const left = until - Date.now();
      if (left <= 0) return null;
      await new Promise((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
  }
  close() { try { this.ws.close(); } catch {} }
}

// The passkey keeper (Python, tools/tophat-cdp `passkey attach`) owns the only session on a tab that has a
// virtual authenticator; closing a second session would destroy it (gotcha 8b). Borrow its session instead.
export function passkeyDir(env = process.env) { return envGet(env, 'TOPHAT_CDP_PASSKEYS') || path.join(stateDir(env), 'cdp/passkeys'); }
export class KeeperConn {
  constructor(state, timeout) { Object.assign(this, { state, timeout, events: [] }); }
  send(method, params = {}, timeout) {
    const wait = timeout || this.timeout;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.state.socket);
      let body = '';
      const timer = setTimeout(() => { sock.destroy(); reject(E(`passkey keeper for job ${this.state.job} is not answering (timeout)`, 'target_not_found')); }, (wait + 15) * 1000);
      sock.on('connect', () => sock.write(`${JSON.stringify({ cmd: 'cdp', method, params, timeout: wait })}\n`));
      sock.on('data', (d) => { body += d; if (body.endsWith('\n')) sock.end(); });
      sock.on('error', (e) => { clearTimeout(timer); reject(E(`passkey keeper for job ${this.state.job} is not answering (${e.code || e.message})`, 'target_not_found')); });
      sock.on('close', () => {
        clearTimeout(timer);
        let data; try { data = JSON.parse(body.trim().split('\n').pop()); } catch { reject(E(`passkey keeper for job ${this.state.job} closed without answering`, 'target_not_found')); return; }
        if (!data.ok) reject(E(`passkey keeper: ${data.error}`, 'target_not_found')); else resolve(data.result || {});
      });
    });
  }
  async focusEmulation() { return true; }
  async waitEvent() { return null; }
  close() {}
}
export function keeperFor(targetId, env = process.env) {
  if (envGet(env, 'TOPHAT_CDP_NO_KEEPER_PROXY')) return null;
  const dir = passkeyDir(env);
  let names; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (up(s.targetId) === up(targetId) && pidAlive(s.pid) && s.socket && fs.existsSync(s.socket)) return s;
  }
  return null;
}

export async function openTargetConn(endpoint, target, timeout = 20) {
  const keeper = keeperFor(target.id);
  return keeper ? new KeeperConn(keeper, timeout) : Conn.open(targetSocketUrl(endpoint, target.id), timeout);
}
export async function withTarget(endpoint, target, fn, timeout = 20) {
  const c = await openTargetConn(endpoint, target, timeout);
  try { return await fn(c); } finally { c.close(); }
}
export async function withBrowser(endpoint, fn, timeout = 20) {
  const { url } = await browserSocketUrl(endpoint);
  const c = await Conn.open(url, timeout);
  try { return await fn(c); } finally { c.close(); }
}

export async function evaluate(conn, expression, { awaitPromise = true, byValue = true, timeout } = {}) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise, userGesture: true, allowUnsafeEvalBlockedByCSP: false }, timeout);
  const d = r.exceptionDetails;
  if (d) {
    const x = d.exception || {};
    throw E(`JavaScript exception: ${x.description || x.value || d.text || 'JavaScript exception'}`, 'target_not_found');
  }
  return r.result || {};
}
export const evalValue = async (conn, js, o) => (await evaluate(conn, js, o)).value;

// ---- targets ------------------------------------------------------------------
export async function listTargets(endpoint) {
  return (await httpJson(endpoint, '/json/list')).map((t) => ({ id: t.id, type: t.type, title: t.title ?? '', url: t.url ?? '', attached: t.attached ?? null, parentId: t.parentId ?? null }));
}
const ID_RE = /^[0-9A-Fa-f]{6,}$/;
export const SELECTOR_PREFIXES = ['url=', 'url^=', 'url*=', 'title*=', 'job='];
export const looksLikeTarget = (s) => !!s && (ID_RE.test(s) || SELECTOR_PREFIXES.some((p) => s.startsWith(p)));

/** Exactly one target for a selector; ambiguity is an error listing every candidate (gotcha 5). */
export function pickTarget(targets, spec, wantTypes) {
  const pool = wantTypes ? (targets.filter((t) => wantTypes.includes(t.type)).length ? targets.filter((t) => wantTypes.includes(t.type)) : targets) : targets;
  const unique = (m, how) => {
    if (!m.length) throw E(`no target matched ${spec} (${how})`, 'target_not_found');
    if (m.length > 1) throw E(`ambiguous target selector ${spec} (${how}) matched ${m.length} targets; be exact:\n  ${m.map((t) => `${t.id}  ${t.type.padEnd(8)} ${t.url.slice(0, 110)}`).join('\n  ')}`, 'target_not_found');
    return m[0];
  };
  const rules = [['url=', 'exact url', (t, v) => t.url === v], ['url^=', 'url prefix', (t, v) => t.url.startsWith(v)],
    ['url*=', 'url substring', (t, v) => t.url.includes(v)], ['title*=', 'title substring', (t, v) => (t.title || '').includes(v)]];
  for (const [p, how, ok] of rules) if (spec.startsWith(p)) { const v = spec.slice(p.length); return unique(pool.filter((t) => ok(t, v)), how); }
  if (ID_RE.test(spec)) {
    const exact = targets.find((t) => up(t.id) === up(spec));
    return exact || unique(targets.filter((t) => up(t.id).startsWith(up(spec))), 'id prefix');
  }
  throw E(`unrecognised target selector ${pyRepr(spec)}; use an id, an id prefix, url=, url^=, url*= or title*=`, 'usage');
}
export const resolveTarget = async (endpoint, spec, wantTypes) => pickTarget(await listTargets(endpoint), spec, wantTypes);

// ---- protected targets --------------------------------------------------------
export const protectFile = (env = process.env) => envGet(env, 'TOPHAT_CDP_PROTECT_FILE') || path.join(configDir(env), 'cdp-protected-targets.txt');
export function protectedIds(env = process.env) {
  const ids = new Set((envGet(env, 'TOPHAT_CDP_PROTECTED') || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean).map(up));
  try {
    for (const line of fs.readFileSync(protectFile(env), 'utf8').split('\n')) { const id = line.split('#')[0].trim(); if (id) ids.add(up(id)); }
  } catch { /* no file */ }
  return ids;
}
export function guardProtected(target, { force } = {}, action, env = process.env) {
  if (force) return;
  if (protectedIds(env).has(up(target.id))) {
    throw E(`refusing to ${action} protected target ${target.id} (${target.url.slice(0, 80)}). It is listed in ${protectFile(env)} or $TOPHAT_CDP_PROTECTED; pass --force only if you own it.`, 'refused');
  }
}

// ---- job registry: one owned tab per job ---------------------------------------
export const jobsDir = (env = process.env) => envGet(env, 'TOPHAT_CDP_JOBS') || path.join(stateDir(env), 'cdp/jobs');
export const uiJobsDir = (env = process.env) => envGet(env, 'TOPHAT_UI_JOBS') || path.join(stateDir(env), 'ui/jobs');
const JOB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
export const MUTATING_VERBS = ['close', 'activate', 'navigate', 'reload', 'click', 'dom-click', 'type', 'keys', 'fill', 'eval', 'tap', 'clear', 'dialog', 'cookies', 'upload', 'headers', 'window', 'captcha'];
export const TARGET_VERBS = [...MUTATING_VERBS, 'info', 'html', 'text', 'screenshot', 'pdf', 'download', 'wait-for', 'frame-map', 'point'];

const pad = (n, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
/** time.strftime('%Y-%m-%dT%H:%M:%S%z'): local wall time with a -0700 style offset. */
export function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}${pad(off % 60)}`;
}
export function parseStamp(s) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:([+-]\d{2}):?(\d{2}))?$/.exec(String(s || ''));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[2] ? `${m[2]}:${m[3]}` : 'Z'}`);
  return Number.isFinite(ms) ? ms : null;
}
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}
export function checkJobName(name) {
  if (!name || !JOB_NAME_RE.test(name)) throw E(`bad job name ${pyRepr(name ?? null)}; use letters, digits, . _ - @ (max 64 chars)`, 'usage');
  return name;
}
export function sanitizeJobName(value, prefix = 'agent-') {
  let c = String(value || '').trim().replace(/[^A-Za-z0-9._@-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!c) return null;
  if (!/^[A-Za-z0-9]/.test(c)) c = prefix + c;
  return c.slice(0, 64).replace(/-+$/, '') || null;
}
export const JOB_NAME_SOURCES = ['TOPHAT_CDP_JOB', 'TOPHAT_AGENT_ID', 'TOPHAT_CONVERSATION_ID'];
export function defaultJobName(env = process.env, ppid = process.ppid) {
  for (const v of JOB_NAME_SOURCES) { const n = sanitizeJobName(envGet(env, v)); if (n) return [n, v]; }
  return [sanitizeJobName(`auto-${ppid}`) || 'auto', 'process'];
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const jobFile = (name, env) => path.join(jobsDir(env), `${checkJobName(name)}.json`);
export function loadJob(name, env = process.env) {
  try { return JSON.parse(fs.readFileSync(jobFile(name, env), 'utf8')); } catch (e) { if (e instanceof CdpError) throw e; return null; }
}
export function saveJob(job, env = process.env) {
  fs.mkdirSync(jobsDir(env), { recursive: true });
  const file = jobFile(job.job, env), tmp = file.replace(/\.json$/, `.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(job), null, 2));
  fs.renameSync(tmp, file);
  return job;
}
export function saveJobExclusive(job, env = process.env) {
  fs.mkdirSync(jobsDir(env), { recursive: true });
  try { fs.writeFileSync(jobFile(job.job, env), JSON.stringify(sortKeys(job), null, 2), { flag: 'wx', mode: 0o644 }); return job; } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
}
export function allJobs(env = process.env) {
  let names; try { names = fs.readdirSync(jobsDir(env)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((n) => { try { return loadJob(n.slice(0, -5), env); } catch { return null; } }).filter((j) => j?.job);
}
export function uiJobs(env = process.env) {
  const out = {};
  let names = [];   // directory order, as Python's iterdir (readdirSync sorts)
  try { const d = fs.opendirSync(uiJobsDir(env)); for (let e; (e = d.readSync());) if (e.name.endsWith('.json')) names.push(e.name); d.closeSync(); } catch { return out; }
  for (const n of names) { try { const r = JSON.parse(fs.readFileSync(path.join(uiJobsDir(env), n), 'utf8')); if (r && typeof r === 'object' && r.job) out[r.job] = r; } catch {} }
  return out;
}
export function releaseJob(name, env = process.env) { try { fs.unlinkSync(jobFile(name, env)); return true; } catch { return false; } }

function urlParts(u) {
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)/.exec(u || '');
  const seg = (m[3] || '').split('/').filter(Boolean);
  return [(m[1] || '').toLowerCase(), m[2] || '', seg[0] || ''];
}
/** The anti-yank signal: origin change or a new first path segment. */
export function urlDrift(expected, current) {
  if (!expected || !current || ['about:blank', 'chrome://newtab/'].includes(expected)) return null;
  const [es, eh, ep] = urlParts(expected), [cs, ch, cp] = urlParts(current);
  if (!ch && !eh) return null;
  if (es !== cs || eh !== ch) return `origin changed from ${es}://${eh} to ${cs || '?'}://${ch || '?'}`;
  if (ep && ep !== cp) return `path moved from /${ep}/... to /${cp}`;
  return null;
}
const liveById = (targets) => new Map(targets.map((t) => [up(t.id), t]));
export function targetOwner(targets, targetId, exclude, jobs = allJobs()) {
  const live = liveById(targets);
  return jobs.find((j) => j.job !== exclude && up(j.targetId) === up(targetId) && live.has(up(targetId))) || null;
}
export function jobIsStale(job, ttl = Number(envGet(process.env, 'TOPHAT_CDP_JOB_TTL') || 3600), now = Date.now()) {
  if (job.pid && pidAlive(job.pid)) return false;
  const at = parseStamp(job.lastSeen || job.since);
  return at !== null && Math.max((now - at) / 1000, 0) > ttl;
}
export function refindTarget(job, targets, env = process.env) {
  const held = new Set(allJobs(env).filter((j) => j.job !== job.job).map((j) => up(j.targetId)));
  const pages = targets.filter((t) => t.type === 'page' && !held.has(up(t.id)));
  for (const [key, field] of [['lastUrl', 'url'], ['lastTitle', 'title']]) {
    if (!job[key]) continue;
    const m = pages.filter((t) => (t[field] || '') === job[key]);
    if (m.length === 1) return m[0];
  }
  return null;
}
/**
 * Drop entries whose tab is gone, and abandoned claims; the tab of an abandoned claim stays open here (reapIdleTabs
 * closes it once it has sat unchanged for the tab TTL). `orphans`, when given, collects the tab ids of abandoned
 * EPHEMERAL claims: their caller promised to release them on exit and did not (killed, timed out), so the tab is garbage.
 */
export function reapJobs(targets, { ttl, env = process.env, orphans } = {}) {
  const live = liveById(targets), reaped = [];
  for (const j of allJobs(env)) {
    const stale = jobIsStale(j, ttl);
    if ((!live.has(up(j.targetId)) && !refindTarget(j, targets, env)) || stale) {
      if (stale && j.ephemeral && orphans && live.has(up(j.targetId))) orphans.push(j.targetId);
      releaseJob(j.job, env); reaped.push(j.job);
    }
  }
  return reaped;
}

// Tabs nobody speaks for pile up in the shared agent Chrome: every claimed-and-never-closed tab keeps a renderer
// (200-400 MB each; 25 pages were 10 GB on 2026-11-18). A page that no live job holds, that is not protected, and whose
// url+title have not changed for TOPHAT_CDP_TAB_TTL seconds (default 3600; 0 turns this off) is closed. Idle time is
// measured by this registry (tab-seen.json beside the jobs dir, rewritten atomically), since Chrome keeps no activity time.
export const tabTtl = (env = process.env) => { const v = envGet(env, 'TOPHAT_CDP_TAB_TTL'); return v === undefined || v === '' ? 3600 : Number(v); };
export const tabSeenFile = (env = process.env) => path.join(path.dirname(jobsDir(env)), 'tab-seen.json');
/** Returns the target ids it closed. `close(id)` defaults to closing in the browser at `endpoint`. */
export async function reapIdleTabs(targets, { endpoint, close, ttl, now = Date.now(), env = process.env, extra = [] } = {}) {
  ttl = ttl ?? tabTtl(env);
  if (!(ttl > 0)) return [];
  const file = tabSeenFile(env);
  let seen = {};
  try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (raw && typeof raw === 'object') seen = raw; } catch { /* first run */ }
  const held = new Set(allJobs(env).map((j) => up(j.targetId))), keep = protectedIds(env);
  const pages = targets.filter((t) => t.type === 'page'), next = {}, doomed = [];
  for (const t of pages) {
    const id = up(t.id), sig = `${t.url}\n${t.title}`, was = seen[id];
    const since = held.has(id) || !was || was.sig !== sig ? now : was.since;
    next[id] = { sig, since };
    if (keep.has(id) || held.has(id)) continue;
    if (extra.map(up).includes(id) || (now - since) / 1000 > ttl) doomed.push(t);
  }
  // never close the last page: Chrome would quit with it
  const closed = [], spare = pages.length - doomed.length < 1 ? doomed.slice(1) : doomed;
  for (const t of spare) {
    const ok = close ? await close(t.id) : await closeTarget(endpoint, t.id);
    if (ok !== false) { closed.push(t.id); delete next[up(t.id)]; }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
  } catch { /* a read-only state dir only delays the reaping */ }
  return closed;
}
export async function createTarget(endpoint, url, { background = true, newContext = false } = {}) {
  return withBrowser(endpoint, async (c) => {
    const params = { url, background: !!background };
    if (newContext) params.browserContextId = (await c.send('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
    return (await c.send('Target.createTarget', params)).targetId;
  });
}
export async function closeTarget(endpoint, id) {
  try { await withBrowser(endpoint, (c) => c.send('Target.closeTarget', { targetId: id })); return true; } catch { return false; }
}
export function newJobRecord(name, targetId, { url = null, title = null, ephemeral = false, expectPrefix = null, tool = 'tophat-cdp' } = {}) {
  const s = nowIso();
  return { job: name, targetId, pid: process.pid, ppid: process.ppid, tool, since: s, lastSeen: s, lastUrl: url, lastTitle: title, expectPrefix, ephemeral: !!ephemeral };
}
export function jobNoteUrl(job, url, title, env = process.env) {
  if (url) job.lastUrl = url;
  if (title !== undefined) job.lastTitle = title;
  job.lastSeen = nowIso();
  return saveJob(job, env);
}
export async function navigateJob(endpoint, job, url, timeout = 20) {
  const r = await withTarget(endpoint, { id: job.targetId }, async (c) => {
    const res = await c.send('Page.navigate', { url });
    if (res.errorText) throw E(`navigation failed: ${res.errorText}`, 'target_not_found');
    return res;
  }, timeout);
  jobNoteUrl(job, url);
  return r;
}

/** Own a tab under this name -> [job, how] with how created / reused / adopted / recovered. */
export async function claimJob(endpoint, name, o = {}) {
  const { url, targetId, steal, background = true, newContext, fresh, ephemeral, expectPrefix, tool = 'tophat-cdp', navigate = true, env = process.env } = o;
  checkJobName(name);
  let targets = await listTargets(endpoint);
  const orphans = [];
  reapJobs(targets, { env, orphans });
  const closedTabs = new Set((await reapIdleTabs(targets, { endpoint, env, extra: orphans }).catch(() => [])).map(up));
  if (closedTabs.size) targets = targets.filter((t) => !closedTabs.has(up(t.id)));
  const rec = (id, extra) => newJobRecord(name, id, { ephemeral, expectPrefix: expectPrefix ?? null, tool, ...extra });
  if (targetId) {
    const t = pickTarget(targets, targetId);
    const owner = targetOwner(targets, t.id, name, allJobs(env));
    if (owner && !steal) throw E(`target ${t.id} (${(t.url || '').slice(0, 70)}) is already job ${owner.job} (pid ${owner.pid}, since ${owner.since}); pass --steal to take it`, 'refused');
    if (protectedIds(env).has(up(t.id)) && !steal) throw E(`target ${t.id} is on the protected list in ${protectFile(env)}; pass --steal only if you own it`, 'refused');
    return [saveJob(rec(t.id, { url: url || t.url, title: t.title }), env), 'adopted'];
  }
  const existing = loadJob(name, env);
  if (existing && !fresh) {
    const t = liveById(targets).get(up(existing.targetId)) || refindTarget(existing, targets, env);
    if (t) {
      const how = up(existing.targetId) === up(t.id) ? 'reused' : 'recovered';
      Object.assign(existing, { targetId: t.id, lastSeen: nowIso(), lastTitle: t.title, pid: process.pid });
      if (expectPrefix) existing.expectPrefix = expectPrefix;
      if (url && navigate) await navigateJob(endpoint, existing, url);
      else { if (!('lastUrl' in existing)) existing.lastUrl = t.url; saveJob(existing, env); }
      return [existing, how];
    }
  }
  const id = await createTarget(endpoint, url || 'about:blank', { background, newContext });
  const job = rec(id, { url: url || 'about:blank' });
  if (existing || fresh) return [saveJob(job, env), 'created'];
  if (!saveJobExclusive(job, env)) {
    await closeTarget(endpoint, id);   // lost the lockless race: the loser cleans up
    const other = loadJob(name, env);
    if (other) return [other, 'reused'];
    return [saveJob(job, env), 'created'];
  }
  return [job, 'created'];
}

/** The job's tab as it stands now: re-found by fingerprint if its id died, drift warned, expectation enforced. */
export async function resolveJobTarget(endpoint, name, o = {}) {
  const { expectUrl, update = true, quiet = false, create = false, createUrl, source, env = process.env, warn = (s) => process.stderr.write(s) } = o;
  let { targets } = o;
  let job = loadJob(name, env);
  if (!job && create) {
    let how;
    [job, how] = await claimJob(endpoint, name, { url: createUrl, background: true, env });
    warn(`note: no job named; claimed ${job.targetId} (${how}) as job ${name}${source && source !== 'flag' ? ` from $${source}` : ''}\n`);
    targets = null;
  }
  if (!job) throw E(`no such cdp job ${pyRepr(name)}; claim one first: \`tophat-cdp job claim ${name} --url URL\` (live jobs: ${allJobs(env).map((j) => j.job).join(', ') || 'none'})`, 'usage');
  targets ||= await listTargets(endpoint);
  let t = liveById(targets).get(up(job.targetId));
  if (!t) {
    t = refindTarget(job, targets, env);
    if (!t) throw E(`job ${name}: its tab ${job.targetId} (last at ${job.lastUrl}) is gone from the browser and no tab matches its fingerprint; claim it again with \`tophat-cdp job claim ${name} --url ...\``, 'target_not_found');
    warn(`warning: job ${name}: tab ${job.targetId} disappeared; re-bound to ${t.id} by fingerprint ${JSON.stringify(job.lastUrl || job.lastTitle)}\n`);
    job.targetId = t.id;
  }
  const current = t.url || '', prefix = expectUrl || job.expectPrefix, drift = urlDrift(job.lastUrl, current);
  if (prefix && !current.startsWith(prefix)) {
    throw E(`job ${name}: its tab should be on ${prefix} but it is on ${current || 'nothing'}. Another session navigated it; this is the yank the job model exists to catch. Re-claim the job, or drop the expectation with \`tophat-cdp job expect ${name} --clear\`.`, 'hijack');
  }
  if (drift && !quiet) warn(`warning: job ${name}: ${drift}. The job last set ${job.lastUrl}, the tab is now on ${current || 'nothing'}; someone else may be driving it (pass --expect-url PREFIX to make this an error).\n`);
  job.lastSeen = nowIso();
  job.lastTitle = t.title;
  if (update) saveJob(job, env);
  return { target: t, job, drift };
}

export function jobRow(job, targets, ui) {
  const t = liveById(targets).get(up(job.targetId));
  const since = parseStamp(String(job.since || '').slice(0, 19) + nowIso().slice(19));
  const row = { job: job.job, targetId: job.targetId, live: !!t, url: t?.url ?? null, title: t?.title ?? null, expectedUrl: job.lastUrl ?? null,
    expectPrefix: job.expectPrefix ?? null, since: job.since ?? null, ageSeconds: since === null ? null : Math.trunc((Date.now() - since) / 1000),
    pid: job.pid ?? null, pidAlive: pidAlive(job.pid), tool: job.tool ?? null, ephemeral: job.ephemeral ?? false, drift: urlDrift(job.lastUrl, t?.url) };
  if (ui?.[job.job]) row.uiJob = { app: ui[job.job].app ?? null, window: ui[job.job].windowID ?? null, title: ui[job.job].title ?? null };
  return row;
}

/**
 * Every verb's target: `job=NAME` through the registry (drift, expectation, auto-claim), or a raw
 * selector. A mutating action refuses protected targets and tabs another live job owns.
 * opts: {target, expectUrl, steal, force, url, command, jobSource, jobHint}
 */
export async function selectTarget(endpoint, opts, action, { wantTypes, env = process.env, warn } = {}) {
  const spec = opts.target || '';
  let target, job = null;
  if (spec.startsWith('job=')) {
    ({ target, job } = await resolveJobTarget(endpoint, spec.slice(4), { expectUrl: opts.expectUrl, create: true,
      createUrl: opts.command === 'navigate' ? opts.url : undefined, source: opts.jobSource, env, warn }));
  } else {
    if (!spec) throw E('this verb needs a target: a target id/selector, or --job NAME', 'usage');
    target = await resolveTarget(endpoint, spec, wantTypes);
    if (opts.expectUrl && !(target.url || '').startsWith(opts.expectUrl)) throw E(`target ${target.id} is on ${target.url}, not the expected ${opts.expectUrl}`, 'hijack');
  }
  if (action) {
    guardProtected(target, opts, action, env);
    if (!(opts.steal || opts.force)) {
      const owner = targetOwner(await listTargets(endpoint), target.id, job ? job.job : opts.jobHint, allJobs(env));
      if (owner) throw E(`refusing to ${action} ${target.id} (${(target.url || '').slice(0, 70)}): it belongs to job ${owner.job} (pid ${owner.pid}, claimed ${owner.since}). Use \`--job ${owner.job}\`, or pass --steal to take it.`, 'refused');
    }
  }
  return { target, job };
}

// ---- keys -------------------------------------------------------------------------
const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const NAMED_KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9, '\t'], escape: ['Escape', 'Escape', 27, null],
  esc: ['Escape', 'Escape', 27, null], backspace: ['Backspace', 'Backspace', 8, null], delete: ['Delete', 'Delete', 46, null], space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38, null], arrowdown: ['ArrowDown', 'ArrowDown', 40, null], arrowleft: ['ArrowLeft', 'ArrowLeft', 37, null],
  arrowright: ['ArrowRight', 'ArrowRight', 39, null], up: ['ArrowUp', 'ArrowUp', 38, null], down: ['ArrowDown', 'ArrowDown', 40, null],
  left: ['ArrowLeft', 'ArrowLeft', 37, null], right: ['ArrowRight', 'ArrowRight', 39, null], home: ['Home', 'Home', 36, null], end: ['End', 'End', 35, null],
  pageup: ['PageUp', 'PageUp', 33, null], pagedown: ['PageDown', 'PageDown', 34, null],
};
/** 'Shift+Tab' | 'a' | 'Enter' -> [modifiers, key, code, vk, text]. */
export function parseKey(spec) {
  const parts = spec.split('+');
  let mods = 0;
  while (parts.length > 1 && parts[0].toLowerCase() in MODIFIERS) mods |= MODIFIERS[parts.shift().toLowerCase()];
  const name = parts.join('+'), low = name.toLowerCase();
  if (Object.hasOwn(NAMED_KEYS, low)) return [mods, ...NAMED_KEYS[low]];
  if ([...name].length === 1 && name.length <= 2) {
    let ch = name;
    const upper = ch.toUpperCase(), alpha = /^\p{L}$/u.test(ch), digit = /^[0-9]$/.test(ch);
    const code = alpha ? `Key${upper}` : digit ? `Digit${ch}` : '';
    const vk = alpha || digit ? upper.codePointAt(0) : 0;
    if (mods & 8 && alpha) ch = upper;
    return [mods, ch, code, vk, mods & 6 ? null : ch];
  }
  throw E(`unknown key ${pyRepr(spec)}; use a single character or one of: ${Object.keys(NAMED_KEYS).sort().join(', ')}`, 'usage');
}
export async function sendKey(conn, spec) {
  const [modifiers, key, code, vk, text] = parseKey(spec);
  const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (text !== null && [...key].length === 1 && key !== '\r' && key !== '\t') {
    await conn.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    await conn.send('Input.dispatchKeyEvent', { type: 'char', text, key, modifiers });
  } else if (text !== null) await conn.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text, unmodifiedText: text });
  else await conn.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await conn.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
/** Meta+a carrying the selectAll editing command: the only select-all that works inside an OOPIF (gotcha 7). */
export async function sendSelectAll(conn) {
  const base = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 };
  await conn.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown', commands: ['selectAll'] });
  await conn.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
/** CDP modifier bits from a list like 'shift' or 'shift,meta' (Alt=1, Ctrl=2, Meta=4, Shift=8); unknown names throw. */
export function modifierBits(list) {
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
  let m = 0;
  for (const n of String(list || '').toLowerCase().split(/[,+\s]+/).filter(Boolean)) { if (!(n in bits)) throw new Error(`unknown modifier ${n}`); m |= bits[n]; }
  return m;
}
export async function mouseClick(conn, x, y, button = 'left', clicks = 1, modifiers = 0) {
  const base = { x, y, button, clickCount: clicks, modifiers, buttons: button === 'left' ? 1 : 2 };
  await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0, clickCount: 0 });
  await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await conn.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
}

export { Resolver, FRAME_SEP, splitSelector, DEEP, isVirtual } from './frames.mjs';
