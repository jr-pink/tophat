// @tophat-md/viewer, the Node side: everything here only prepares or serves; no plaintext of the memory passes through it.
//   viewerAssets()      the built static files (assets/), served at /graph by any HTTP host (the hub, an edge worker)
//   hubView(opts)       a `view` for the linknotes Hub: GET /graph, /graph/<asset>, /e/<id> answer the static app, nothing else
//   exportKeys(opts)    a passphrase-sealed key file from a replica the user already runs (its scope keys, optionally its device key)
//   enrollDevice(opts)  register a fresh viewer device key with the hub (one control row); scope admins wrap keys to it at their next sync
// The browser app (assets/app.js) holds the keys, pulls the ciphertext log, decrypts, replays and draws.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeKeyFile } from './core/keys.mjs';

export { ViewState, tokenClaims, outlinePage, PAGE_PROMPT } from './core/state.mjs';
export { buildGraph, entityPage, plainGraph } from './core/graph.mjs';
export { pullInto, hubHead } from './core/pull.mjs';
export { readKeyFile, writeKeyFile } from './core/keys.mjs';

export const ASSETS = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'assets');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };

/** { '/graph/app.js': { body, type, etag } ... } plus '/graph' for index.html. Throws when the bundle has not been built. */
export function viewerAssets(dir = ASSETS) {
  if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`no viewer bundle in ${dir}: run node packages/viewer/scripts/build.mjs`);
  const out = {};
  for (const f of readdirSync(dir)) {
    const ext = path.extname(f);
    if (!TYPES[ext]) continue;
    const body = readFileSync(path.join(dir, f));
    out[f === 'index.html' ? '/graph' : `/graph/${f}`] = { body, type: TYPES[ext], etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
  }
  return out;
}

/** The security headers of the app page: scripts and workers only from itself, network only to the hub (connect-src). */
export function pageHeaders(hubOrigin = null) {
  const connect = hubOrigin ? `'self' ${hubOrigin}` : "'self'";
  return { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` };
}

/**
 * A view for `new Hub(file, { view: hubView() })`: the hub serves the static app and nothing else under these paths.
 * hubUrl: when the app should pull from another origin than the one serving it (written into the page and its CSP).
 */
export function hubView({ dir = ASSETS, hubUrl = null } = {}) {
  let assets = null;
  const load = () => (assets ??= viewerAssets(dir));
  const hubOrigin = hubUrl ? new URL(hubUrl).origin : null;
  return {
    owns: (p) => p === '/graph' || p === '/graph/' || p.startsWith('/graph/') || p.startsWith('/e/'),
    async handle(method, u) {
      if (method !== 'GET' && method !== 'HEAD') return [405, JSON.stringify({ error: 'method_not_allowed' }), { 'content-type': 'application/json' }];
      const a = load();
      const p = u.pathname === '/graph/' || u.pathname.startsWith('/e/') ? '/graph' : u.pathname;
      const hit = a[p];
      if (!hit) return [404, JSON.stringify({ error: 'not_found' }), { 'content-type': 'application/json' }];
      if (p === '/graph') {
        const html = hit.body.toString('utf8').replace('<meta name="th-hub" content="">', `<meta name="th-hub" content="${hubOrigin ? hubOrigin.replace(/"/g, '') : ''}">`);
        return [200, html, { 'content-type': hit.type, ...pageHeaders(hubOrigin) }];
      }
      return [200, hit.body, { 'content-type': hit.type, 'cache-control': 'no-cache', etag: hit.etag, 'x-content-type-options': 'nosniff' }];
    },
  };
}

/** The device key file a linknotes replica keeps beside its store. */
const deviceKeyFile = (config) => config.keyFile || `${config.file}.device-key.json`;

/**
 * A key file from a replica: config is a linknotes sqlite config ({ file, user, device, keyFile? }); scopes limits which scope
 * keys go in (default: every scope key the replica holds); withDeviceKey adds the replica's device key (then the viewer must
 * pull with that device's token's user, and it can unwrap later epochs). Returns the sealed box (write it to a 0600 file).
 */
export async function exportKeys({ config, passphrase, scopes = null, withDeviceKey = false, iterations }) {
  if (!config?.file || !config?.user) throw new Error('exportKeys needs a linknotes config with file and user');
  const db = new DatabaseSync(config.file, { readOnly: true });
  let rows, member;
  try {
    rows = db.prepare('SELECT grp, epoch, key FROM mc_keys ORDER BY grp, epoch').all();
    member = new Set(db.prepare("SELECT grp FROM mc_members WHERE user=? AND role<>'none'").all(config.user).map((r) => r.grp));
  } finally { db.close(); }
  const want = scopes ? new Set(scopes) : null;
  const out = {};
  for (const r of rows) {
    if (want ? !want.has(r.grp) : !member.has(r.grp)) continue;
    (out[r.grp] ??= {})[r.epoch] = r.key;
  }
  if (want) for (const s of want) if (!out[s]) throw new Error(`this replica holds no key for scope ${s}`);
  const payload = { user: config.user, scopes: out, exported_at: new Date().toISOString() };
  if (withDeviceKey) {
    const k = JSON.parse(readFileSync(deviceKeyFile(config), 'utf8'));
    Object.assign(payload, { keyDevice: config.device, devicePrivateKey: k.privateKey });
  }
  return writeKeyFile(payload, passphrase, iterations ? { iterations } : {});
}

/**
 * Register a fresh device key for a viewer device with the hub, using that device's own hub token (issued by the hub
 * operator for a device id no replica uses). One control row, the same one a replica pushes at its first sync. Returns
 * the sealed key file (device key, plus `scopes` keys when given, e.g. from exportKeys' payload).
 */
export async function enrollDevice({ hubUrl, token, user, device, passphrase, scopes = {}, iterations, fetch = globalThis.fetch }) {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const ts = new Date().toISOString();
  const rows = [{ t: 'mc_devices', pk: device, img: { device, user, public_key: pub }, control: true }];
  const id = createHash('sha256').update(`${device}\0${1}\0${ts}\0${JSON.stringify({ rows })}`).digest('hex');
  const r = await fetch(hubUrl.replace(/\/$/, '') + '/v1/push', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ actions: [{ id, origin_seq: 1, ts, parts: [{ control: { t: 'mc_devices', pk: device, img: { device, user, public_key: pub } } }] }] }) });
  const body = await r.json();
  if (!r.ok) throw new Error(`hub ${r.status} ${body.error}${body.error === 'sequence_gap' ? ': this device id has pushed before; enroll a fresh device id' : ''}`);
  if (body.acks?.[0]?.rejected) throw new Error(`hub rejected the registration: ${body.acks[0].rejected}`);
  return writeKeyFile({ user, scopes, keyDevice: device, devicePrivateKey: priv, exported_at: ts }, passphrase, iterations ? { iterations } : {});
}
