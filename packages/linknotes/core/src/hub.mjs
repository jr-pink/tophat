// The hub: one sync peer, append-only. It accepts parts from authenticated devices, assigns the
// global order, and hands each device only the parts its user's groups may read. It stores
// ciphertext and group ids; it never holds a key. There is no delete route.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { CONTROL_TABLES, PolicyError, authorizeControl, canRead, canWrite, controlVisible, normAcl, minimizeCnf, rank, satisfies } from './policy.mjs';
import { hmac, sha256 } from './crypto.mjs';

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS actions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, origin_seq INTEGER NOT NULL, actor TEXT NOT NULL, ts TEXT NOT NULL, parts TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(origin, origin_seq));
CREATE TABLE IF NOT EXISTS devices(device TEXT PRIMARY KEY, user TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS groups(grp TEXT PRIMARY KEY, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(grp TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(grp, user));
CREATE TABLE IF NOT EXISTS emails(email TEXT PRIMARY KEY, user TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS actions_append_only_u BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS actions_append_only_d BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_ACTIONS = 500;

export class HubError extends Error { constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; } }

export function issueToken(secret, { device, user, expiresAt }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('token secret must be at least 32 characters');
  const body = Buffer.from(JSON.stringify({ v: 1, device, user, exp: expiresAt })).toString('base64url');
  return `mc1.${body}.${hmac(secret, body)}`;
}
export function verifyToken(secret, token, now = Date.now()) {
  const m = /^mc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m) throw new HubError(401, 'unauthenticated');
  const want = Buffer.from(hmac(secret, m[1])), got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto_timingSafeEqual(want, got)) throw new HubError(401, 'unauthenticated');
  let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { throw new HubError(401, 'unauthenticated'); }
  if (!p || p.v !== 1 || typeof p.device !== 'string' || typeof p.user !== 'string' || !(p.exp > now / 1000)) throw new HubError(401, 'unauthenticated');
  return p;
}
import { timingSafeEqual as crypto_timingSafeEqual } from 'node:crypto';

// A pull page stops early once this many bytes of parts are in it (the row that crosses it is the last of the page), with
// more=true and next at the last action scanned. A replica and a viewer already follow more/next; a client that ignores
// more still makes progress by pulling again from next. Per-hub override: new Hub(file, { pullMaxBytes }).
export const PULL_MAX_BYTES = 16 * 1024 * 1024;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export class Hub {
  constructor(file, { secret, authSession = null, now = () => new Date().toISOString(), view = null, pullMaxBytes = PULL_MAX_BYTES } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    if (!this.db.prepare('PRAGMA table_info(actions)').all().some((c) => c.name === 'rejected')) this.db.exec('ALTER TABLE actions ADD COLUMN rejected TEXT');
    this.secret = secret; this.authSession = authSession; this.now = now; this.view = view;
    this.pullMaxBytes = Number.isFinite(pullMaxBytes) && pullMaxBytes > 0 ? pullMaxBytes : PULL_MAX_BYTES;
  }
  close() { this.db.close(); }
  one(sql, ...a) { return this.db.prepare(sql).get(...a) ?? null; }
  all(sql, ...a) { return this.db.prepare(sql).all(...a); }
  roleOf(user, grp) { return this.one('SELECT role FROM members WHERE grp=? AND user=?', grp, user)?.role ?? 'none'; }
  state() { return { groupExists: (g) => typeof g === 'string' && Boolean(this.one('SELECT 1 AS ok FROM groups WHERE grp=?', g)), roleOf: (u, g) => (typeof g === 'string' ? this.roleOf(u, g) : 'none') }; }

  /** Validate a whole push before writing any of it; then append in one transaction. */
  push(principal, body) {
    if (!isObj(body) || !Array.isArray(body.actions) || body.actions.length > MAX_ACTIONS) throw new HubError(400, 'bad_request');
    const acks = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let dev = this.one('SELECT * FROM devices WHERE device=?', principal.device);
      if (!dev) { this.db.prepare('INSERT INTO devices(device,user,next_seq) VALUES(?,?,1)').run(principal.device, principal.user); dev = { next_seq: 1 }; }
      if (dev.user && dev.user !== principal.user) throw new HubError(403, 'device_owned_by_another_user');
      let next = dev.next_seq;
      for (const a of body.actions) {
        if (!isObj(a) || typeof a.id !== 'string' || !/^[a-f0-9]{64}$/.test(a.id) || !Number.isSafeInteger(a.origin_seq) || typeof a.ts !== 'string' || !Array.isArray(a.parts) || !a.parts.length) throw new HubError(400, 'bad_action');
        const prior = this.one('SELECT seq, origin, origin_seq, parts, rejected FROM actions WHERE id=?', a.id);
        if (prior) {
          if (prior.origin !== principal.device || prior.origin_seq !== a.origin_seq || (prior.parts !== JSON.stringify(a.parts) && !prior.rejected)) throw new HubError(409, 'action_id_reused');
          acks.push({ id: a.id, seq: prior.seq, duplicate: true, ...(prior.rejected ? { rejected: prior.rejected } : {}) }); continue;
        }
        if (a.origin_seq !== next) throw new HubError(409, 'sequence_gap', { expected: next });
        // A forbidden action is recorded as rejected: it takes its sequence number, carries no parts,
        // and its device learns the reason, so nothing waits on it.
        let rejected = null;
        this.db.exec('SAVEPOINT part');
        try { for (const p of a.parts) this.authorizePart(principal, p); this.db.exec('RELEASE part'); }
        catch (e) { this.db.exec('ROLLBACK TO part'); this.db.exec('RELEASE part'); if (!(e instanceof HubError) || e.status !== 403) throw e; rejected = e.extra.reason || 'forbidden'; }
        const r = this.db.prepare('INSERT INTO actions(id,origin,origin_seq,actor,ts,parts,received_at,rejected) VALUES(?,?,?,?,?,?,?,?)').run(a.id, principal.device, a.origin_seq, principal.user, a.ts, rejected ? '[]' : JSON.stringify(a.parts), this.now(), rejected);
        next += 1;
        acks.push({ id: a.id, seq: Number(r.lastInsertRowid), ...(rejected ? { rejected } : {}) });
      }
      this.db.prepare('UPDATE devices SET next_seq=? WHERE device=?').run(next, principal.device);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { acks };
  }
  authorizePart(principal, p) {
    if (!isObj(p)) throw new HubError(400, 'bad_part');
    const roleOf = (g) => this.roleOf(principal.user, g);
    try {
      if (p.control) {
        if (!isObj(p.control) || !CONTROL_TABLES.includes(p.control.t) || !isObj(p.control.img)) throw new PolicyError('bad control row');
        authorizeControl(this.state(), principal.user, p.control);
        if (p.control.t === 'mc_devices' && p.control.img.device !== principal.device) throw new PolicyError('a device registers only itself');
        this.applyControl(principal.user, p.control);
        return;
      }
      if (!isObj(p.sealed) || !Array.isArray(p.sealed.wraps)) throw new PolicyError('bad sealed part');
      if (p.cnf) {
        if (!Array.isArray(p.cnf)) throw new PolicyError('cnf must be a list of ACLs');
        const cnf = minimizeCnf(p.cnf);
        if (JSON.stringify(cnf) !== JSON.stringify(p.cnf) || !satisfies(roleOf, cnf)) throw new PolicyError('cannot publish for that CNF');
        return;
      }
      const acl = normAcl(p.acl);
      if (JSON.stringify(acl) !== JSON.stringify(p.acl) || !canWrite(roleOf, acl)) throw new PolicyError(`cannot write into ${acl.join(',')}`);
    } catch (e) { if (e instanceof PolicyError) throw new HubError(403, 'forbidden', { reason: e.message }); throw e; }
  }
  applyControl(actor, { t, img }) {
    if (t === 'mc_groups' && !this.one('SELECT 1 AS ok FROM groups WHERE grp=?', img.grp)) {
      this.db.prepare('INSERT INTO groups(grp,created_by) VALUES(?,?)').run(img.grp, actor);
      this.db.prepare("INSERT INTO members(grp,user,role) VALUES(?,?,'admin') ON CONFLICT(grp,user) DO UPDATE SET role='admin'").run(img.grp, actor);
    } else if (t === 'mc_members') this.db.prepare('INSERT INTO members(grp,user,role) VALUES(?,?,?) ON CONFLICT(grp,user) DO UPDATE SET role=excluded.role').run(img.grp, img.user, img.role);
  }
  /** Parts after `after` this device may read, in hub order; `next` covers everything scanned. A page holds at least one scanned row and stops before the next once pullMaxBytes of other devices' parts are in it. */
  pull(principal, after, limit = 200) {
    after = Math.max(0, Number.parseInt(after, 10) || 0); limit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 200));
    const rows = this.all('SELECT * FROM actions WHERE seq>? ORDER BY seq LIMIT ?', after, limit);
    const roleOf = (g) => this.roleOf(principal.user, g);
    const out = [];
    let bytes = 0, scanned = 0;
    for (const r of rows) {
      if (scanned > 0 && bytes >= this.pullMaxBytes) break; // byte cap: stop before this row, the replica asks again
      scanned += 1;
      const parts = JSON.parse(r.parts).map((p, index) => ({ ...p, index })).filter((p) => this.visible(p, { user: principal.user, device: principal.device, roleOf }));
      if (parts.length || r.origin === principal.device) {
        if (r.origin !== principal.device) bytes += Buffer.byteLength(r.parts);
        out.push({ seq: r.seq, id: r.id, origin: r.origin, origin_seq: r.origin_seq, actor: r.actor, ts: r.ts, parts: r.origin === principal.device ? [] : parts, ...(r.rejected && r.origin === principal.device ? { rejected: r.rejected } : {}) });
      }
    }
    const cut = scanned < rows.length;
    return { actions: out, next: scanned ? rows[scanned - 1].seq : after, more: cut || rows.length === limit };
  }
  visible(p, who) {
    if (p.control) return controlVisible(p.control, who);
    if (p.cnf) return satisfies(who.roleOf, p.cnf);
    return Array.isArray(p.acl) && canRead(who.roleOf, p.acl);
  }
  /** A human with an the configured auth service session enrolls a device and gets its token. */
  async enroll(cookie, body) {
    if (!this.authSession) throw new HubError(404, 'not_found');
    const who = await this.authSession(cookie);
    if (!who?.email) throw new HubError(401, 'unauthenticated');
    const user = this.one('SELECT user FROM emails WHERE email=?', String(who.email).toLowerCase())?.user;
    if (!user) throw new HubError(403, 'no_user_for_email');
    if (!isObj(body) || typeof body.device !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(body.device)) throw new HubError(400, 'bad_device');
    const owner = this.one('SELECT user FROM devices WHERE device=?', body.device)?.user;
    if (owner && owner !== user) throw new HubError(409, 'device_taken');
    return { user, device: body.device, token: issueToken(this.secret, { device: body.device, user, expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 }) };
  }
  /** The signed-in person: who they are here, their groups and roles, their devices, the log head. */
  async me(cookie) {
    if (!this.authSession) throw new HubError(404, 'not_found');
    const who = await this.authSession(cookie);
    if (!who?.email) throw new HubError(401, 'unauthenticated');
    const email = String(who.email).toLowerCase();
    const user = this.one('SELECT user FROM emails WHERE email=?', email)?.user;
    if (!user) throw new HubError(403, 'no_user_for_email', { email });
    const groups = this.db.prepare('SELECT grp AS "group", role FROM members WHERE user=? ORDER BY grp').all(user).map((r) => ({ ...r }));
    const devices = this.db.prepare('SELECT device, next_seq - 1 AS pushed FROM devices WHERE user=? ORDER BY device').all(user).map((r) => ({ ...r }));
    return { email, user, groups, devices, head: this.one('SELECT MAX(seq) AS n FROM actions')?.n ?? 0 };
  }
  bindEmail(email, user) { this.db.prepare('INSERT INTO emails(email,user) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET user=excluded.user').run(String(email).toLowerCase(), user); }

  /** HTTP surface. GET /graph, /graph/*, /e/<id> (the optional View over a replica), GET /healthz, GET / and /v1/me (signed-in person), POST /v1/push, GET /v1/pull, POST /v1/enroll. Nothing else, no delete. */
  async handle(method, url, headers, rawBody) {
    try {
      let u; try { u = new URL(url, 'http://hub'); } catch { throw new HubError(400, 'bad_url'); }
      if (this.view && this.view.owns(u.pathname)) return await this.view.handle(method, u, headers); // [status, body, headers]: session-gated inside
      if (method === 'GET' && u.pathname === '/healthz') return [200, { ok: true, service: 'tophat-hub', head: this.one('SELECT MAX(seq) AS n FROM actions')?.n ?? 0 }];
      if (method === 'GET' && (u.pathname === '/' || u.pathname === '/v1/me')) return [200, await this.me(headers.cookie || '')];
      if (u.pathname === '/v1/enroll') { if (method !== 'POST') throw new HubError(405, 'method_not_allowed'); return [200, await this.enroll(headers.cookie || '', parse(rawBody))]; }
      const principal = verifyToken(this.secret, String(headers.authorization || '').replace(/^Bearer /, ''));
      if (u.pathname === '/v1/push') { if (method !== 'POST') throw new HubError(405, 'method_not_allowed'); return [200, this.push(principal, parse(rawBody))]; }
      if (u.pathname === '/v1/pull') { if (method !== 'GET') throw new HubError(405, 'method_not_allowed'); return [200, this.pull(principal, u.searchParams.get('after'), u.searchParams.get('limit'))]; }
      throw new HubError(404, 'not_found');
    } catch (e) {
      if (e instanceof HubError) return [e.status, { error: e.code, ...e.extra }];
      return [500, { error: 'internal_error' }];
    }
  }
  listen(port, host = '127.0.0.1') {
    const server = http.createServer((req, res) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } chunks.push(c); });
      req.on('end', async () => {
        const [status, out, hdrs] = await this.handle(req.method, req.url, req.headers, Buffer.concat(chunks).toString());
        if (hdrs) { res.writeHead(status, hdrs); res.end(req.method === 'HEAD' ? undefined : out); return; }
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(out));
      });
    });
    return new Promise((r) => server.listen(port, host, () => r(server)));
  }
}
function parse(s) { try { return JSON.parse(s || 'null'); } catch { throw new HubError(400, 'bad_json'); } }
export { sha256 };
