// First-run setup of a local instance, a headless chat turn, and the memory graph on loopback.
//   setup({ name, ... })  dependencies, the webchat build, the instance file, the model key copied into its keyring, start
//   chat({ configFile, text })  one turn through the running webchat, as its owner, printed back
//   graph({ configFile, port })  a plaintext snapshot of the instance's own replica, served with the viewer on 127.0.0.1
// Nothing here prints a credential: a key is read from a file or an environment variable and written 0600 into the
// instance's keyring directory; output names paths only.
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE, check, loadManifest } from './components.mjs';
import { instanceEnv, loadInstance } from './instance.mjs';

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const KEY_NAME = 'anthropic-api-key';
const WORKSPACE_ID_NAME = 'anthropic-workspace-id';
const tilde = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export const defaultConfigFile = (name) => path.join(os.homedir(), '.config/tophat', name, 'tophat.instance.json');

function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
}

const resolvable = (dep) => [path.join(WORKSPACE, 'node_modules', dep), path.join(WORKSPACE, 'packages/webchat/node_modules', dep)].some((d) => existsSync(path.join(d, 'package.json')));
export const appDepsInstalled = () => ['@sveltejs/kit', 'svelte', 'vite', 'linkedom'].every(resolvable);
export const webchatBuilt = () => existsSync(path.join(WORKSPACE, 'packages/webchat/build/handler.js'));

function run(cmd, args, log) {
  log(`$ ${cmd} ${args.join(' ')}   (in ${WORKSPACE})`);
  const r = spawnSync(cmd, args, { cwd: WORKSPACE, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

/** Copy a secret from a file or an environment variable into the keyring directory, 0600. Returns where it came from. */
function placeSecret({ file, envName, dest }) {
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.tmp`;
  if (file) {
    const src = path.resolve(tilde(file));
    if (!existsSync(src)) throw new Error(`no such file: ${src}`);
    copyFileSync(src, tmp);
  } else {
    const v = process.env[envName];
    if (!v) return null;
    writeFileSync(tmp, `${v.trim()}\n`, { mode: 0o600 });
  }
  chmodSync(tmp, 0o600);
  if (!readFileSync(tmp, 'utf8').trim()) { rmSync(tmp, { force: true }); throw new Error(`the secret in ${file ?? `$${envName}`} is empty`); }
  renameSync(tmp, dest);
  return file ? `file ${path.resolve(tilde(file))}` : `$${envName}`;
}

/**
 * Set up (or re-check) one local instance. Idempotent: an existing instance file is kept unless `force`; the key is
 * (re)placed only when a source is given; install and build run only when missing.
 */
export async function setup(o = {}, log = (s) => console.error(s)) {
  const name = o.name || 'me';
  if (!NAME_RE.test(name)) throw new Error(`--name ${name}: lower case letters, digits and dashes, starting with a letter`);
  if (!nodeOk()) throw new Error(`Node ${process.versions.node}: tophat needs Node 22.13 or newer`);
  const steps = [];

  if (!appDepsInstalled()) {
    if (o.install === false) steps.push('npm dependencies missing and --no-install given: the instance cannot start until `npm install` has run');
    else { run('npm', ['install', '--no-audit', '--no-fund'], log); steps.push('npm install'); }
  }
  if (appDepsInstalled() && (!webchatBuilt() || o.rebuild)) {
    run('npm', ['run', 'build', '-w', '@tophat-md/webchat'], log); steps.push('webchat build');
  }

  const configFile = path.resolve(tilde(o.config || defaultConfigFile(name)));
  const confDir = path.dirname(configFile);
  mkdirSync(confDir, { recursive: true, mode: 0o700 });
  if (!existsSync(configFile) || o.force) {
    const inst = {
      name,
      owner: { label: o.owner || 'the owner', ...(o.email ? { addresses: [o.email] } : {}) },
      components: ['linknotes', 'runner', 'webchat', 'deploy'],
      hosts: { public: null, bind: '127.0.0.1' },
      ports: { webchat: Number(o.port || 4178) },
      paths: { state: `~/.local/state/tophat/${name}`, config: confDir.startsWith(os.homedir()) ? `~${confDir.slice(os.homedir().length)}` : confDir },
      models: { chat: { ...(o.model ? { model: o.model } : {}), ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), credential: { keyring: KEY_NAME },
        ...(o.workspaceIdFile ? { workspace: { keyring: WORKSPACE_ID_NAME } } : {}) } },
      // The chat agent runs tools without asking (it is your own agent on your own machine). Confinement keeps its file
      // tools inside the instance's workspace; turn it off with `setup --no-confine` or by removing this line.
      runner: { env: o.confine === false ? {} : { TOPHAT_RUNNER_CONFINE: '1' } },
    };
    const tmp = `${configFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(inst, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, configFile);
    steps.push(`wrote ${configFile}`);
  }
  else {
    // An existing file is kept, but what the user names on this run wins (a rerun with --port after a clash must move).
    const cur = JSON.parse(readFileSync(configFile, 'utf8'));
    const before = JSON.stringify(cur);
    if (o.port) cur.ports = { ...(cur.ports || {}), webchat: Number(o.port) };
    if (o.owner) cur.owner = { ...(cur.owner || {}), label: o.owner };
    if (o.email) cur.owner = { ...(cur.owner || {}), addresses: [o.email] };
    if (o.model || o.baseUrl) cur.models = { ...(cur.models || {}), chat: { ...(cur.models?.chat || {}), ...(o.model ? { model: o.model } : {}), ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) } };
    if (JSON.stringify(cur) !== before) {
      const tmp = `${configFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, configFile);
      steps.push(`updated ${configFile} from this run's options`);
    }
  }
  const c = loadInstance(configFile);
  const secrets = c.paths.secrets;
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const keyFile = path.join(secrets, KEY_NAME);
  const keyFrom = placeSecret({ file: o.keyFile, envName: o.keyEnv || 'ANTHROPIC_API_KEY', dest: keyFile });
  if (keyFrom) steps.push(`model key copied from ${keyFrom} to ${keyFile} (0600)`);
  if (o.workspaceIdFile) placeSecret({ file: o.workspaceIdFile, dest: path.join(secrets, WORKSPACE_ID_NAME) });
  else {
    // Claude Code users with an organisation key carry the workspace id in ANTHROPIC_CUSTOM_HEADERS; reuse it.
    const m = /(?:^|[\n,])\s*anthropic-workspace-id\s*:\s*([^\s,]+)/i.exec(process.env.ANTHROPIC_CUSTOM_HEADERS || '');
    if (m && !c.models.chat?.workspace) {
      process.env.TOPHAT_SETUP_WORKSPACE_ID = m[1];
      placeSecret({ envName: 'TOPHAT_SETUP_WORKSPACE_ID', dest: path.join(secrets, WORKSPACE_ID_NAME) });
      delete process.env.TOPHAT_SETUP_WORKSPACE_ID;
      const cur = JSON.parse(readFileSync(configFile, 'utf8'));
      cur.models = { ...(cur.models || {}), chat: { ...(cur.models?.chat || {}), workspace: { keyring: WORKSPACE_ID_NAME } } };
      writeFileSync(configFile, `${JSON.stringify(cur, null, 2)}\n`, { mode: 0o600 });
      c.models.chat = { ...(c.models.chat || {}), workspace: { keyring: WORKSPACE_ID_NAME } };
      steps.push('workspace id taken from ANTHROPIC_CUSTOM_HEADERS into the keyring');
    }
  }
  const keyPresent = existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim().length > 0;

  const comp = check(loadManifest(), c.components, { root: WORKSPACE });
  if (!comp.ok) throw new Error(`components: ${JSON.stringify(comp.problems)}`);

  let started = null;
  const startable = keyPresent && appDepsInstalled() && webchatBuilt();
  if (o.start !== false && startable) {
    const { healthInstance, startInstance, statusInstance } = await import('./service.mjs');
    const status = statusInstance({ configFile });
    if (!status.running) {
      if (!(await portFree(c.ports.webchat))) throw new Error(`port ${c.ports.webchat} is already in use by another program: rerun with --port N (a free port)`);
      started = startInstance({ configFile });
    }
    const pid = started?.pid ?? status.pid;
    // Ours only: the health answer must name this instance and come from the process we started (not a neighbour on the port).
    const ours = (h) => h?.ok && h.body?.product === c.name && (!pid || String(h.body?.instance || '').startsWith(`${pid}:`));
    let h = null;
    for (let i = 0; i < 120 && !ours(h); i++) { await new Promise((r) => setTimeout(r, 500)); h = await healthInstance({ configFile }).catch(() => null); }
    if (!ours(h)) throw new Error(`the instance did not answer /api/health as itself within 60 s${h?.ok ? ` (port ${c.ports.webchat} answers for ${h.body?.product ?? 'something else'}: use --port)` : ''}; log: ${path.join(c.paths.state, 'logs/webchat.log')}`);
    steps.push(started?.ok ? `started (pid ${started.pid})` : 'already running');
  }
  const env = instanceEnv(c);
  return {
    ok: keyPresent, instance: c.name, config: configFile, url: env.ORIGIN, running: Boolean(o.start !== false && startable),
    key: keyPresent ? keyFile : null, steps,
    enrolToken: path.join(secrets, 'webchat-bootstrap-token'),
    log: path.join(c.paths.state, 'logs/webchat.log'),
    next: keyPresent ? [
      `tophat chat --config ${configFile} "Remember that my favourite tea is genmaicha."   (a first turn from the terminal; it writes memory)`,
      `open ${env.ORIGIN} in a browser on this machine and enrol a passkey with the token in ${path.join(secrets, 'webchat-bootstrap-token')}`,
      `tophat graph --config ${configFile}   (the memory graph on http://127.0.0.1:4179/graph)`,
      `tophat instance stop|status|health --config ${configFile}`,
    ] : [`save your model API key into ${keyFile} yourself (one line, chmod 600; never paste it into a chat), or rerun with --key-file PATH or with ANTHROPIC_API_KEY set, then run \`tophat setup --name ${c.name}\` again`],
  };
}

/** Whether nothing listens on 127.0.0.1:port. */
function portFree(port) {
  return new Promise((ok) => { const srv = http.createServer(); srv.once('error', () => ok(false)); srv.listen(Number(port), '127.0.0.1', () => srv.close(() => ok(true))); });
}

/** A session cookie for the instance's owner, signed with the instance's own session secret (webchat auth). */
function ownerCookie(c) {
  const secret = readFileSync(path.join(c.paths.secrets, 'webchat-session-secret'), 'utf8').trim();
  const payload = `${Date.now() + 3_600_000}.${randomBytes(9).toString('base64url')}`;
  return `tophat_webchat_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** One chat turn through the running instance: returns { conversation, replies, tools, run }. */
export async function chat({ configFile, text, conversation = null, timeoutMs = 300_000 }) {
  if (!text) throw new Error('chat: give the message text');
  const c = loadInstance(configFile);
  const base = instanceEnv(c).TOPHAT_WEBCHAT_URL;
  const cookie = ownerCookie(c);
  const { CONTRACT_VERSION, SCHEMA_HASH } = await import(pathToFileURL(path.join(WORKSPACE, 'packages/webchat/src/lib/core/contract.js')).href);
  const conv = conversation || randomUUID();
  let seq = Date.now();
  const act = (op, payload) => ({ contract_version: CONTRACT_VERSION, schema_hash: SCHEMA_HASH, op, conversation_id: conv, payload,
    action_id: randomBytes(8).toString('hex'), device_id: 'tophat-cli', device_seq: ++seq, at: new Date().toISOString() });
  const post = async (body) => {
    const r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .catch((e) => { throw new Error(`the instance is not answering at ${base} (${e.cause?.code || e.message}); start it with tophat instance start --config ${configFile}`); });
    if (r.status !== 200) throw new Error(`${body.op} refused: ${r.status} ${(await r.text()).slice(0, 300)}`);
  };
  const events = async () => { const r = await fetch(`${base}/api/conversation/${conv}`, { headers: { cookie } }); return r.status === 200 ? (await r.json()).events || [] : []; };
  const before = conversation ? (await events()).length : 0;
  if (!conversation) await post(act('conversation.create', { title: text.slice(0, 60) }));
  await post(act('message.send', { text }));
  const t0 = Date.now();
  for (;;) {
    const ev = (await events()).slice(before);
    const end = ev.find((e) => e.kind === 'run.completed' || e.kind === 'run.failed' || e.kind === 'run.error');
    if (end) {
      const replies = ev.filter((e) => e.kind === 'assistant.message' && !e.content?.agentId).map((e) => e.content?.text).filter(Boolean);
      const tools = [...new Set(ev.filter((e) => e.kind === 'tool.completed').map((e) => e.content?.tool))];
      const errors = ev.filter((e) => /error|failed/.test(e.kind)).map((e) => JSON.stringify(e.content ?? e.payload ?? '').slice(0, 500));
      return { ok: end.kind === 'run.completed', conversation: conv, replies, tools, errors, run: end.content ?? null };
    }
    if (Date.now() - t0 > timeoutMs) return { ok: false, conversation: conv, reason: 'timeout', kinds: ev.map((e) => e.kind).slice(-20) };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The plaintext snapshot of what the instance's own replica can read, the shape packages/viewer/src/core/snapshot.mjs reads. */
export async function snapshotOf(c) {
  const env = instanceEnv(c);
  const db = env.TOPHAT_RUNNER_DB;
  if (!existsSync(db)) throw new Error(`no memory yet at ${db}: have one chat turn first (tophat chat)`);
  const { openStore } = await import(pathToFileURL(path.join(WORKSPACE, 'packages/runner/store/memory.mjs')).href);
  const b = openStore(db, { TOPHAT_SCOPE: env.TOPHAT_SCOPE, ...(env.TOPHAT_SCOPE_USER ? { TOPHAT_SCOPE_USER: env.TOPHAT_SCOPE_USER } : {}) });
  const s = b.store;
  s.setViewer(s.user);
  const groups = JSON.stringify(s.viewer.groups);
  const notes = s.all("SELECT id, body, at, created_at FROM notes WHERE id IN (SELECT pk FROM mc_acl WHERE t='notes' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [groups])
    .filter((r) => s.memoryVisible('note', r)).map((r) => ({ id: r.id, body: r.body, at: r.at || r.created_at }));
  const ids = new Set(notes.map((n) => n.id));
  const entities = s.all("SELECT id, name, type, merged_into FROM entities WHERE id IN (SELECT pk FROM mc_acl WHERE t='entities' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [groups]);
  const note_entities = s.all('SELECT note_id, entity_id FROM note_entities').filter((r) => ids.has(r.note_id));
  const pages = {};
  for (const e of entities) { try { const p = await b.page(e.id); if (p) pages[e.id] = { nodes: p.nodes, cached: p.cached }; } catch { /* no page yet */ } }
  return { kind: 'tophat-graph-snapshot', v: 1, user: s.user, scopes: s.viewer.groups, at: new Date().toISOString(), notes, entities, note_entities, pages };
}

/** Serve the viewer and a fresh snapshot of the replica on loopback (re-read on every load of the snapshot). */
export async function graph({ configFile, port = 4179, host = '127.0.0.1' }) {
  const c = loadInstance(configFile);
  await snapshotOf(c); // fail now, not in the browser, when there is no memory yet
  const assets = path.join(WORKSPACE, 'packages/viewer/assets');
  const index = readFileSync(path.join(assets, 'index.html'), 'utf8').replace('<meta name="th-hub" content="">', '<meta name="th-hub" content=""><meta name="th-public" content="/graph/snapshot.json">');
  const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    try {
      if (p === '/' || p === '/graph' || p === '/graph/') { res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }); return res.end(index); }
      if (p === '/graph/snapshot.json') { const body = JSON.stringify(await snapshotOf(c)); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(body); }
      const m = /^\/graph\/([a-z]+\.js)$/.exec(p);
      if (m && existsSync(path.join(assets, m[1]))) { res.writeHead(200, { 'content-type': TYPES['.js'] }); return res.end(readFileSync(path.join(assets, m[1]))); }
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message)); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return { server, url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${port}/graph` };
}
