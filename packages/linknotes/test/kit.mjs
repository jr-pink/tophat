// Test support: a real hub over HTTP on a free port and sqlite replicas wired to it, all in temp directories removed at
// exit. A user may run several replicas (devices); each is its own file and device key, syncing through the hub, which
// holds ciphertext only. Never touches any live store.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub, issueToken } from '../core/src/hub.mjs';
import { httpTransport } from '../core/src/sync.mjs';
import { SqliteBackend } from '../src/sqlite.mjs';
import { METHODS } from '../src/interface.mjs';

export const SECRET = 'linknotes-test-secret-at-least-32-characters';
const dirs = new Set();
process.once('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
export const tmp = (p = 'linknotes-') => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.add(d); return d; };
const token = (device, user) => issueToken(SECRET, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

/** A world: one hub, and makers for sqlite replicas wired to it over HTTP. */
export async function world() {
  const dir = tmp();
  const hubFile = path.join(dir, 'hub.sqlite');
  const hub = new Hub(hubFile, { secret: SECRET });
  const hubServer = await hub.listen(0);
  const hubUrl = `http://127.0.0.1:${hubServer.address().port}`;
  const closers = [async () => { await new Promise((r) => hubServer.close(r)); hub.close(); }];
  const w = {
    dir, hub, hubFile, hubUrl,
    /** A replica of `user` on `device` (default `<user>-laptop`, file `<user>.sqlite`; another device gets its own file). */
    sqlite(user, { device = `${user}-laptop`, writeScopes = [user], screens = [] } = {}) {
      const base = device === `${user}-laptop` ? user : device;
      const b = new SqliteBackend({ file: path.join(dir, `${base}.sqlite`), keyFile: path.join(dir, `${base}.key.json`), user, device, writeScopes, screens },
        { transport: httpTransport(hubUrl, token(device, user)) });
      closers.push(() => b.close());
      return b;
    },
    /** A second replica of the same user as `of` (same scopes and screens, a new device). */
    replica(of, device = `${of.config.user}-phone`) {
      return w.sqlite(of.config.user, { device, writeScopes: of.config.writeScopes, screens: of.config.screens });
    },
    async close() { for (const c of closers.reverse()) await c(); },
  };
  return w;
}

/** Sync everyone a few rounds (control rows, then key wraps, then data). */
export async function settle(...stores) { for (let i = 0; i < 3; i++) for (const s of stores) await s.sync(); }

const READS = new Set(['search', 'read', 'entity', 'page', 'pageNodes', 'scopes', 'pending']);
/**
 * A MemoryStore that writes through `origin` and checks every read against `replica` (another device of the same user)
 * after both have synced through the hub: the same call must give the same result on both, except a page's `cached`
 * flag (each replica keeps its own page cache). Returns the origin's result, so a conformance suite runs on it unchanged.
 */
export function mirror(origin, replica) {
  let dirty = true;
  const m = { backend: origin.backend, origin, replica, checked: 0 };
  for (const k of METHODS) {
    m[k] = async (...args) => {
      if (k === 'whoami') return origin.whoami();
      if (k === 'sync') { const r = await origin.sync(); dirty = true; return r; }
      if (!READS.has(k)) { dirty = true; return origin[k](...args); }
      if (dirty) { await settle(origin, replica); dirty = false; }
      const run = (s) => s[k](...args).then((v) => ({ v }), (e) => ({ e }));
      const [ra, rb] = [await run(origin), await run(replica)];
      const what = `${k}(${JSON.stringify(args)})`;
      if (ra.e || rb.e) {
        assert.equal(rb.e?.constructor.name, ra.e?.constructor.name, `${what}: origin ${ra.e ? 'threw ' + ra.e.message : 'answered'}, replica ${rb.e ? 'threw ' + rb.e.message : 'answered'}`);
        assert.equal(rb.e.message, ra.e.message, `${what}: different errors on the origin and its replica`);
        m.checked++;
        throw ra.e;
      }
      const [a, b] = [ra.v, rb.v];
      const strip = (x) => (k === 'page' ? { ...x, cached: null } : x);
      assert.deepEqual(strip(b), strip(a), `${what} differs between the origin and its replica after hub sync`);
      m.checked++;
      return a;
    };
  }
  m.close = async () => {};
  return m;
}
