// Gmail: poll (ingest), search, read, attachment and modify (labels/archive). One OAuth path: the account's token JSON
// (config.credential: a secret name, or config.credentialFile: an absolute path) plus the desktop OAuth client file
// (config.clientFile), refreshed in memory only, so a rotated refresh token is never written back over a file another
// client owns. Accounts are configuration: one source entry per mailbox (sources config), nothing in code.
// One rate-limit cooldown per mailbox shared by every process (../lib/gmail-cooldown.mjs).
// Records carry metadata {type, direction, sender, labels} from ./gmail-direction.mjs. modify is the only write and is
// never called by poll. Ported from an upstream adapter (VENDOR.json `ported`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecret } from '../lib/secrets.mjs';
import { transportCode } from '../lib/http.mjs';
import { fail, isoOrFail, result, sha } from '../lib/common.mjs';
import { gmailMetadata } from './gmail-direction.mjs';
import { gmailCooldownUntil, setGmailCooldown } from '../lib/gmail-cooldown.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const COOLDOWN_MS = 15 * 60 * 1000;

// ---- shared cooldown ----
export const cooldownFile = ({ stateDir, env = process.env } = {}) =>
  env.LINKNOTES_GMAIL_COOLDOWN_FILE || path.join(stateDir || path.join(os.homedir(), '.local/state/linknotes'), 'automation', 'gmail-cooldown.json');
// Delegates to ../lib/gmail-cooldown.mjs, the one implementation.
export function cooldownUntil(key, { file, now = Date.now() } = {}) { return gmailCooldownUntil(key, { file, now }); }
/** When a 429 says to come back: Gmail's body names the instant; else Retry-After (seconds or a date); else 15 minutes. */
export function retryAtFrom(header, body, now = Date.now()) {
  const named = String(body || '').match(/Retry after (\d{4}-\d\d-\d\dT[0-9:.]+Z)/);
  if (named && Number.isFinite(Date.parse(named[1]))) return new Date(Date.parse(named[1])).toISOString();
  if (header) {
    const s = Number(header);
    if (Number.isFinite(s) && s >= 0) return new Date(now + s * 1000).toISOString();
    if (Number.isFinite(Date.parse(header))) return new Date(Date.parse(header)).toISOString();
  }
  return new Date(now + COOLDOWN_MS).toISOString();
}
/** Open or extend a window (escalating, never shortening one another process recorded); the shared module owns the rule. Never throws. */
export function setCooldown(key, until, { file, now = Date.now() } = {}) { return setGmailCooldown(key, until, { file, now }); }

// ---- auth ----
const readRef = async (ref, readCredential) => {
  if (readCredential) return readCredential(ref);
  if (typeof ref === 'string' && path.isAbsolute(ref)) { try { return fs.readFileSync(ref, 'utf8').trim(); } catch { fail('credential-unavailable'); } }
  const v = ref ? readSecret(String(ref)) : null; if (!v) fail(ref ? 'credential-unavailable' : 'credential-required'); return v;
};
/** An access token for the source's account: the stored one if fresh, else a refresh grant (in memory only). */
export async function accessToken(c, { fetch: fetcher = globalThis.fetch, readCredential } = {}) {
  let token;
  try { token = JSON.parse(await readRef(c.credential || c.credentialFile, readCredential)); } catch (e) { if (e.code) throw e; fail('invalid-credential-format'); }
  if (token.access_token && (!token.expiry_date || token.expiry_date > Date.now() + 60000)) return token.access_token;
  if (!token.refresh_token || !c.clientFile) fail('authorization-required');
  let client; try { const d = JSON.parse(await readRef(c.clientFile, readCredential)); client = d.installed || d.web || d; } catch { fail('invalid-client-format'); }
  let res;
  try { res = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(20000),
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, client_secret: client.client_secret }) }); }
  catch (e) { fail(transportCode(e)); }
  let j = {}; try { j = await res.json(); } catch { /* status below */ }
  // invalid_grant is a revoked grant or a disabled account: a human re-consents, a retry cannot fix it.
  if (!res.ok || !j.access_token) fail(j.error ? `oauth-${j.error}` : res.ok ? 'authorization-required' : `http-${res.status}`, { status: res.status, oauthError: j.error || null });
  return j.access_token;
}

/** One Gmail call under the cooldown: refused inside a window without a request; a 429 opens it. */
export function client(source, { fetch: fetcher = globalThis.fetch, readCredential, stateDir, env = process.env } = {}) {
  const c = source.config || {}, key = source.id || sha(String(c.credentialFile || c.credential || 'gmail')).slice(0, 16);
  const file = cooldownFile({ stateDir, env });
  let token = null;
  return async function call(pathAndQuery, { method = 'GET', body, raw = false } = {}) {
    const cooling = cooldownUntil(key, { file });
    if (cooling) fail('http-429', { retryAt: cooling, cooldown: true });
    token ??= await accessToken(c, { fetch: fetcher, readCredential });
    let res;
    try { res = await fetcher(`${API}/${pathAndQuery}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { fail(transportCode(e)); }
    if (res.status === 429) {
      const retryAt = retryAtFrom(res.headers?.get?.('retry-after'), await res.text().catch(() => ''));
      setCooldown(key, retryAt, { file }); fail('http-429', { retryAt });
    }
    if (!res.ok) fail([401, 403].includes(res.status) ? 'authorization-required' : `http-${res.status}`);
    return raw ? res : res.json();
  };
}

// ---- payload text ----
const b64 = (d) => Buffer.from(String(d || ''), 'base64url').toString('utf8');
/** Plane-A body: every text/plain part, depth first (the ingest's text; snippet when none). */
export function gmailText(part) {
  const plain = part?.mimeType === 'text/plain' && part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  return [plain, ...(part?.parts || []).map(gmailText)].filter(Boolean).join('\n');
}
/** Reader body: text/plain parts, else the HTML reduced to text (rev5 mail_read's rule). */
export function bodyText(payload) {
  const plain = [], html = [];
  const walk = (p) => { if (!p) return; if (p.mimeType === 'text/plain' && p.body?.data) plain.push(b64(p.body.data)); else if (p.mimeType === 'text/html' && p.body?.data) html.push(b64(p.body.data)); for (const q of p.parts || []) walk(q); };
  walk(payload);
  if (plain.length) return plain.join('\n');
  return html.join('\n').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}
/** Attachment parts: a filename, or an attachment body that is not the text body. */
export function attachmentParts(payload) {
  const out = [];
  const walk = (p, d = 0) => { if (!p || typeof p !== 'object' || d > 20 || out.length >= 100) return;
    if (p.filename || (p.body?.attachmentId && !['text/plain', 'text/html'].includes(p.mimeType))) out.push(p); for (const q of p.parts || []) walk(q, d + 1); };
  walk(payload); return out;
}
const header = (mail, name) => (mail.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';

// ---- poll ----
/** Newest page always (minus ids the last poll saw), plus the stored historical page; cursor {pageToken, recent}. */
export async function poll(source, { cursor = null, limit, ...ctx } = {}) {
  const call = client(source, ctx), c = source.config || {};
  const q = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(100, Number(limit) || 100))) });
  if (c.query) q.set('q', c.query);
  if (cursor?.pageToken) q.set('pageToken', cursor.pageToken);
  const listing = await call(`messages?${q}`);
  const freshQ = new URLSearchParams(q); freshQ.delete('pageToken');
  const fresh = cursor?.pageToken ? await call(`messages?${freshQ}`) : listing;
  const seen = new Set(cursor?.pageToken && Array.isArray(cursor.recent) ? cursor.recent : []);
  const items = [...new Map([...(fresh.messages || []).filter((i) => !seen.has(i.id)), ...(listing.messages || [])].map((i) => [i.id, i])).values()];
  const records = [];
  for (const item of items) {
    const mail = await call(`messages/${encodeURIComponent(item.id)}?format=full`);
    records.push({ id: mail.id, revision: String(mail.historyId || mail.id), threadId: mail.threadId, occurredAt: isoOrFail(Number(mail.internalDate)),
      text: `Subject: ${header(mail, 'subject')}\nFrom: ${header(mail, 'from')}\n${gmailText(mail.payload) || mail.snippet || ''}`,
      metadata: gmailMetadata(mail, header(mail, 'from'), source, { ownerAddresses: ctx.ownerAddresses }) });
  }
  const next = { pageToken: listing.nextPageToken || null };
  if (next.pageToken) next.recent = (fresh.messages || []).map((i) => i.id);
  return result(records, next, !listing.nextPageToken);
}

// ---- tools ----
/** Gmail query syntax; one page of ids with headers and snippet, newest first. */
export async function search(source, query, { limit = 10, pageToken, ...ctx } = {}) {
  const call = client(source, ctx);
  const q = new URLSearchParams({ q: String(query || ''), maxResults: String(Math.min(Math.max(Number(limit) || 10, 1), 100)) });
  if (pageToken) q.set('pageToken', pageToken);
  const list = await call(`messages?${q}`), messages = [];
  for (const { id } of list.messages || []) {
    const m = await call(`messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
    messages.push({ id: m.id, threadId: m.threadId, date: isoOrFail(Number(m.internalDate)), from: header(m, 'from'), to: header(m, 'to'), subject: header(m, 'subject'), snippet: m.snippet || '', labels: m.labelIds || [] });
  }
  return { messages, nextPageToken: list.nextPageToken || null, truncated: Boolean(list.nextPageToken), estimate: list.resultSizeEstimate ?? null };
}
export async function read(source, id, ctx = {}) {
  const m = await client(source, ctx)(`messages/${encodeURIComponent(id)}?format=full`);
  return { id: m.id, threadId: m.threadId, date: isoOrFail(Number(m.internalDate)), from: header(m, 'from'), to: header(m, 'to'), cc: header(m, 'cc'), subject: header(m, 'subject'),
    messageId: header(m, 'message-id'), labels: m.labelIds || [], body: bodyText(m.payload),
    attachments: attachmentParts(m.payload).map((p) => ({ name: p.filename || null, mimeType: p.mimeType, size: p.body?.size ?? null, attachmentId: p.body?.attachmentId ?? null })) };
}
/** One attachment's bytes. */
export async function attachment(source, messageId, attachmentId, ctx = {}) {
  const a = await client(source, ctx)(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  return Buffer.from(String(a.data || ''), 'base64url');
}
/** Labels and archive (archive = remove INBOX). The only write in this module. */
export async function modify(source, id, { add = [], remove = [] } = {}, ctx = {}) {
  if (!add.length && !remove.length) fail('nothing-to-modify');
  return client(source, ctx)(`messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
}

