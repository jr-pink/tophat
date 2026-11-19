// Unit tests for the kernel, secrets and CLI glue; the pure cases of tools/test-tophat-cdp-guard.py ported,
// plus differentials against the Python twin. Run: scripts/test.sh rev6/tools/browser/kernel.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { differential } from './cdp/fuzz.mjs';
import { normalizeArgv, parseArgv, pyJson } from '../cdp/tophat-cdp.mjs';
import { scrubMessage } from '../cdp/argparse.mjs';
import { clean, oldTwin } from './cdp/twin.mjs';
import * as K from '../cdp/browser/kernel.mjs';
import * as S from '../cdp/browser/secrets.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../cdp/tophat-cdp.mjs');
const FAKE = 'hunter2-test-value';
const ID = '0AFC41144B23DA144C549ACD70869DC2';
let twin;
before(() => { twin = oldTwin(); });
after(() => twin.close());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rev6-tools-'));
// a child without the test preload, in a fresh temp HOME and a minimal env
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), TOPHAT_REDACT_SECRETS: '0', TOPHAT_CDP_ENDPOINT: 'http://127.0.0.1:9', ...env } });

test('parse errors never echo a value (guard test cases)', () => {
  for (const argv of [['fill', ID, 'input', FAKE, 'extra', FAKE], ['navigate', '--nope', FAKE], [FAKE, 'fill'], ['click', 'ID123456', FAKE, '1'],
    ['fill', ID, 'input', '--secret-from', FAKE, '--bogus=' + FAKE]]) {
    const r = run(argv);
    assert.equal(r.status, 1, argv.join(' '));
    assert.ok(!(r.stdout + r.stderr).includes(FAKE), r.stderr);
    assert.match(r.stderr, /error:/);
  }
});
test('scrubMessage hides values, suggests the verb', () => {
  assert.ok(!scrubMessage(`unrecognized arguments: ${FAKE} x`).includes(FAKE));
  assert.ok(!scrubMessage(`argument x: invalid float value: '${FAKE}'`).includes(FAKE));
  assert.ok(!scrubMessage(`argument command: invalid choice: '${FAKE}' (choose from 'a', 'b')`).includes(FAKE));
  assert.match(scrubMessage("argument command: invalid choice: 'navigat' (choose from 'navigate', 'new')"), /navigate/);
});
test('scrubMessage matches the Python twin on generated messages', async () => {
  const shapes = (g) => g.pick([`unrecognized arguments: ${g.string(10)} --${g.pick(['x', 'bad-opt'])} ${g.string(6)}`, `argument x: invalid float value: '${g.string(8)}'`,
    `argument x: expected one argument`, `something '${g.string(5)}' else`]);
  const r = await differential(async (m) => (await twin.call({ fn: 'cdp.scrub_argparse_message', args: [m] })).ok, async (m) => scrubMessage(m), shapes, { n: 300, seed: 7 });
  assert.ok(r.ok, JSON.stringify(r.diffs[0]));
});
test('redactor covers raw, json and repr forms', () => {
  S.resetSecrets();
  S.registerSecret('p"w\\x-1234');
  const text = JSON.stringify({ value: 'p"w\\x-1234' }) + "'p\"w\\\\x-1234'" + 'p"w\\x-1234';
  assert.ok(!S.redact(text, { TOPHAT_REDACT_SECRETS: '0' }).includes('x-1234'), S.redact(text));
  S.resetSecrets();
});
test('normalisation: the shapes seen in the ledger', () => {
  const cases = [
    [['fill', ID, 'input', 'pw', '--job', 'cf'], ['fill', ID, 'input', 'pw']], [['--job', 'cf', 'fill', 'input', 'pw'], ['fill', 'job=cf', 'input', 'pw']],
    [['fill', '--job', 'cf', 'input', 'pw'], ['fill', 'job=cf', 'input', 'pw']],
    [['eval', '--target', ID, '--expr', '1+1', '--await'], ['eval', ID, '--expr', '1+1', '--await']],
    [['--timeout', '10', '--job', 'k', 'eval', 'document.readyState'], ['eval', 'job=k', 'document.readyState', '--timeout', '10']],
    [['nav', '--job', 's', '--url', 'https://a.b'], ['navigate', 'job=s', '--url', 'https://a.b']], [['type', '--job', 'x', '--', '-5'], ['type', 'job=x', '--', '-5']],
    [['--steal', '--expect-url', 'https://x.com/', '--job', 'cf', 'fill', 'i', '--secret-from', 'a'], ['fill', 'job=cf', 'i', '--secret-from', 'a', '--steal', '--expect-url', 'https://x.com/']],
    [['screenshot', '--job', 'd', '--out', '/tmp/x.png'], ['screenshot', 'job=d', '--out', '/tmp/x.png']], [['click', '--job', 'y', ID, '3', '4'], ['click', ID, '3', '4']],
  ];
  for (const [argv, want] of cases) {
    assert.deepEqual(normalizeArgv(argv, {}).argv, want, argv.join(' '));
    assert.ok(parseArgv(argv, {}).ns, `parses: ${argv.join(' ')}`);
  }
  assert.equal(parseArgv(['fill', '--job', 'x', 'input', '--', '-abc'], {}).ns.text, '-abc');
});
test('text sources: env resolves private, both ways refused, stdin strips one newline', () => {
  S.resetSecrets();
  assert.deepEqual(S.resolveText({ text_env: 'T_SECRET' }, 'fill', { env: { T_SECRET: FAKE } }), { text: FAKE, private: true, secret: false });
  assert.ok(S.secretVariants().includes(FAKE));
  assert.throws(() => S.resolveText({ text: 'a', text_env: 'T_SECRET' }, 'fill', { env: { T_SECRET: FAKE } }), (e) => e.code === 1);
  assert.equal(S.resolveText({ text_stdin: true, secret: true }, 'keys', { stdin: () => `${FAKE}\r\n` }).text, FAKE);
  S.resetSecrets();
});
test('destination and element guards (exit 6)', () => {
  const refused = (fn) => { try { fn(); return false; } catch (e) { return e.code === 6; } };
  assert.ok(refused(() => S.checkSecretDestination('https://a.com/x', null)));
  assert.ok(refused(() => S.checkSecretDestination('https://evil.com/x', 'https://a.com/')));
  assert.ok(refused(() => S.checkSecretDestination('https://discord.com/channels/1', 'https://discord.com/')));
  assert.ok(refused(() => S.checkSecretDestination('http://a.com/', 'http://a.com/')));
  assert.ok(!refused(() => S.checkSecretDestination('https://dash.cloudflare.com/login', 'https://dash.cloudflare.com/')));
  assert.ok(refused(() => S.checkSecretDestination('https://dash.cloudflare.com.evil.io/', 'https://dash.cloudflare.com')));
  assert.ok(refused(() => S.checkSecretElement({ tag: 'DIV' })));
  assert.ok(refused(() => S.checkSecretElement({ tag: 'INPUT', type: 'checkbox' })));
  assert.ok(refused(() => S.checkSecretElement({ tag: 'INPUT', type: 'password' }, false)));
  assert.ok(!refused(() => S.checkSecretElement({ tag: 'INPUT', type: 'password' })));
});
test('destination guard matches the Python twin on generated urls', async () => {
  const hosts = ['dash.cloudflare.com', 'discord.com', 'localhost:8913', '127.0.0.1', 'a.com', 'evil.io', 'mail.google.com', 'x.com'];
  const gen = (g) => { const u = `${g.pick(['https', 'http'])}://${g.pick(hosts)}${g.pick(['', '/', '/login', '/x?y=1'])}`; return [u, g.bool() ? null : g.bool() ? u : `${g.pick(['https', 'http'])}://${g.pick(hosts)}/`]; };
  const call = (fn) => async (a) => clean((await twin.call({ fn: `cdp.${fn}`, args: a })).ok);
  const mine = (fn) => (a) => { try { fn(...a); return { ok: true }; } catch (e) { return { code: e.code }; } };
  let r = await differential(call('check_secret_destination'), mine(S.checkSecretDestination), gen, { n: 400, seed: 3 });
  assert.ok(r.ok, JSON.stringify(r.diffs[0]));
  const el = (g) => [{ tag: g.pick(['INPUT', 'TEXTAREA', 'DIV', 'input', '', 'SELECT']), type: g.pick(['text', 'password', 'checkbox', '', null, 'email', 'radio']), disabled: g.bool() }, g.bool()];
  r = await differential(call('check_secret_element'), mine(S.checkSecretElement), el, { n: 300, seed: 4 });
  assert.ok(r.ok, JSON.stringify(r.diffs[0]));
});
test('vault fetch through a fake tophat-pass; failure never forwards its stderr', () => {
  const dir = tmp(), fake = path.join(dir, 'tophat-pass');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$2" = "ok-entry" ]; then printf "%s\\n" "${FAKE}"; exit 0; fi\necho "boom ${FAKE}" >&2; exit 3\n`, { mode: 0o755 });
  assert.equal(S.fetchVaultSecret('ok-entry', { ...process.env, TOPHAT_CDP_PASS_BIN: fake }), FAKE);
  assert.throws(() => S.fetchVaultSecret('bad-entry', { ...process.env, TOPHAT_CDP_PASS_BIN: fake }), (e) => !e.message.includes(FAKE) && e.code === 1);
});
test('parseKey, urlDrift, sanitizeJobName, looksLikeTarget match the Python twin', async () => {
  const keys = (g) => [`${g.bool() ? g.pick(['Shift+', 'Ctrl+', 'Meta+', 'Cmd+', 'Alt+', 'shift+ctrl+']) : ''}${g.pick(['a', 'Z', '5', '.', 'Enter', 'tab', 'ArrowUp', 'Space', 'PageDown', 'esc', 'é', 'F5', '+', 'Up'])}`];
  const urls = ['https://a.com/x/y', 'https://a.com/z', 'http://a.com/x', 'https://b.com/', 'about:blank', '', null, 'chrome://newtab/', 'https://a.com', 'file:///tmp/x', 'https://a.com:8443/x'];
  const pairs = [
    ['parse_key', keys, (a) => K.parseKey(...a)],
    ['url_drift', (g) => [g.pick(urls), g.pick(urls)], (a) => K.urlDrift(...a)],
    ['sanitize_job_name', (g) => [g.pick(['agent/2e36 e1c7!', '', '--x', g.string(12), '_a', 'ok-name', 'a'.repeat(80)])], (a) => K.sanitizeJobName(...a)],
    ['looks_like_target', (g) => [g.pick([ID, ID.slice(0, 6), 'abc12', 'url=x', 'job=a', 'title*=t', 'document.title', '', '#sel'])], (a) => K.looksLikeTarget(...a)],
  ];
  for (const [fn, gen, mine] of pairs) {
    const r = await differential(async (a) => { const x = await twin.call({ fn: `cdp.${fn}`, args: a }); return x.raised ? { raised: true } : clean(x.ok); },
      (a) => { try { return clean(mine(a)); } catch { return { raised: true }; } }, gen, { n: 300, seed: 11 });
    assert.ok(r.ok, `${fn}: ${JSON.stringify(r.diffs[0])}`);
  }
});
test('pickTarget: exact, prefix, anchored selectors, ambiguity lists candidates', () => {
  const t = [{ id: 'AAAA1111', type: 'page', url: 'https://x.com/a', title: 'A' }, { id: 'AAAA2222', type: 'iframe', url: 'https://x.com/number-ltr', title: '' },
    { id: 'BBBB3333', type: 'iframe', url: 'https://x.com/issue_number-ltr', title: '' }];
  assert.equal(K.pickTarget(t, 'aaaa1111').id, 'AAAA1111');
  assert.throws(() => K.pickTarget(t, 'AAAAAA'), /no target matched/);
  assert.throws(() => K.pickTarget(t, 'url*=number-ltr'), (e) => e.code === 3 && /ambiguous/.test(e.message) && e.message.includes('BBBB3333'));
  assert.equal(K.pickTarget(t, 'url^=https://x.com/num').id, 'AAAA2222');
  assert.throws(() => K.pickTarget(t, 'nonsense'), (e) => e.code === 1);
});
test('job registry: same layout, exclusive claim, reaping rules, protected ids', () => {
  const dir = tmp(), env = { TOPHAT_CDP_JOBS: path.join(dir, 'jobs'), TOPHAT_CDP_PROTECT_FILE: path.join(dir, 'p.txt'), TOPHAT_CDP_PROTECTED: 'cccc,DDDD', HOME: dir };
  const job = K.newJobRecord('shop', 'T1', { url: 'https://a.com/x' });
  assert.ok(K.saveJobExclusive(job, env));
  assert.equal(K.saveJobExclusive(job, env), null);
  const text = fs.readFileSync(path.join(env.TOPHAT_CDP_JOBS, 'shop.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), [...Object.keys(job)].sort());
  assert.match(text, /^\{\n {2}"ephemeral": false,\n/);
  assert.match(job.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/);
  const targets = [{ id: 'T1', type: 'page', url: 'https://a.com/x', title: 'x' }, { id: 'T2', type: 'page', url: 'https://b.com/', title: 'b' }];
  K.saveJob({ ...K.newJobRecord('dead', 'GONE', { url: 'https://nowhere/' }) }, env);
  K.saveJob({ ...K.newJobRecord('stale', 'T2'), pid: 999999, lastSeen: '2020-01-01T00:00:00+0000' }, env);
  K.saveJob({ ...K.newJobRecord('recent', 'T2'), pid: 999999 }, env);
  assert.deepEqual(K.reapJobs(targets, { env }).sort(), ['dead', 'stale']);
  assert.deepEqual(K.allJobs(env).map((j) => j.job).sort(), ['recent', 'shop']);
  assert.equal(K.targetOwner(targets, 't1', 'other', K.allJobs(env)).job, 'shop');
  assert.equal(K.targetOwner(targets, 'T1', 'shop', K.allJobs(env)), null);
  fs.writeFileSync(env.TOPHAT_CDP_PROTECT_FILE, '# c\nT2  # live checkout\n');
  assert.deepEqual([...K.protectedIds(env)].sort(), ['CCCC', 'DDDD', 'T2']);
  assert.throws(() => K.guardProtected(targets[1], {}, 'close', env), (e) => e.code === 5);
  K.guardProtected(targets[1], { force: true }, 'close', env);
  assert.equal(K.refindTarget({ job: 'x', lastUrl: 'https://b.com/' }, targets, env), null, 'T2 is held by recent');
  assert.throws(() => K.checkJobName('bad name'), (e) => e.code === 1);
  assert.deepEqual(K.defaultJobName({ TOPHAT_AGENT_ID: 'agent/2e36 e1c7!' }), ['agent-2e36-e1c7', 'TOPHAT_AGENT_ID']);
  assert.deepEqual(K.defaultJobName({}, 42), ['auto-42', 'process']);
});
test('idle tabs: only unheld, unprotected, unchanged pages past the ttl are closed; the last page stays', async () => {
  const dir = tmp(), env = { TOPHAT_CDP_JOBS: path.join(dir, 'jobs'), TOPHAT_CDP_PROTECT_FILE: path.join(dir, 'p.txt'), HOME: dir };
  fs.writeFileSync(env.TOPHAT_CDP_PROTECT_FILE, 'P1\n');
  K.saveJob(K.newJobRecord('held', 'H1'), env);
  const page = (id, url = `https://x.com/${id}`) => ({ id, type: 'page', url, title: id });
  const targets = [page('H1'), page('P1'), page('I1'), page('I2'), page('C1'), { id: 'F1', type: 'iframe', url: 'https://x.com/f', title: '' }];
  const closed = []; const close = async (id) => { closed.push(id); return true; };
  const t0 = Date.parse('2026-11-18T00:00:00Z'), H = 3600e3;
  assert.deepEqual(await K.reapIdleTabs(targets, { close, env, now: t0 }), [], 'first sight starts the clock, closes nothing');
  assert.deepEqual(await K.reapIdleTabs(targets, { close, env, now: t0 + 0.5 * H }), []);
  const moved = targets.map((t) => (t.id === 'C1' ? { ...t, url: 'https://x.com/changed' } : t));   // C1 navigated: clock restarts
  assert.deepEqual((await K.reapIdleTabs(moved, { close, env, now: t0 + 1.5 * H })).sort(), ['I1', 'I2'], 'held, protected, changed and non-page targets survive');
  assert.deepEqual(closed.sort(), ['I1', 'I2']);
  assert.deepEqual(await K.reapIdleTabs(moved.filter((t) => t.id !== 'I1' && t.id !== 'I2'), { close, env, now: t0 + 1.5 * H }), []);
  assert.deepEqual(await K.reapIdleTabs(moved, { close, env, now: t0 + 9 * H, ttl: 0 }), [], 'ttl 0 turns it off');
  // an orphaned ephemeral claim's tab goes at once, but never the only page
  assert.deepEqual(await K.reapIdleTabs([page('E1'), page('E2')], { close, env, now: t0 + 9 * H, extra: ['E1', 'E2'] }), ['E2'], 'the last page stays');
  const orphans = [];
  K.saveJob({ ...K.newJobRecord('eph', 'E1', { ephemeral: true }), pid: 999999, lastSeen: '2020-01-01T00:00:00+0000' }, env);
  assert.deepEqual(K.reapJobs([page('E1'), page('H1')], { env, orphans }), ['eph']);
  assert.deepEqual(orphans, ['E1']);
});
test('endpoint discovery: env, config, local only, never a guessed port', () => {
  const dir = tmp();
  assert.throws(() => K.discover({ HOME: dir }), (e) => e.code === 1 && /guessing a port/.test(e.message));
  fs.mkdirSync(path.join(dir, '.config/tophat'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.config/tophat/config.json'), JSON.stringify({ browserCdp: 'http://127.0.0.1:29229/' }));
  assert.deepEqual(K.discover({ HOME: dir }), { endpoint: 'http://127.0.0.1:29229', source: `${dir}/.config/tophat/config.json#browserCdp` });
  assert.equal(K.discover({ HOME: dir, TOPHAT_CDP_ENDPOINT: 'http://localhost:1' }).source, 'TOPHAT_CDP_ENDPOINT');
  // an older install's names are read through TOPHAT_LEGACY_ENV_PREFIX
  assert.equal(K.discover({ HOME: dir, TOPHAT_LEGACY_ENV_PREFIX: 'OLD_', OLD_CDP_ENDPOINT: 'http://localhost:2' }).endpoint, 'http://localhost:2');
  assert.equal(K.jobsDir({ HOME: dir, TOPHAT_LEGACY_ENV_PREFIX: 'OLD_', OLD_CDP_JOBS: '/x/jobs' }), '/x/jobs');
  assert.equal(K.jobsDir({ HOME: dir, TOPHAT_STATE_DIR: '/s' }), '/s/cdp/jobs');
  for (const bad of ['https://127.0.0.1:1', 'http://10.0.0.2:9222', 'http://user:pass@127.0.0.1:1']) assert.throws(() => K.discover({ HOME: dir, TOPHAT_CDP_ENDPOINT: bad }), (e) => e.code === 1);
});
test('an unreachable endpoint is exit 2, a missing job is exit 1', () => {
  assert.equal(run(['targets']).status, 2);
  assert.equal(run(['status']).status, 2);
});
test('a refused endpoint names the launchd label to kickstart', () => {
  assert.match(K.refusedHint('ECONNREFUSED', { TOPHAT_CDP_LAUNCHD_LABEL: 'io.example.chrome-cdp' }), /launchctl kickstart -k gui\/\$\(id -u\)\/io\.example\.chrome-cdp/);
  assert.match(K.refusedHint('ECONNREFUSED', {}), /remote-debugging-port/);
  assert.equal(K.refusedHint('TimeoutError'), '');
});
test('pyJson matches Python json.dumps separators and ascii escaping', () => {
  assert.equal(pyJson({ a: 1, b: [true, null, 'é'] }), '{"a": 1, "b": [true, null, "\\u00e9"]}');
  assert.equal(pyJson({ b: 1, a: { c: [] } }, { indent: 2, sortKeys: true }), '{\n  "a": {\n    "c": []\n  },\n  "b": 1\n}');
  assert.equal(pyJson('é', { ascii: false }), '"é"');
});
test('a live passkey keeper owns the tab: verbs borrow its session (gotcha 8b), never open their own', async () => {
  const net = await import('node:net');
  const dir = tmp(), sock = path.join(dir, 'k.sock'), seen = [];
  const server = net.createServer((c) => c.on('data', (d) => { const req = JSON.parse(String(d)); seen.push(req); c.end(`${JSON.stringify({ ok: true, result: { echoed: req.method } })}\n`); }));
  await new Promise((r) => server.listen(sock, r));
  fs.writeFileSync(path.join(dir, 'pk.json'), JSON.stringify({ job: 'pk', targetId: 'ABCDEF01', pid: process.pid, socket: sock }));
  const env = { TOPHAT_CDP_PASSKEYS: dir };
  try {
    assert.equal(K.keeperFor('abcdef01', env).job, 'pk');
    assert.equal(K.keeperFor('abcdef01', { ...env, TOPHAT_CDP_NO_KEEPER_PROXY: '1' }), null);
    const conn = new K.KeeperConn(K.keeperFor('ABCDEF01', env), 5);
    assert.deepEqual(await conn.send('Runtime.evaluate', { expression: '1' }), { echoed: 'Runtime.evaluate' });
    assert.deepEqual(seen[0], { cmd: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' }, timeout: 5 });
    fs.writeFileSync(path.join(dir, 'pk.json'), JSON.stringify({ job: 'pk', targetId: 'ABCDEF01', pid: 999999, socket: sock }));
    assert.equal(K.keeperFor('ABCDEF01', env), null, 'a dead keeper is ignored');
  } finally { server.close(); }
});
