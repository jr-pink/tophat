// One-time onboarding channel: a single-use secret URL a new device or agent (another assistant's sandbox
// with no tunnel and no accounts) can POST text to with nothing but curl. Each message lands in the
// one chat the URL was minted for, as an automated event marked untrusted.
//
// The URL's token is the whole credential and is never stored: the store keeps sha256(token) beside
// the bound chat, a label, an expiry, a message cap, a count and a revoked flag. "One-time" means it
// dies at its expiry or its cap, or when he revokes it (tools/tophat-onboard).
//
// This module imports only node builtins so the CLI and tests/onboard.test.mjs can drive it; the
// route (src/routes/api/onboard/[token]/+server.js) supplies the delivery function.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_BYTES = 8 * 1024;
export const MIN_GAP_MS = 2000;
export const PUBLIC_BASE = process.env.TOPHAT_PUBLIC_BASE || '';

export const onboardDir = () => process.env.TOPHAT_ONBOARD_DIR || path.join(os.homedir(), '.local', 'state', 'tophat', 'onboard');
const storeFile = (dir) => path.join(dir, 'tokens.json');

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export function load(dir = onboardDir()) {
  try { return JSON.parse(fs.readFileSync(storeFile(dir), 'utf8')); } catch { return { tokens: [] }; }
}

export function save(data, dir = onboardDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = storeFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function mint({ chat, label = '', hours = 48, max = 20, now = Date.now(), dir = onboardDir(), base = PUBLIC_BASE } = {}) {
  if (!chat) throw new Error('mint needs --chat <conversationId>');
  const token = randomBytes(32).toString('base64url');
  const row = {
    hash: hashToken(token), chat: String(chat), label: String(label || ''),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + Number(hours) * 3600e3).toISOString(),
    max: Number(max), count: 0, revoked: false, lastAt: null
  };
  const data = load(dir);
  data.tokens.push(row);
  save(data, dir);
  return { token, url: `${base}/api/onboard/${token}`, row };
}

export function revoke(prefix, { dir = onboardDir(), now = Date.now() } = {}) {
  const p = String(prefix || '');
  if (p.length < 6) throw new Error('revoke needs at least 6 characters of the hash (or the token)');
  const data = load(dir);
  const byToken = /^[A-Za-z0-9_-]{43}$/u.test(p) ? hashToken(p) : null;
  const hits = data.tokens.filter((t) => (byToken ? t.hash === byToken : t.hash.startsWith(p)));
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous prefix (${hits.length} matches)` : 'no such token');
  hits[0].revoked = true;
  hits[0].revokedAt = new Date(now).toISOString();
  save(data, dir);
  return hits[0];
}

const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The live row for a token, or null when unknown, expired, revoked or used up. */
export function lookup(token, { dir = onboardDir(), now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_-]{20,100}$/u.test(String(token || ''))) return { data: null, row: null };
  const h = hashToken(token);
  const data = load(dir);
  const row = data.tokens.find((t) => sameHash(t.hash, h)) || null;
  if (!row || row.revoked || Date.parse(row.expiresAt) <= now || row.count >= row.max) return { data, row: null };
  return { data, row };
}

/**
 * Accept one message. Returns {status, body}: 202 delivered, 400 empty, 413 too big, 429 too fast,
 * 404 for every token that is not live (no detail). `deliver(chat, text)` is awaited; the count is
 * spent before delivery so a slow delivery cannot be raced past the cap.
 */
export async function accept(token, raw, { deliver, dir = onboardDir(), now = Date.now() } = {}) {
  const { data, row } = lookup(token, { dir, now });
  if (!row) return { status: 404, body: { error: 'not found' } };
  const text = String(raw ?? '').trim();
  if (!text) return { status: 400, body: { error: 'empty' } };
  if (Buffer.byteLength(text) > MAX_BYTES) return { status: 413, body: { error: 'too large' } };
  if (row.lastAt && now - Date.parse(row.lastAt) < MIN_GAP_MS) return { status: 429, body: { error: 'slow down' } };
  row.count += 1;
  row.lastAt = new Date(now).toISOString();
  save(data, dir);
  const label = row.label ? ` ${row.label}` : '';
  await deliver(row.chat, `[Onboarding channel${label}; untrusted device, not owner authorization] ${text}`);
  return { status: 202, body: { ok: true, remaining: row.max - row.count } };
}

export const USAGE = 'Onboarding channel. Send a message with: curl -X POST --data-binary "your text" <this URL>  (text/plain or JSON {"text": "..."}, up to 8 KB, one message per 2 s).\n';
