// Guest sessions for the public demo: who a visitor is, whether they proved they are a person, how many real turns they
// have used, and what the day has cost. The webchat itself does the isolation (scopes: every guest is an account with its
// own personal scope, and the app's own routes answer only for that scope); this module is the identity service the
// webchat's scope gate asks (`GET /_auth/api/session`, the same contract as the sign-in service it normally asks) and the
// writer of the scope registry that names each guest.
//
// Nothing here talks to a model. The turns themselves are the real runner's; this only decides whether one may start.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ip TEXT NOT NULL, created_at TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ip_turns (day TEXT NOT NULL, ip TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip));
CREATE TABLE IF NOT EXISTS ip_sessions (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip));
CREATE TABLE IF NOT EXISTS day_turns (day TEXT PRIMARY KEY, turns INTEGER NOT NULL DEFAULT 0);
`;

/** The registry file and sign-in domain, from the instance's own scopes config (the one place they are named). */
export function scopeSettings(c) {
  const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  const inst = JSON.parse(readFileSync(c.instance, 'utf8'));
  const scopes = JSON.parse(readFileSync(expand(inst.runner.env.TOPHAT_CONFIG), 'utf8')).scopes;
  return { inst, registryFile: expand(scopes.registryFile), orgDomain: scopes.orgDomain };
}

export const COOKIE_NAME = '__Secure-edge_session';
export const accountOf = (id) => `g${id}`;
export const emailOf = (id, domain) => `g${id}@${domain}`;
export const scopeOf = (id) => `p-g${id}`;

/** The hex id inside a session token (`<id>.<mac>`), or null. */
export const idOfToken = (token) => /^([0-9a-f]{32})\./.exec(String(token || ''))?.[1] || null;

export class Guests {
  /** c: the parsed demo.json; `registryFile` and `orgDomain` come from the instance's own scopes config, never repeated here. */
  constructor(c, { registryFile, orgDomain, costToday = () => 0 }) {
    this.c = c;
    const v = c.visitors || {};
    // every limit lives in demo.json `visitors`, nowhere else: a missing one is a config error, not a silent default
    const need = (k) => { if (typeof v[k] !== 'number') throw new Error(`demo.json visitors.${k} is required`); return v[k]; };
    this.cap = need('turnsPerSession');
    // no per-address limit of any kind: addresses are shared (schools, libraries, offices); the daily spend cap is the backstop
    this.dailyUsd = need('dailyUsd');
    this.usdPerTurn = need('usdPerTurn');
    this.sessionHours = need('sessionHours');
    this.registryFile = registryFile;
    this.orgDomain = orgDomain;
    this.costToday = costToday;
    this.secret = readFileSync(c.sessionSecretFile, 'utf8').trim();
    mkdirSync(path.dirname(c.visitorDb), { recursive: true });
    this.db = new DatabaseSync(c.visitorDb);
    this.db.exec('PRAGMA journal_mode=WAL;' + SCHEMA);
    // a visitors.sqlite from the earlier demo has `sessions` without the check flag
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'verified')) this.db.exec('ALTER TABLE sessions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
    this.writeRegistry();
  }
  day() { return new Date().toISOString().slice(0, 10); }
  ipKey(ip) { return createHash('sha256').update(`${this.secret}\0${ip}`).digest('hex').slice(0, 16); }
  mac(id) { return createHmac('sha256', this.secret).update(id).digest('base64url'); }
  token(id) { return `${id}.${this.mac(id)}`; }

  /** The live session for a cookie value, or null (bad signature, unknown, expired). */
  verify(token) {
    const id = idOfToken(token);
    if (!id) return null;
    const want = this.mac(id), got = String(token).slice(33);
    if (want.length !== got.length || !timingSafeEqual(Buffer.from(want), Buffer.from(got))) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row || Date.parse(row.created_at) < Date.now() - this.sessionHours * 3600_000) return null;
    return row;
  }

  /** A new session, unverified: it may look around; a real turn needs `markVerified`. Opening the site is never limited per address. */
  create(ip) {
    const ipk = this.ipKey(ip);
    const id = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO sessions (id, ip, created_at) VALUES (?,?,?)').run(id, ipk, new Date().toISOString());
    this.writeRegistry();
    return { id, token: this.token(id) };
  }
  markVerified(id) { this.db.prepare('UPDATE sessions SET verified=1 WHERE id=?').run(id); }

  /** The scope registry the webchat reads (it re-reads on change): one account and one personal scope per live session. */
  writeRegistry() {
    const since = new Date(Date.now() - this.sessionHours * 3600_000).toISOString();
    const accounts = {}, scopes = {};
    for (const { id } of this.db.prepare('SELECT id FROM sessions WHERE created_at >= ?').all(since)) {
      accounts[accountOf(id)] = { emails: [emailOf(id, this.orgDomain)], name: 'visitor' };
      scopes[scopeOf(id)] = { kind: 'personal', owner: accountOf(id), label: 'you' };
    }
    const body = JSON.stringify({ version: 1, accounts, scopes });
    if (body === this.lastRegistry) return;
    mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const tmp = `${this.registryFile}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.registryFile);
    this.lastRegistry = body;
  }

  spentToday() { return Math.max(this.costToday(), (this.db.prepare('SELECT turns FROM day_turns WHERE day=?').get(this.day())?.turns ?? 0) * this.usdPerTurn); }
  resting() { return this.spentToday() >= this.dailyUsd; }

  /** One real turn: verified, not resting, under the session and address caps. Counted before it runs, so parallel sends cannot exceed the cap. */
  claimTurn(session) {
    if (!session.verified) return { status: 403, error: 'captcha' };
    if (this.resting()) return { status: 503, error: 'resting' };
    const day = this.day();
    const claimed = this.db.prepare('UPDATE sessions SET turns=turns+1 WHERE id=? AND turns<?').run(session.id, this.cap);
    if (!claimed.changes) return { status: 429, error: 'limit' };
    this.db.prepare('INSERT INTO day_turns (day, turns) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET turns=turns+1').run(day);
    return { ok: true, turns: this.turnsOf(session.id) };
  }
  /** A request that never reached the runner is not a spent turn. */
  refundTurn(session) {
    this.db.prepare('UPDATE sessions SET turns=turns-1 WHERE id=? AND turns>0').run(session.id);
    this.db.prepare('UPDATE day_turns SET turns=turns-1 WHERE day=? AND turns>0').run(this.day());
  }
  turnsOf(id) { return this.db.prepare('SELECT turns FROM sessions WHERE id=?').get(id)?.turns ?? 0; }
}

/** Turnstile: the token from the widget, checked with the secret. */
// No remoteip: behind the edge and the tunnel the address the server sees is not reliably the visitor's, and it is optional.
export async function verifyTurnstile(secret, token) {
  const body = new URLSearchParams({ secret, response: String(token || '') });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  return { ok: Boolean(j.success), codes: j['error-codes'] || [], hostname: j.hostname || '', action: j.action || '', challenge_ts: j.challenge_ts || '' };
}
