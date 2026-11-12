// Extensions on an instance: the instance file's block, discovery, the kit gate run by `ext check|build`, the resolved set
// and tool links the server and children get, interval units for extension jobs, and a job's dispatch through the
// loopback route. Planted: a refused extension is reported (exit 1) and never resolved; a tool removed from the set is
// unlinked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instanceEnv, instanceJobs, resolveInstance, serviceUnit } from '../src/instance.mjs';
import { buildExtensions, checkExtensions, discover, readResolved, runJob } from '../src/extensions.mjs';

function ext(root, id, manifest, source, files = {}) {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ id, version: '1.0.0', api: 1, depends: { core: '^1' }, entry: './index.mjs', ...manifest }));
  writeFileSync(path.join(dir, 'index.mjs'), source);
  for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), body, { mode: 0o755 }); }
  return dir;
}

function instance({ disable } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ext-inst-'));
  const exts = path.join(root, 'extensions');
  ext(exts, 'hello', { provides: { tools: ['hello-tool'], jobs: ['tick'], commands: ['ext.hello.say'] }, capabilities: { dispatch: ['core.chat.inbound'] } },
    `export default (x) => {
      x.tool('hello-tool', 'bin/hello-tool');
      x.job('tick', { everySeconds: 300, run: async (ctx) => ctx.dispatch('core.chat.inbound', { text: 'tick' }, { id: 'tick-1' }) });
      x.command('ext.hello.say', { title: 'Say hello', run: () => 'hi' });
    };`, { 'bin/hello-tool': '#!/bin/sh\necho hello\n' });
  ext(exts, 'liar', { provides: { commands: ['ext.liar.a'] } }, `export default (x) => { x.command('ext.liar.b', { title: 'B', run: () => 1 }); };`);
  const c = resolveInstance({ name: 'demo', components: ['linknotes', 'runner', 'webchat', 'deploy'], paths: { state: path.join(root, 'state'), config: path.join(root, 'config') }, ports: { webchat: 4999 }, extensions: { dirs: [exts], ...(disable ? { disable } : {}) } }, { home: root, dir: root });
  return { root, exts, c };
}

test('instance block: validated, dirs resolved; env names the resolved set and puts the tools first on PATH', () => {
  assert.throws(() => resolveInstance({ name: 'a', components: [], extensions: { dirs: [] } }), /non-empty list/);
  assert.throws(() => resolveInstance({ name: 'a', components: [], extensions: { dirs: ['x'], enable: [] } }), /unknown key extensions.enable/);
  const { c } = instance();
  const env = instanceEnv(c);
  assert.equal(env.TOPHAT_EXTENSIONS_FILE, path.join(c.paths.state, 'extensions', 'resolved.json'));
  assert.ok(env.PATH.startsWith(`${path.join(c.paths.state, 'extensions', 'bin')}:`));
  const plain = resolveInstance({ name: 'b', components: [] }, { home: '/h', dir: '/h' });
  assert.equal(instanceEnv(plain).TOPHAT_EXTENSIONS_FILE, undefined);
});

test('check: the kit gate loads the good extension and refuses the liar with its reason', async () => {
  const { c } = instance();
  assert.deepEqual(discover(c).map((d) => path.basename(d.dir)), ['hello', 'liar']);
  const r = await checkExtensions(c);
  assert.deepEqual(r.order, ['hello']);
  assert.deepEqual(r.refused.map((x) => [x.id, x.code]), [['liar', 'UNDECLARED_REGISTRATION']]);
});

test('build: resolved set + tool links; jobs become interval units; disabling unlinks the tool', async () => {
  const { c } = instance();
  const r = await buildExtensions(c);
  assert.deepEqual(r.order, ['hello']);
  assert.deepEqual(r.tools, ['hello-tool']);
  const resolved = readResolved(c);
  assert.deepEqual(resolved.extensions.map((e) => e.id), ['hello']);
  assert.equal(resolved.refused[0].id, 'liar');
  const link = path.join(c.paths.state, 'extensions', 'bin', 'hello-tool');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(readlinkSync(link).endsWith(path.join('hello', 'bin', 'hello-tool')));
  const jobs = instanceJobs(c, { configFile: '/x/demo.json' });
  const j = jobs.find((x) => x.job === 'ext-hello-tick');
  assert.deepEqual(j.args, ['ext', 'run-job', '--config', '/x/demo.json', 'hello', 'tick']);
  const unit = serviceUnit(c, { configFile: '/x/demo.json', bin: '/b/tophat-deploy.mjs', job: 'ext-hello-tick' });
  assert.match(unit, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.doesNotMatch(unit, /KeepAlive/);
  assert.throws(() => serviceUnit(c, { configFile: '/x/demo.json', kind: 'systemd', bin: '/b', job: 'ext-hello-tick' }), /systemd timer/);
  // planted: the extension is disabled, so its tool must disappear from PATH
  const off = { ...c, extensions: { ...c.extensions, disable: ['hello'] } };
  await buildExtensions(off);
  assert.equal(existsSync(link), false);
  assert.deepEqual(readResolved(off).extensions, []);
});

test('planted: a provided tool that does not exist (a dangling link) refuses its extension', async () => {
  const { c, exts } = instance();
  ext(exts, 'dangling', { provides: { tools: ['gone'] } }, `export default (x) => { x.tool('gone', 'bin/gone'); };`);
  const r = await checkExtensions(c);
  assert.deepEqual(r.order, ['hello']);
  assert.ok(r.refused.some((x) => x.id === 'dangling' && x.code === 'TOOL_MISSING'));
});

test('run-job: the job dispatches through the loopback route with the service token and its intent id', async () => {
  const { c } = instance();
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ ok: true }) }; };
  const r = await runJob(c, { id: 'hello', job: 'tick', fetcher, secrets: 'svc' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:4999/api/ext/dispatch');
  assert.equal(calls[0].init.headers.authorization, 'Bearer svc');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ext: 'hello', type: 'core.chat.inbound', payload: { text: 'tick' }, id: 'tick-1' });
  await assert.rejects(() => runJob(c, { id: 'liar', job: 'x', fetcher }), /not loaded: .*registers commands ext.liar.b/);
});
