// The instance config: defaults, validation, credential references (never values) and the environment handed to the
// app components.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialEnv, instanceEnv, instanceJobs, serviceUnit, loadInstance, resolveInstance, resolveRef, validateRef } from '../src/instance.mjs';

const home = '/home/someone';

test('defaults: neutral owner label, state under ~/.local/state/tophat/<name>, port 4178', () => {
  const c = resolveInstance({ name: 'demo', components: ['linknotes'] }, { home, dir: '/etc' });
  assert.equal(c.owner.label, 'the owner');
  assert.equal(c.paths.state, '/home/someone/.local/state/tophat/demo');
  assert.equal(c.paths.workspace, '/home/someone/.local/state/tophat/demo/workspace');
  assert.equal(c.paths.secrets, '/home/someone/.config/tophat/demo/secrets');
  assert.equal(c.ports.webchat, 4178);
  assert.equal(c.deploy.labelPrefix, 'md.tophat');
});

test('validation: name, unknown keys, ports, inline secrets refused', () => {
  assert.throws(() => resolveInstance({ components: [] }), /"name" is required/);
  assert.throws(() => resolveInstance({ name: 'Bad Name', components: [] }), /"name"/);
  assert.throws(() => resolveInstance({ name: 'a', components: [], colour: 1 }), /unknown key "colour"/);
  assert.throws(() => resolveInstance({ name: 'a' }), /components/);
  assert.throws(() => resolveInstance({ name: 'a', components: [], ports: { webchat: 70000 } }), /port number/);
  assert.throws(() => resolveInstance({ name: 'a', components: [], models: { chat: { apiKey: 'sk-x' } } }), /apiKey is not allowed/);
  assert.throws(() => resolveInstance({ name: 'a', components: [], models: { chat: { credential: 'sk-x' } } }), /reference object/);
  assert.throws(() => validateRef({ env: 'A', file: 'b' }, 'x'), /exactly one/);
  assert.doesNotThrow(() => resolveInstance({ name: 'a', components: [], models: { chat: { model: 'm', credential: { env: 'CHAT_KEY' } } } }));
});

test('relative paths resolve against the config file directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tophat-inst-'));
  const f = path.join(dir, 'tophat.instance.json');
  writeFileSync(f, JSON.stringify({ name: 'team', components: ['linknotes'], paths: { state: './state', instructions: 'rules.md' }, scope: { default: 'team', groups: ['team'] } }));
  const c = loadInstance(f);
  assert.equal(c.paths.state, path.join(dir, 'state'));
  assert.equal(c.paths.instructions, path.join(dir, 'rules.md'));
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_SCOPE, 'team');
  assert.equal(env.TOPHAT_STATE_DIR, path.join(dir, 'state'));
  assert.equal(env.TOPHAT_RUNNER_INSTRUCTIONS_FILE, path.join(dir, 'rules.md'));
  assert.throws(() => loadInstance(path.join(dir, 'missing.json')), /not found/);
});

test('instanceEnv carries names, ports and key file paths; never a credential value', () => {
  process.env.TOPHAT_TEST_SECRET_VALUE = 'sk-should-not-appear';
  const c = resolveInstance({ name: 'demo', components: [], owner: { label: 'Sam' }, hosts: { public: 'chat.example.org' }, ports: { webchat: 5000 },
    models: { chat: { model: 'some-model', credential: { file: '/keys/chat' } }, fast: { baseUrl: 'https://fast.example/v1/', credential: { env: 'TOPHAT_TEST_SECRET_VALUE' } } } }, { home });
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_RUNNER_API_KEY_FILE, '/keys/chat');
  assert.equal(env.TOPHAT_FAST_MODEL_ENDPOINT, 'https://fast.example/v1/chat/completions');
  assert.equal(credentialEnv(c).TOPHAT_FAST_MODEL_API_KEY, 'sk-should-not-appear');
  assert.throws(() => instanceEnv(resolveInstance({ name: 'x', components: [], models: { chat: { credential: { env: 'A' } } } })), /reads its key from a file/);
  assert.equal(env.PORT, '5000'); assert.equal(env.ORIGIN, 'https://chat.example.org'); assert.equal(env.TOPHAT_OWNER_NAME, 'Sam');
  assert.ok(!JSON.stringify(env).includes('sk-should-not-appear'));
  assert.equal(resolveRef({ env: 'TOPHAT_TEST_SECRET_VALUE' }), 'sk-should-not-appear');
  assert.throws(() => resolveRef({ keyring: '../x' }, { keyringDir: '/tmp' }), /file-safe/);
});

test('service unit: launchd label from deploy.labelPrefix, systemd unit; both run tophat start --config', () => {
  const c = resolveInstance({ name: 'demo', components: [], deploy: { labelPrefix: 'org.example' } }, { home });
  const plist = serviceUnit(c, { configFile: '/etc/demo.json', bin: '/opt/tophat-deploy.mjs', node: '/usr/bin/node' });
  assert.match(plist, /<key>Label<\/key><string>org\.example\.demo<\/string>/);
  assert.match(plist, /<string>start<\/string>\n {4}<string>--config<\/string>\n {4}<string>\/etc\/demo\.json<\/string>/);
  assert.match(serviceUnit(c, { configFile: '/etc/demo.json', bin: '/b', node: '/n', kind: 'systemd' }), /ExecStart=\/n \/b start --config \/etc\/demo\.json/);
  assert.throws(() => serviceUnit(c, { kind: 'cron' }), /unknown unit kind/);
});

test('scope.user, sources and hub: references only, message stores and hub reach the env as paths', () => {
  const base = { name: 'demo', components: [], paths: { config: '/etc/demo', state: '/srv/demo' } };
  const c = resolveInstance({ ...base, scope: { default: 'sam-private', user: 'sam', groups: ['team'] },
    sources: [{ id: 'mail', family: 'gmail', account: 'sam@example.org', config: { credential: 'gmail-token', clientFile: '/etc/demo/client.json' } },
      { id: 'texts', family: 'imessage', config: { database: '/data/chat.db' } }, { id: 'bridge', family: 'beeper', config: { index: 'beeper/index.db' } }],
    hub: { url: 'https://hub.example.org', token: { keyring: 'hub-token' }, device: 'sam-laptop', deviceKey: { file: '/etc/demo/device-key.json' } } }, { home, dir: '/etc' });
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_SCOPE, 'sam-private'); assert.equal(env.TOPHAT_SCOPE_USER, 'sam');
  assert.equal(env.TOPHAT_RUNNER_IMESSAGE_DB, '/data/chat.db');
  assert.equal(env.TOPHAT_RUNNER_BEEPER_INDEX, '/etc/demo/beeper/index.db');
  assert.equal(env.TOPHAT_HUB_URL, 'https://hub.example.org');
  assert.equal(env.TOPHAT_HUB_TOKEN_FILE, '/etc/demo/secrets/hub-token');
  assert.equal(env.TOPHAT_DEVICE, 'sam-laptop'); assert.equal(env.TOPHAT_DEVICE_KEY_FILE, '/etc/demo/device-key.json');
  assert.equal(instanceEnv(resolveInstance(base, { home })).TOPHAT_HUB_URL, undefined);
  assert.throws(() => resolveInstance({ ...base, sources: [{ id: 'm', family: 'imap', config: { password: 'hunter2' } }] }), /reference object/);
  assert.doesNotThrow(() => resolveInstance({ ...base, sources: [{ id: 'm', family: 'imap', config: { password: { keyring: 'imap-pw' } } }] }));
  assert.throws(() => resolveInstance({ ...base, sources: [{ id: 'm', family: 'x' }, { id: 'm', family: 'y' }] }), /duplicate id/);
  assert.throws(() => resolveInstance({ ...base, hub: { url: 'https://h', token: 'abc' } }), /reference object/);
  assert.throws(() => resolveInstance({ ...base, hub: { url: 'https://h', token: { env: 'HUB' } } }), /from a file/);
  assert.throws(() => resolveInstance({ ...base, hub: { url: 'https://h', token: { file: '/t' }, extra: 1 } }), /unknown key hub.extra/);
  assert.throws(() => resolveInstance({ ...base, scope: { user: 'Sam' } }), /scope.user/);
});

test('file references and home-relative source paths come out absolute', () => {
  const c = resolveInstance({ name: 'demo', components: [], models: { chat: { credential: { file: '~/keys/chat' } } },
    sources: [{ id: 't', family: 'imessage', config: { database: '~/Library/Messages/chat.db' } }], hub: { url: 'https://h', token: { file: '~/hub-token' } } }, { home, dir: '/etc' });
  assert.equal(c.models.chat.credential.file, '/home/someone/keys/chat');
  assert.equal(c.hub.token.file, '/home/someone/hub-token');
  assert.equal(instanceEnv(c).TOPHAT_RUNNER_IMESSAGE_DB, '/home/someone/Library/Messages/chat.db');
});

test('models.chat.workspace: a workspace id file reaches the runner as a path', () => {
  const c = resolveInstance({ name: 'demo', components: [], paths: { config: '/etc/demo' }, models: { chat: { credential: { keyring: 'chat-key' }, workspace: { keyring: 'chat-workspace' } } } }, { home });
  assert.equal(instanceEnv(c).TOPHAT_RUNNER_WORKSPACE_ID_FILE, '/etc/demo/secrets/chat-workspace');
  assert.throws(() => resolveInstance({ name: 'x', components: [], models: { chat: { workspace: 'ws-123' } } }), /reference object/);
  assert.throws(() => resolveInstance({ name: 'x', components: [], models: { chat: { workspace: { env: 'WS' } } } }), /from a file/);
});

test('runner.env: extra names reach the children; secrets and collisions are refused; the runner finds its own webchat', () => {
  const c = resolveInstance({ name: 'demo', components: [], ports: { webchat: 4391 },
    runner: { env: { TOPHAT_REV6_HARNESS: 'v2,unify', TOPHAT_RUNNER_MAIL_ACCOUNTS: { me: { dir: '/data/mail', email: 'me@example.org' } }, TOPHAT_RUNNER_WEB_CDP_BIN: '~/bin/cdp', PATH: '/opt/tools:/usr/bin' } } }, { home });
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_REV6_HARNESS, 'v2,unify');
  assert.deepEqual(JSON.parse(env.TOPHAT_RUNNER_MAIL_ACCOUNTS), { me: { dir: '/data/mail', email: 'me@example.org' } });
  assert.equal(env.TOPHAT_RUNNER_WEB_CDP_BIN, '/home/someone/bin/cdp');
  assert.equal(env.PATH, '/opt/tools:/usr/bin');
  assert.equal(env.TOPHAT_WEBCHAT_URL, 'http://127.0.0.1:4391');
  assert.equal(instanceEnv(resolveInstance({ name: 'x', components: [] }, { home })).TOPHAT_WEBCHAT_URL, 'http://127.0.0.1:4178');
  assert.throws(() => resolveInstance({ name: 'x', components: [], runner: { env: { SOME_API_KEY: 'abc' } } }), /reads as a secret/);
  assert.throws(() => resolveInstance({ name: 'x', components: [], runner: { env: { SERVICE_TOKEN: 'abc' } } }), /reads as a secret/);
  assert.doesNotThrow(() => resolveInstance({ name: 'x', components: [], runner: { env: { TOPHAT_RUNNER_OPENAI_API_KEY_FILE: '/keys/openai', TOPHAT_RUNNER_MAX_TOKENS: 32000 } } }));
  assert.throws(() => resolveInstance({ name: 'x', components: [], runner: { env: { lower: '1' } } }), /upper case/);
  assert.throws(() => resolveInstance({ name: 'x', components: [], runner: { other: 1 } }), /unknown key runner.other/);
  assert.throws(() => instanceEnv(resolveInstance({ name: 'x', components: [], runner: { env: { TOPHAT_RUNNER_MODEL: 'other' }, }, models: { chat: { model: 'm' } } }, { home })), /already set by the instance file/);
  const unit = serviceUnit(c, { configFile: '/etc/demo.json', bin: '/b', node: '/n' });
  assert.match(unit, /<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>\/opt\/tools:\/usr\/bin<\/string>/);
});

test('instanceJobs: the push plane job is emitted when push and upkeep are components and the file has an intake block', async () => {
  const base = { name: 'demo', deploy: { labelPrefix: 'org.example' }, intake: { everySeconds: 60, model: { provider: 'stub' } } };
  const jobs = (extra) => instanceJobs(resolveInstance({ ...base, ...extra }, { home }), { configFile: '/etc/demo.json' });
  assert.deepEqual(jobs({ components: ['linknotes', 'runner', 'webchat'] }).map((j) => j.job), ['webchat', 'update']);
  assert.deepEqual(jobs({ components: ['linknotes', 'sources', 'push', 'upkeep', 'runner', 'webchat'] }).map((j) => j.job), ['webchat', 'intake', 'update']);
  assert.deepEqual(jobs({ components: ['linknotes', 'sources', 'push', 'upkeep'], intake: null, update: false }).map((j) => j.job), []);
  const c = resolveInstance({ ...base, components: ['linknotes', 'sources', 'push', 'upkeep', 'runner', 'webchat'] }, { home });
  const intake = serviceUnit(c, { configFile: '/etc/demo.json', bin: '/opt/d.mjs', node: '/usr/bin/node', job: 'intake' });
  assert.match(intake, /<key>Label<\/key><string>org\.example\.demo\.intake<\/string>/);
  for (const a of ['instance', 'intake', '--config', '/etc/demo.json', '--forever']) assert.ok(intake.includes(`<string>${a}</string>`), a);
  assert.match(intake, /logs\/intake\.log/);
  assert.throws(() => serviceUnit(c, { configFile: '/etc/demo.json', bin: '/b', job: 'fast-proxy' }), /no job "fast-proxy"/);
});

test('the intake pusher id reaches the runner env, and a workspace-scoped fast model goes through the header proxy', () => {
  const c = resolveInstance({ name: 'demo', components: [], ports: { webchat: 5000, fastProxy: 5001 }, intake: { everySeconds: 60, model: { provider: 'stub' } },
    models: { fast: { model: 'small', baseUrl: 'https://fast.example/v1', credential: { keyring: 'k' }, workspace: { keyring: 'w' } } } }, { home });
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_PUSHER_ID, 'demo-intake');
  assert.equal(env.TOPHAT_FAST_MODEL_ENDPOINT, 'http://127.0.0.1:5001/chat/completions');
  assert.equal(env.WEBCHAT_TITLE_MODEL, 'small'); assert.equal(env.WEBCHAT_ROUTE_MODEL, 'small');
  assert.ok(instanceJobs(c, { configFile: '/f' }).some((j) => j.job === 'fast-proxy' && j.label.endsWith('.demo.fast-proxy')));
  assert.throws(() => resolveInstance({ name: 'demo', components: [], models: { fast: { baseUrl: 'https://x', workspace: { keyring: 'w' } } } }, { home }), /needs ports.fastProxy/);
  const plain = instanceEnv(resolveInstance({ name: 'demo', components: [], models: { fast: { baseUrl: 'https://fast.example/v1/' } } }, { home }));
  assert.equal(plain.TOPHAT_FAST_MODEL_ENDPOINT, 'https://fast.example/v1/chat/completions');
  assert.equal(plain.TOPHAT_PUSHER_ID, undefined);
});

test('scope.join, screens and the roster reach the env; join and groups never overlap; setup-shaped files carry none of it', () => {
  const base = { name: 'demo', components: [] };
  const c = resolveInstance({ ...base, scope: { user: 'th-ab12cd34', join: ['tophat-users'], screens: [{ pattern: 'acme' }], peopleFile: './people.json' } }, { home, dir: '/etc/demo' });
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_SCOPE_JOIN, 'tophat-users');
  assert.equal(env.TOPHAT_SCOPE_GROUPS, '');
  assert.equal(env.TOPHAT_SCOPE_USER, 'th-ab12cd34');
  assert.deepEqual(JSON.parse(env.TOPHAT_SCOPE_SCREENS), [{ pattern: 'acme' }]);
  assert.equal(env.TOPHAT_PRIVATE_PEOPLE_FILE, '/etc/demo/people.json');
  const plain = instanceEnv(resolveInstance(base, { home }));
  for (const k of ['TOPHAT_SCOPE_JOIN', 'TOPHAT_SCOPE_SCREENS', 'TOPHAT_PRIVATE_PEOPLE_FILE']) assert.ok(!(k in plain), `${k} is off by default`);
  assert.throws(() => resolveInstance({ ...base, scope: { groups: ['tophat-users'], join: ['tophat-users'] } }), /creates a group and scope.join joins/);
  assert.throws(() => resolveInstance({ ...base, scope: { join: ['Bad Name'] } }), /scope.join is a list of group names/);
  assert.throws(() => resolveInstance({ ...base, scope: { screens: [{ pattern: '(' }] } }), /scope.screens\[0\].pattern/);
  assert.throws(() => resolveInstance({ ...base, scope: { screens: [{}] } }), /needs a pattern/);
});

test('hub: the token may be pending (defaults to the keyring entry hub-token), and a hub block adds a sync job unless the intake syncs', () => {
  const base = { name: 'demo', deploy: { labelPrefix: 'org.example' }, components: ['linknotes', 'sources', 'push', 'upkeep', 'runner', 'webchat'], hub: { url: 'https://hub.example.org' } };
  const c = resolveInstance(base, { home, dir: '/etc/demo' });
  assert.deepEqual(c.hub.token, { keyring: 'hub-token' });
  assert.equal(instanceEnv(c).TOPHAT_HUB_TOKEN_FILE, '/home/someone/.config/tophat/demo/secrets/hub-token');
  const jobs = (x) => instanceJobs(resolveInstance({ ...base, ...x }, { home }), { configFile: '/etc/demo.json' });
  assert.deepEqual(jobs({ update: false }).map((j) => j.job), ['webchat', 'sync'], 'no intake block: the sync job is the syncer');
  assert.deepEqual(jobs({ intake: { everySeconds: 60, model: { provider: 'stub' } } }).map((j) => j.job), ['webchat', 'intake', 'update'], 'the intake syncs after each pass; a second syncer would reseal actions');
  assert.deepEqual(jobs({ hub: null }).map((j) => j.job), ['webchat', 'update']);
  const unit = serviceUnit(resolveInstance(base, { home }), { configFile: '/etc/demo.json', bin: '/opt/d.mjs', node: '/usr/bin/node', job: 'sync' });
  for (const a of ['instance', 'sync', '--config', '/etc/demo.json', '--forever', '--every', '60']) assert.ok(unit.includes(`<string>${a}</string>`), a);
  assert.match(unit, /org\.example\.demo\.sync/);
});
