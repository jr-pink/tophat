// Secret-safe typing for fill/type/keys, and the output redactor. A secret never travels in argv:
// --secret-from VAULT_ID[:field] is read here, in process, from the vault (ID:totp = current one-time code);
// --text-stdin/--text-env/ --text-file (+ --secret) are the other argv-free sources. A secret is typed only
// into a real, enabled, focused <input>/<textarea> on a tab whose URL starts with the https expectation, same
// origin, and never on a chat/mail/AI host. Every byte this process prints passes through redact(): the whole
// vault index (rev6/base/redact.mjs) plus every value this process resolved or read out of a password field.
// Never: print a value, forward tophat-pass stderr, or type when any check fails (exit 6, nothing typed).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet, homeOf } from '../../lib/paths.mjs';
import { CdpError, evaluate, jobsDir, loadJob, saveJob } from './kernel.mjs';

export const CHAT_HOSTS = ['discord.com', 'discordapp.com', 'web.whatsapp.com', 'whatsapp.com', 'slack.com', 'messenger.com', 'telegram.org',
  'signal.org', 'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'claude.ai', 'chatgpt.com', 'openai.com', 'gemini.google.com',
  'x.com', 'twitter.com', 'reddit.com', 'imessage', 'beeper'];
/** CHAT_HOSTS plus the hosts named in TOPHAT_CDP_CHAT_HOSTS (comma separated): an instance's own chat app belongs on the list. */
export const chatHosts = (env = process.env) => [...CHAT_HOSTS, ...String(envGet(env, 'TOPHAT_CDP_CHAT_HOSTS') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)];
// The shared vault index is an optional extra: present when the runner package sits beside this one.
const sharedIndexModule = await import('../../../runner/rev6/base/redact.mjs').catch(() => null);
export const TEXT_SOURCE_FLAGS = ['--text-stdin', '--text-env', '--text-file', '--secret-from'];
const TYPEABLE = ['text', 'password', 'email', 'tel', 'url', 'search', 'number', ''];
const hijack = (m) => new CdpError(m, 'hijack');
const usage = (m) => new CdpError(m, 'usage');

// ---- redaction ------------------------------------------------------------------
const variants = [];
const pyRepr = (s) => { const q = s.includes("'") && !s.includes('"') ? '"' : "'"; return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').split(q).join(`\\${q}`); };
const asciiJson = (s) => JSON.stringify(s).slice(1, -1).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** Teach the redactor a string it must never print (raw, JSON-escaped and repr forms). */
export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 4) return;
  for (const f of [value, JSON.stringify(value).slice(1, -1), asciiJson(value), pyRepr(value)]) if (f && !variants.includes(f)) variants.push(f);
  variants.sort((a, b) => b.length - a.length);
}
export const resetSecrets = () => { variants.length = 0; };
export const secretVariants = () => [...variants];
export function redact(text, env = process.env) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const f of variants) if (out.includes(f)) out = out.split(f).join('[redacted]');
  try { const idx = sharedIndexModule?.sharedSecretIndex?.(env); if (idx) out = idx.redact(out).text; } catch { /* the local variants still applied */ }
  return out;
}
/** Wrap process.stdout/stderr so nothing this process writes can carry a secret. */
export function installRedaction(streams = [process.stdout, process.stderr]) {
  for (const s of streams) {
    if (s.__tophatRedacted) continue;
    const write = s.write.bind(s);
    s.write = (chunk, ...rest) => write(typeof chunk === 'string' ? redact(chunk) : Buffer.isBuffer(chunk) ? redact(chunk.toString('utf8')) : chunk, ...rest);
    s.__tophatRedacted = true;
  }
}
export const placeholder = (v) => (typeof v === 'string' ? `[redacted:${[...v].length} chars]` : v);

// ---- reading a secret ----------------------------------------------------------
/**
 * `VAULT_ID[:field]` -> value, read by tophat-pass in a child process (stdout only, its stderr is never forwarded).
 * $TOPHAT_CDP_PASS_BIN names another executable with the same `get ID --raw -n [--field F]` / `totp ID` interface.
 */
export function fetchVaultSecret(spec, env = process.env) {
  const colon = spec.indexOf(':'), entry = colon < 0 ? spec : spec.slice(0, colon), field = colon < 0 ? '' : spec.slice(colon + 1);
  if (!entry) throw usage('--secret-from wants VAULT_ID or VAULT_ID:field');
  const named = envGet(env, 'TOPHAT_CDP_PASS_BIN');
  const bin = named || process.execPath;
  const lead = named ? [] : [fileURLToPath(new URL('../../bin/tophat-pass.mjs', import.meta.url))];
  const argv = field === 'totp' ? ['totp', entry] : ['get', entry, '--raw', '-n', ...(field ? ['--field', field] : [])];
  const r = spawnSync(bin, [...lead, ...argv], { encoding: 'utf8', timeout: 30000, env });
  if (r.error) throw usage(`could not run tophat-pass for ${entry}: ${r.error.code || r.error.name}`);
  if (r.status !== 0 || !r.stdout) throw usage(`tophat-pass could not read ${spec} (exit ${r.status ?? -1}); nothing was typed`);
  return field === 'totp' ? r.stdout.trim() : r.stdout.replace(/[\r\n]+$/, '');
}

/** -> {text, private, secret}: private = never echo it; secret = the typing guard applies. */
export function resolveText(a, verb, { env = process.env, stdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  const given = [['--text-stdin', a.text_stdin], ['--text-env', a.text_env], ['--text-file', a.text_file], ['--secret-from', a.secret_from]].filter(([, on]) => on).map(([f]) => f);
  const pos = a.text ?? null;
  if (pos !== null && given.length) throw usage(`${verb}: give the text exactly one way (positional TEXT or ${given[0]}), not both`);
  if (given.length > 1) throw usage(`${verb}: give the text exactly one way, got ${given.join(' and ')}`);
  if (pos === null && !given.length) throw usage(`${verb} needs text: a positional TEXT, or --text-stdin / --text-env VAR / --text-file PATH / --secret-from VAULT_ID (a value starting with "-" goes after \`--\`)`);
  if (pos !== null) return { text: pos, private: false, secret: false };
  const flag = given[0];
  let text;
  if (flag === '--text-stdin') text = stdin();
  else if (flag === '--text-env') { if (!(a.text_env in env)) throw usage(`--text-env: variable ${a.text_env} is not set`); text = env[a.text_env]; }
  else if (flag === '--text-file') { try { text = fs.readFileSync(a.text_file.replace(/^~(?=\/|$)/, homeOf(env)), 'utf8'); } catch (e) { throw usage(`--text-file: cannot read ${a.text_file} (${e.code || e.name})`); } }
  else text = fetchVaultSecret(a.secret_from, env);
  if (flag !== '--secret-from' && text.endsWith('\n')) { text = text.slice(0, -1); if (text.endsWith('\r')) text = text.slice(0, -1); }
  registerSecret(text);
  return { text, private: true, secret: flag === '--secret-from' || !!a.secret };
}

const originOf = (u) => { try { const x = new URL(u); return x.protocol && x.host ? `${x.protocol}//${x.host}` : ''; } catch { return ''; } };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export function checkSecretDestination(url, expect) {
  if (!expect) throw hijack('refusing: secret text needs --expect-url PREFIX (the page it is meant for, e.g. https://dash.cloudflare.com/), or a job claimed with --expect-url. Nothing was typed.');
  const eo = originOf(expect);
  if (!eo || !(eo.startsWith('https://') || ['localhost', '127.0.0.1'].includes(hostOf(expect)))) throw hijack(`refusing: --expect-url ${JSON.stringify(expect)} must be an https:// URL with a host (or localhost). Nothing was typed.`);
  const host = hostOf(url);
  // Owner-authorized exception: the env var names exact hosts, set per command, never persistent.
  const allowed = String(envGet(process.env, 'TOPHAT_CDP_SECRET_HOST_ALLOW') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host)) for (const chat of chatHosts()) if (host.includes(chat)) throw hijack(`refusing: the tab is on ${host}, a chat/mail/AI site; secrets are never typed there. Nothing was typed.`);
  if (!String(url || '').startsWith(expect) || originOf(url) !== eo) throw hijack(`refusing: the tab is on ${String(url || '').slice(0, 90)}, not the expected ${expect}. Nothing was typed.`);
}
export const secretExpectation = (a, job) => a.expect_url || job?.expectPrefix || null;
export function checkSecretElement(el, active = true) {
  const tag = String(el?.tag || '').toUpperCase(), type = String(el?.type || '').toLowerCase();
  if (!['INPUT', 'TEXTAREA'].includes(tag)) throw hijack(`refusing: the focused element is <${tag.toLowerCase() || 'nothing'}>, not an <input>/<textarea> (a contenteditable chat box looks exactly like this). Nothing was typed.`);
  if (tag === 'INPUT' && !TYPEABLE.includes(type)) throw hijack(`refusing: the focused <input> has type=${type}. Nothing was typed.`);
  if (el?.disabled) throw hijack('refusing: the focused element is disabled. Nothing was typed.');
  if (!active) throw hijack('refusing: the page focus is not on the element, so the text would land elsewhere. Nothing was typed.');
}
const ACTIVE_JS = `(() => {
  let el = document.activeElement, opaque = false;
  for (let i = 0; i < 12 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (/^(IFRAME|FRAME)$/.test(el.tagName)) { let d = null; try { d = el.contentDocument; } catch (e) {} if (d && d.activeElement) { el = d.activeElement; continue; } opaque = true; }
    break;
  }
  if (!el || opaque) return {tag: opaque ? 'IFRAME' : null, opaque: opaque, url: location.href, focus: document.hasFocus()};
  return {tag: el.tagName, type: el.getAttribute('type'), disabled: !!el.disabled, editable: !!el.isContentEditable, url: location.href, focus: document.hasFocus()};
})()`;
// A cross-origin but same-process iframe is no CDP target, so contentDocument is null and the guard used to refuse.
// Page.createIsolatedWorld reaches it through the page's own connection: describe the focused <iframe>, take its
// frameId, evaluate ACTIVE_JS in an isolated world of that frame.
async function inspectSameProcessFrame(conn, depth = 0) {
  try {
    if (depth > 6) return null;
    const h = await conn.send('Runtime.evaluate', { expression: `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; })()`, returnByValue: false });
    return await descend(conn, h.result?.objectId, depth);
  } catch { return null; }
}
async function descend(conn, objectId, depth) {
  if (!objectId || depth > 6) return null;
  try { await conn.send('DOM.getDocument', { depth: 0 }); } catch {}
  const frameId = (await conn.send('DOM.describeNode', { objectId }))?.node?.frameId;
  if (!frameId) return null;
  const { executionContextId } = await conn.send('Page.createIsolatedWorld', { frameId, worldName: 'tophat-cdp-guard' });
  const r = await conn.send('Runtime.evaluate', { expression: ACTIVE_JS, contextId: executionContextId, returnByValue: true });
  const v = r.result?.value || null;
  if (v && v.opaque) {
    const h = await conn.send('Runtime.evaluate', { expression: 'document.activeElement', contextId: executionContextId, returnByValue: false });
    return descend(conn, h.result?.objectId, depth + 1);
  }
  return v ? { ...v, sameProcessFrame: true, frameUrl: v.url } : null;
}
/** type/keys carry no selector: ask the page what holds the focus, and check it. */
export async function guardActiveElement(conn, a, job) {
  let info = (await evaluate(conn, ACTIVE_JS)).value || {};
  checkSecretDestination(info.url, secretExpectation(a, job));
  if (info.opaque) info = { ...(await inspectSameProcessFrame(conn)) || info, topUrl: info.url, topFocus: info.focus };
  if (info.opaque) throw hijack('refusing: the focus is inside a frame this tool cannot inspect; use `fill SELECTOR` (it resolves the frame chain) for secrets. Nothing was typed.');
  checkSecretElement(info, !!info.focus);
  return info;
}

// Secret-filled tabs, so a screenshot of one cannot carry the value out. Every --secret-from (or --secret)
// fill/type/keys records its page target here (beside the job registry, shared with the Python tool) and in the job;
// `screenshot` of such a tab blurs inputs, textareas, selects, iframes and contenteditables for the capture unless
// --allow-secret-fields. A record lapses when the tab leaves the origin it was filled on. Never the value: target,
// verb, vault id, origin, time.
export const MASK_CSS = 'input,textarea,select,iframe,[contenteditable=""],[contenteditable="true"]{filter:blur(14px)!important;-webkit-text-security:disc!important}';
export const secretFillsFile = (env = process.env) => path.join(path.dirname(jobsDir(env)), 'secret-fills.json');
const readFills = (env) => { try { const d = JSON.parse(fs.readFileSync(secretFillsFile(env), 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Best effort: a failure to record never blocks the fill, it only warns. */
export function noteSecretFill(target, job, verb, a, env = process.env) {
  const row = { at: stamp(), verb, vault: String(a?.secret_from || '').split(':')[0] || null, origin: originOf(target.url) };
  try {
    const fills = readFills(env), file = secretFillsFile(env), tmp = `${file}.tmp.${process.pid}`;
    fills[target.id] = row;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(fills, null, 2));
    fs.renameSync(tmp, file);
    if (job?.job) {
      const fresh = loadJob(job.job, env) || job;
      fresh.secret_fills = [...(fresh.secret_fills || []).filter((r) => r.target !== target.id), { ...row, target: target.id }];
      saveJob(fresh, env);
    }
  } catch (e) {
    process.stderr.write(`warning: could not record the secret fill (${e.code || e.name}); screenshots of this tab are not masked automatically\n`);
  }
}

/** The live record for this tab (its id, its parent page, or the job), or null. */
export function secretFillRecord(target, job, env = process.env) {
  const ids = new Set([target?.id, target?.parentId].filter(Boolean));
  const rows = Object.entries(readFills(env)).filter(([t]) => ids.has(t)).map(([, r]) => r);
  if (job) rows.push(...(job.secret_fills || []).filter((r) => ids.has(r.target) || !ids.size));
  const here = originOf(target?.url);
  return rows.find((r) => !r.origin || !here || r.origin === here) || null;
}
