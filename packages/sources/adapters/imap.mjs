// IMAP mail with an XOAUTH2 token (default host outlook.office365.com for Microsoft 365 / Exchange Online; config.host for
// another). The token store (config.storeFile, JSON {upn, access_token, expires_at, refresh_token, client_id?, scope?}) is
// refreshed under a lock file and replaced by rename keeping every key: each refresh rotates the refresh token, and a
// lost write loses the grant. invalid_grant is a dead grant: ReauthRequired (a human signs in again). The default client
// id is Thunderbird's public one, which tenants that refuse Microsoft first-party ids accept. Read-only: EXAMINE and
// BODY.PEEK only. Folders, the sent folder and the owner's addresses are config. Ported from an upstream adapter (VENDOR.json `ported`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fail, sha } from '../lib/common.mjs';

export const HOST = 'outlook.office365.com';
export const CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
export const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const DEFAULT_SCOPE = ['IMAP.AccessAsUser.All', 'SMTP.Send', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'].map((s) => `https://outlook.office.com/${s}`).concat('offline_access').join(' ');
export const DEFAULT_FOLDERS = ['Archive', 'INBOX', 'Sent Items'];
export const storeFile = (env = process.env) => env.LINKNOTES_IMAP_TOKEN_STORE || null; // config.storeFile names it; no default location
export class ReauthRequired extends Error { constructor(detail) { super(`imap: ${detail}`); this.name = 'ReauthRequired'; this.code = 'imap-reauth-required'; } }

// ---- token store ----
const readStore = (file) => { if (!file || !fs.existsSync(file)) throw new ReauthRequired(`no credential at ${file || '(config.storeFile unset)'}; sign in with the OAuth device-code flow and save the token store there`); return JSON.parse(fs.readFileSync(file, 'utf8')); };
function writeStore(file, patch) {
  const next = { ...(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}), ...patch };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600); fs.writeSync(fd, JSON.stringify(next, null, 1)); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, file);
  return next;
}
async function withLock(file, fn) {
  const lock = `${file}.lock`, until = Date.now() + 30000;
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
      if (age > 60000) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > until) throw new Error(`timed out waiting for ${lock}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}
/** A token valid for 5 more minutes, refreshed and persisted under the lock when needed. */
export async function accessToken({ file = storeFile(), fetch: fetcher = globalThis.fetch, force = false } = {}) {
  const fresh = (s) => !force && s.access_token && Date.now() < (s.expires_at || 0) - 300000;
  let s = readStore(file); if (fresh(s)) return { token: s.access_token, upn: s.upn };
  return withLock(file, async () => {
    s = readStore(file); if (fresh(s)) return { token: s.access_token, upn: s.upn };
    if (!s.refresh_token) throw new ReauthRequired('the stored grant has no refresh token; sign in again (device-code flow)');
    const res = await fetcher(`${AUTHORITY}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ client_id: s.client_id || CLIENT_ID, grant_type: 'refresh_token', refresh_token: s.refresh_token, scope: (s.scope ? `${s.scope} offline_access` : DEFAULT_SCOPE).replace(/\s+/g, ' ').trim() }).toString() });
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) {
      const err = String(j.error || 'unknown'), desc = String(j.error_description || '').split('\n')[0];
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(err)) throw new ReauthRequired(`${err}: ${desc}. Sign in again with the device-code flow`);
      throw new Error(`token refresh failed (${err}): ${desc}`);
    }
    const n = writeStore(file, { account: 'imap', upn: s.upn || null, client_id: s.client_id || CLIENT_ID, access_token: j.access_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120000, refresh_token: j.refresh_token || s.refresh_token, scope: j.scope || s.scope || DEFAULT_SCOPE, saved_at: new Date().toISOString() });
    return { token: n.access_token, upn: n.upn };
  });
}

// ---- IMAP ----
const CRLF = '\r\n';
export class ImapError extends Error { constructor(m, kind = 'imap-error') { super(m); this.kind = kind; } }
/** One logical response (literals folded in) off the front of a buffer, or null when incomplete. */
export function takeLine(buf) {
  let scan = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', scan, 'latin1'); if (nl === -1) return null;
    const lit = /\{(\d+)\+?\}$/.exec(buf.toString('latin1', scan, nl));
    if (!lit) return { line: buf.subarray(0, nl + 2), rest: buf.subarray(nl + 2) };
    if (buf.length < nl + 2 + Number(lit[1])) return null; scan = nl + 2 + Number(lit[1]);
  }
}
export function splitLiterals(line) {
  const s = line.toString('latin1'), literals = []; let i = 0, plain = '';
  for (;;) {
    const m = /\{(\d+)\+?\}\r\n/.exec(s.slice(i)); if (!m) { plain += s.slice(i); break; }
    const at = i + m.index, start = at + m[0].length; plain += s.slice(i, at); literals.push(line.subarray(start, start + Number(m[1]))); i = start + Number(m[1]);
  }
  return { plain, literals };
}
export const quote = (s) => `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
export function compactSet(uids) {
  const s = [...uids].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; parts.push(i === j ? String(s[i]) : `${s[i]}:${s[j]}`); i = j + 1; }
  return parts.join(',');
}
/** Minimal IMAP4rev1 over any duplex (TLS by default): serialized tagged commands. */
export class Imap {
  constructor({ socket, timeoutMs = 45000 }) { Object.assign(this, { socket, timeoutMs, buf: Buffer.alloc(0), tag: 0, lines: [], waiter: null, closed: null, queue: Promise.resolve() });
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); for (let g; (g = takeLine(this.buf));) { this.buf = g.rest; this.lines.push(g.line); } this.pump(); });
    socket.on('error', (e) => this.die(new ImapError(`socket: ${e.message}`, 'imap-unreachable'))); socket.on('close', () => this.die(new ImapError('connection closed', 'imap-closed'))); }
  die(e) { this.closed ??= e; if (this.waiter) { const w = this.waiter; this.waiter = null; w.no(e); } }
  pump() { while (this.lines.length && this.waiter) this.waiter.on(this.lines.shift()); }
  wait(on) { return new Promise((ok, no) => { if (this.closed) return no(this.closed);
    const t = setTimeout(() => this.die(new ImapError(`timed out after ${this.timeoutMs}ms`, 'imap-timeout')), this.timeoutMs);
    const end = (f) => (v) => { clearTimeout(t); this.waiter = null; f(v); };
    this.waiter = { no: end(no), on: (l) => { try { on(l, end(ok), end(no)); } catch (e) { end(no)(e); } } }; this.pump(); }); }
  async greet() { await this.wait((l, ok) => { if (/^\* (OK|PREAUTH)/.test(l.toString('latin1'))) ok(); }); return this; }
  cmd(command) {
    const run = () => { const tag = `A${String(++this.tag).padStart(4, '0')}`, untagged = [];
      const p = this.wait((line, ok, no) => { const t = line.toString('latin1');
        if (t.startsWith(`${tag} `)) { const st = t.slice(tag.length + 1).split(' ')[0].toUpperCase();
          return st === 'OK' ? ok({ untagged }) : no(new ImapError(`${command.split(' ')[0]} ${st}: ${t.slice(tag.length + 1).trim()}`, st === 'NO' ? 'imap-no' : 'imap-bad')); }
        if (t.startsWith('+')) return this.socket.write(CRLF);
        untagged.push(line); });
      this.socket.write(`${tag} ${command}${CRLF}`); return p; };
    const p = this.queue.then(run, run); this.queue = p.catch(() => {}); return p;
  }
  async login(user, token) {
    try { await this.cmd(`AUTHENTICATE XOAUTH2 ${Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString('base64')}`); }
    catch (e) { if (e.kind === 'imap-no' || e.kind === 'imap-bad') throw new ImapError(`XOAUTH2 rejected: ${e.message}`, 'imap-auth-failed'); throw e; }
  }
  async examine(folder) {
    const t = (await this.cmd(`EXAMINE ${quote(folder)}`)).untagged.map((l) => l.toString('latin1')).join('\n');
    return { folder, uidvalidity: Number(/UIDVALIDITY (\d+)/i.exec(t)?.[1] || 0), exists: Number(/^\* (\d+) EXISTS/im.exec(t)?.[1] || 0) };
  }
  async uidSearch(criteria) {
    const l = (await this.cmd(`UID SEARCH ${criteria}`)).untagged.map((x) => x.toString('latin1')).find((x) => /^\* SEARCH/i.test(x));
    return l ? l.trim().split(/\s+/).slice(2).map(Number).filter(Number.isFinite) : [];
  }
  async uidFetch(uids, item, { batch = 200 } = {}) {
    const out = [];
    for (let i = 0; i < uids.length; i += batch) for (const line of (await this.cmd(`UID FETCH ${compactSet(uids.slice(i, i + batch))} (UID INTERNALDATE RFC822.SIZE ${item})`)).untagged) {
      if (!/ FETCH /i.test(line.toString('latin1'))) continue;
      const { plain, literals } = splitLiterals(line), uid = Number(/UID (\d+)/.exec(plain)?.[1] || 0);
      if (uid) out.push({ uid, size: Number(/RFC822\.SIZE (\d+)/.exec(plain)?.[1] || 0), internaldate: /INTERNALDATE "([^"]+)"/.exec(plain)?.[1] || null, data: literals[0] || Buffer.alloc(0) });
    }
    return out;
  }
  async logout() { try { await this.cmd('LOGOUT'); } catch { /* fine */ } try { this.socket.destroy(); } catch { /* gone */ } }
}

// ---- RFC 822 ----
const charset = (bytes, cs) => { const c = String(cs || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  if (/utf-?8/.test(c)) return bytes.toString('utf8'); if (/(iso-8859-1|windows-1252|us-ascii|latin1)/.test(c)) return bytes.toString('latin1');
  try { return new TextDecoder(c).decode(bytes); } catch { return bytes.toString('utf8'); } };
const hexq = (s) => s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const qp = (s) => hexq(s.replace(/=\r?\n/g, ''));
export function decodeWords(v) {
  if (!v || !v.includes('=?')) return v || '';
  return v.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s*(?==\?))?/g, (_, cs, enc, t) => { try {
    return charset(enc.toLowerCase() === 'b' ? Buffer.from(t, 'base64') : Buffer.from(hexq(t.replace(/_/g, ' ')), 'latin1'), cs); } catch { return t; } });
}
export function parseHeaders(raw) {
  const h = {};
  for (const line of raw.toString('latin1').replace(/\r\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s?(.*)$/.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = decodeWords(m[2]); h[k] = h[k] ? `${h[k]}, ${v}` : v;
  }
  return h;
}
const blank = (b) => { const i = b.indexOf('\r\n\r\n', 0, 'latin1'); if (i !== -1) return { at: i, end: i + 4 }; const j = b.indexOf('\n\n', 0, 'latin1'); return j !== -1 ? { at: j, end: j + 2 } : { at: b.length, end: b.length }; };
const param = (v, n) => { const m = new RegExp(`${n}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(v || ''); return m ? (m[2] !== undefined ? m[2] : m[1]) : null; };
const binary = (body, enc) => { const e = String(enc || '7bit').toLowerCase();
  if (e === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  return e === 'quoted-printable' ? Buffer.from(qp(body.toString('latin1')), 'latin1') : Buffer.from(body); };
export const htmlToText = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
function walk(h, body, out, depth = 0) {
  const ct = (h['content-type'] || 'text/plain').trim(), mime = ct.split(';')[0].trim().toLowerCase();
  const filename = param(h['content-disposition'] || '', 'filename') || param(ct, 'name');
  const boundary = param(ct, 'boundary');
  if (mime.startsWith('multipart/') && depth < 10 && boundary) {
    const s = body.toString('latin1'), marker = `--${boundary}`;
    for (let idx = s.indexOf(marker); idx !== -1;) {
      const start = s.indexOf('\n', idx) + 1; if (s.startsWith('--', idx + marker.length)) break;
      const nx = s.indexOf(marker, start), chunk = body.subarray(start, Math.max(start, (nx === -1 ? s.length : nx) - 2)), sep = blank(chunk);
      walk(parseHeaders(chunk.subarray(0, sep.at)), chunk.subarray(sep.end), out, depth + 1);
      if (nx === -1) break; idx = nx;
    }
    return;
  }
  const isText = mime.startsWith('text/') && !filename, data = binary(body, h['content-transfer-encoding']);
  out.push({ type: mime, filename: filename ? decodeWords(filename) : null, bytes: body.length, text: isText ? charset(data, param(ct, 'charset')) : '', data: isText ? null : data });
}
/** Headers, a text body (text/plain, else HTML as text), the raw HTML and attachments with decoded bytes. */
export function parseMessage(buf) {
  const sep = blank(buf), headers = parseHeaders(buf.subarray(0, sep.at)), parts = [];
  walk(headers, buf.subarray(sep.end), parts);
  const text = parts.find((p) => p.type === 'text/plain' && !p.filename), html = parts.find((p) => p.type === 'text/html' && !p.filename);
  return { headers, body: text ? text.text : (html ? htmlToText(html.text) : ''), html: html ? html.text : '', bodyKind: text ? 'text/plain' : (html ? 'text/html' : 'none'),
    attachments: parts.filter((p) => p.filename).map((p) => ({ name: p.filename, contentType: p.type, bytes: p.bytes, data: p.data || null })) };
}

// ---- search syntax (from: to: subject: body: text: since: before: folder: larger: smaller:, bare words AND) ----
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function tokenize(q) { const out = []; let cur = '', inQ = false;
  for (const ch of String(q || '')) { if (ch === '"') { inQ = !inQ; cur += ch; continue; } if (!inQ && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; } cur += ch; }
  if (cur) out.push(cur); return out; }
const unq = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
export function buildSearch(text) {
  const keys = [], folders = [];
  for (const tok of tokenize(text)) {
    const m = tok.startsWith('"') ? null : /^(-?)(from|to|subject|body|text|since|before|folder|in|larger|smaller):(.*)$/i.exec(tok);
    if (!m) { const w = unq(tok); if (w) keys.push(`OR OR SUBJECT ${quote(w)} FROM ${quote(w)} BODY ${quote(w)}`); continue; }
    const f = m[2].toLowerCase(), v = unq(m[3]);
    if (f === 'folder' || f === 'in') { folders.push(v); continue; }
    const date = () => { const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()); if (!d) fail('bad-date'); return `${d[3]}-${MONTHS[Number(d[2]) - 1]}-${d[1]}`; };
    const key = { from: `FROM ${quote(v)}`, to: `TO ${quote(v)}`, subject: `SUBJECT ${quote(v)}`, body: `BODY ${quote(v)}`, text: `TEXT ${quote(v)}`,
      larger: `LARGER ${Number(v) || 0}`, smaller: `SMALLER ${Number(v) || 0}` }[f] ?? (f === 'since' ? `SINCE ${date()}` : `BEFORE ${date()}`);
    keys.push(m[1] ? `NOT ${key}` : key);
  }
  return { criteria: keys.length ? keys.join(' ') : 'ALL', folders: folders.length ? folders : DEFAULT_FOLDERS };
}

// ---- sessions ----
/** Open an authenticated session; `connect` lets tests hand in a scripted duplex. */
export async function open({ file, fetch: fetcher, host = HOST, connect = () => tls.connect({ host, port: 993, servername: host }) } = {}) {
  const { token, upn } = await accessToken({ file, fetch: fetcher });
  const imap = new Imap({ socket: connect() });
  try { await imap.greet(); await imap.login(upn, token); } catch (e) {
    imap.socket.destroy?.();
    if (e.kind === 'imap-auth-failed') throw new ReauthRequired(`${HOST} refused the XOAUTH2 token. Sign in again with the device-code flow`);
    throw e;
  }
  return imap;
}
export const messageId = (folder, uidvalidity, uid) => `${folder}:${uidvalidity}:${uid}`;
export function parseMessageId(id) {
  const p = String(id).split(':'), uid = Number(p.pop()), uidvalidity = Number(p.pop()), folder = p.join(':');
  if (!folder || !Number.isFinite(uid) || !Number.isFinite(uidvalidity)) fail('bad-message-id'); return { folder, uidvalidity, uid };
}
const HEADER_ITEM = 'BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID LIST-ID)]';
const sortKey = (h, internal) => Date.parse(h.date || '') || Date.parse(String(internal || '').replace(/^(\d{2})-(\w{3})-(\d{4}) /, '$1 $2 $3 ')) || 0;

export async function search(query, { limit = 50, session = open, ...o } = {}) {
  const { criteria, folders } = buildSearch(query), imap = await session(o), found = [];
  try {
    for (const folder of folders) {
      const info = await imap.examine(folder), uids = (await imap.uidSearch(criteria)).sort((a, b) => b - a).slice(0, limit);
      for (const m of uids.length ? await imap.uidFetch(uids, HEADER_ITEM) : []) {
        const h = parseHeaders(m.data);
        found.push({ id: messageId(folder, info.uidvalidity, m.uid), folder, uid: m.uid, date: h.date || m.internaldate || '', sortKey: sortKey(h, m.internaldate),
          from: h.from || '', to: h.to || '', cc: h.cc || '', subject: h.subject || '', messageId: h['message-id'] || '', bytes: m.size });
      }
    }
  } finally { await imap.logout(); }
  return { criteria, messages: found.sort((a, b) => b.sortKey - a.sortKey).slice(0, limit).map(({ sortKey: _, ...m }) => m) };
}
async function fetchOne(imap, id) {
  const { folder, uidvalidity, uid } = parseMessageId(id), info = await imap.examine(folder);
  if (info.uidvalidity !== uidvalidity) fail('uidvalidity-changed');
  const got = await imap.uidFetch([uid], 'BODY.PEEK[]', { batch: 1 }); if (!got.length) fail('not-found');
  return { folder, uid, info, got: got[0], parsed: parseMessage(got[0].data) };
}
export async function read(id, { session = open, ...o } = {}) {
  const imap = await session(o);
  try { const { folder, uid, info, got, parsed: p } = await fetchOne(imap, id), h = p.headers;
    return { id: messageId(folder, info.uidvalidity, uid), folder, uid, date: h.date || got.internaldate || '', from: h.from || '', to: h.to || '', cc: h.cc || '',
      subject: decodeWords(h.subject || ''), messageId: h['message-id'] || '', bytes: got.size, bodyKind: p.bodyKind, body: p.body.slice(0, 200000), html: p.html,
      attachments: p.attachments.map(({ name, contentType, bytes }) => ({ name, contentType, bytes })) };
  } finally { await imap.logout(); }
}
export async function attachments(id, { session = open, ...o } = {}) {
  const imap = await session(o);
  try { return (await fetchOne(imap, id)).parsed.attachments; } finally { await imap.logout(); }
}

/** One message as a record (id folder:uidvalidity:uid; sent = the sent folder or a From in ownerAddresses). */
export function toRecord({ folder, uidvalidity, uid, internaldate, size, data }, { sentFolder = 'Sent Items', ownerAddresses = [] } = {}) {
  const p = parseMessage(data), h = p.headers, id = messageId(folder, uidvalidity, uid);
  const when = Date.parse(h.date || '') || sortKey({}, internaldate); if (!when) return null;
  const from = String(h.from || '').trim(), mid = /<[^>\s]+>/.exec(h['message-id'] || '')?.[0]?.slice(1, -1) || id;
  const text = `Subject: ${String(h.subject || '').trim()}\nFrom: ${from}\n${String(p.body || '').slice(0, 200000)}`;
  return { id, revision: sha(text), occurredAt: new Date(when).toISOString(), threadId: (String(h.references || '').match(/<[^>\s]+>/) || /<[^>\s]+>/.exec(h['in-reply-to'] || '') || [`<${mid}>`])[0].slice(1, -1), text,
    metadata: { type: 'imap-mail', direction: folder === sentFolder || ownerAddresses.some((a) => from.toLowerCase().includes(String(a).toLowerCase())) ? 'sent' : 'received', sender: from, to: h.to || '', cc: h.cc || '',
      nativeMessageId: mid, folder, uidvalidity, uid, bodyKind: p.bodyKind, bytes: size, attachments: p.attachments.map(({ name, contentType, bytes }) => ({ name, contentType, bytes })) } };
}

/** New mail above maxUid, then the backfill below minUid newest-first; a moved UIDVALIDITY re-reads that folder. */
export async function poll(source, { cursor = null, session = open, ...o } = {}) {
  const c = source.config ?? {}, batch = c.batchSize ?? 100, folders = c.folders ?? [...DEFAULT_FOLDERS, ...(cursor?.folders ? Object.keys(cursor.folders).filter((f) => !DEFAULT_FOLDERS.includes(f)) : [])];
  const { ownerAddresses: _oa, ...so } = o;
  const imap = await session({ file: c.storeFile, ...(c.host ? { host: c.host } : {}), ...so }), next = { ...(cursor?.folders ?? {}) }, records = [];
  let budget = batch, complete = true;
  try {
    for (const folder of folders) {
      const info = await imap.examine(folder), prior = next[folder]?.uidvalidity === info.uidvalidity ? next[folder] : null;
      const uids = (await imap.uidSearch('ALL')).sort((a, b) => a - b), top = uids.at(-1) ?? 0;
      const state = prior ?? { uidvalidity: info.uidvalidity, maxUid: top, minUid: null };
      const newer = uids.filter((u) => u > state.maxUid), older = uids.filter((u) => (state.minUid == null ? u <= state.maxUid : u < state.minUid)).reverse();
      const take = [...newer.slice(0, budget), ...older.slice(0, Math.max(0, budget - newer.length))];
      budget -= take.length; if (take.length < newer.length + older.length) complete = false;
      for (const m of take.length ? await imap.uidFetch(take, 'BODY.PEEK[]', { batch: 25 }) : []) { const r = toRecord({ folder, uidvalidity: info.uidvalidity, ...m }, { sentFolder: c.sentFolder ?? 'Sent Items', ownerAddresses: [...(c.ownerAddresses ?? []), ...(o.ownerAddresses ?? [])] }); if (r) records.push(r); }
      const readNew = take.filter((u) => u > state.maxUid), readOld = take.filter((u) => u <= state.maxUid);
      next[folder] = { uidvalidity: info.uidvalidity, maxUid: Math.max(state.maxUid, ...readNew), minUid: readOld.length ? Math.min(...readOld) : (state.minUid ?? (older.length ? state.maxUid + 1 : 0)) };
    }
  } finally { await imap.logout(); }
  return { records, cursor: { folders: next }, complete, health: { status: 'ok', coverage: 'imap-folders' } };
}
