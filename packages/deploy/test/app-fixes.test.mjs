// Behaviour of the assembled app that the instance depends on and no other offline test covered: the claude provider's
// hook scripts exist, the CLI's init event does not move a claude chat to the api-key runner, the auto model router
// runs on the claude provider too, and a chat a maintenance script wrote is not re-asked at boot. The modules are
// imported from the assembled packages as they are; they need no npm dependencies. HOME and every store are temporary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE } from '../src/components.mjs';
import { plan } from '../src/start.mjs';

const WEBCHAT = path.join(WORKSPACE, 'packages/webchat');
const lib = (rel) => import(pathToFileURL(path.join(WEBCHAT, 'src/lib', rel)).href);
const scratchDir = (name) => mkdtempSync(path.join(os.tmpdir(), `tophat-${name}-`));

// ---- 1. the claude provider's hook scripts ---------------------------------

/** The files the SessionStart and UserPromptSubmit hook commands of one claude spawn run. */
async function hookScripts(env) {
  const { argsFor } = await lib('server/providers/claude.js');
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  try {
    for (const k of ['TOPHAT_CONTEXT_HOOK', 'TOPHAT_RUNTIME_DIR']) delete process.env[k];
    Object.assign(process.env, env.set || {});
    process.chdir(env.cwd || WEBCHAT);
    const args = argsFor({ sessionId: '11111111-1111-4111-8111-111111111111', settings: { provider: 'claude', model: 'sonnet', permissionMode: 'bypassPermissions' }, cwd: os.tmpdir(), uploadRoot: os.tmpdir() });
    const flags = JSON.parse(args[args.indexOf('--settings') + 1]);
    const commands = Object.entries(flags.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, command: h.command }))));
    return commands.map(({ event, command }) => ({ event, script: [...command.matchAll(/'((?:[^']|'"'"')*)'/g)].map((m) => m[1]).filter((t) => t !== process.execPath).at(-1) }));
  } finally {
    process.chdir(saved.cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
  }
}

test('every script a hook setting names exists in the assembled tree (default path and the instance start path)', async () => {
  const fallback = await hookScripts({});
  assert.deepEqual(fallback.map((h) => h.event).sort(), ['SessionStart', 'UserPromptSubmit']);
  for (const { event, script } of fallback) assert.ok(script && existsSync(script), `${event} hook runs ${script}, which is not in the assembled tree`);

  // what `tophat start` hands the webchat: the hook the claude provider names is the one the package ships
  const dir = scratchDir('hook');
  try {
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'build/handler.js'), 'export const handler = () => {};\n');
    const cfg = path.join(dir, 'tophat.instance.json');
    writeFileSync(cfg, JSON.stringify({ name: 'demo', owner: { label: 'Sam' }, components: ['linknotes', 'runner', 'webchat', 'deploy'], paths: { state: './state', config: './config' } }));
    const p = plan({ configFile: cfg, root: WORKSPACE, env: { PATH: process.env.PATH, HOME: path.join(dir, 'home') }, buildDir: path.join(dir, 'build') });
    assert.equal(p.env.TOPHAT_CONTEXT_HOOK, path.join(WEBCHAT, 'scripts/context-hook.mjs'));
    // the runtime dir is the runner package there, which is why the path is named outright rather than derived from it
    const started = await hookScripts({ cwd: os.tmpdir(), set: { TOPHAT_CONTEXT_HOOK: p.env.TOPHAT_CONTEXT_HOOK, TOPHAT_RUNTIME_DIR: p.env.TOPHAT_RUNTIME_DIR } });
    for (const { event, script } of started) assert.ok(existsSync(script), `${event} hook runs ${script}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the context hook prints nothing without an instance retrieval command, and the command\'s output with one', () => {
  const hook = path.join(WEBCHAT, 'scripts/context-hook.mjs');
  assert.ok(existsSync(hook), 'scripts/context-hook.mjs is assembled');
  const dir = scratchDir('hookrun');
  try {
    const run = (extra) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'what is on today', cwd: dir }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ...extra } });
    const none = run({});
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, '', 'no retrieval command: empty context, not a failure notice');
    const cli = path.join(dir, 'cli.mjs');
    writeFileSync(cli, "const i = process.argv.indexOf('--query'); process.stdout.write('CONTEXT FOR ' + process.argv[i + 1]);\n");
    const some = run({ TOPHAT_CONTEXT_CLI: cli });
    assert.equal(some.status, 0, some.stderr);
    assert.equal(some.stdout, 'CONTEXT FOR what is on today');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 2. the init event does not move a claude chat to the direct runner -----

const CLAUDE = { provider: 'claude', model: 'sonnet', autoModel: true, fastMode: false, permissionMode: 'bypassPermissions', reasoningEffort: 'medium', cwd: null };

test('a claude chat keeps its provider when the CLI init reports the full model id', async () => {
  const { normalizeSettings } = await lib('core/contract.js');
  // exactly the settings the translator writes for the init event: a model and a permission mode, no provider
  const afterInit = normalizeSettings({ model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions' }, CLAUDE);
  assert.equal(afterInit.provider, 'claude');
  assert.equal(afterInit.model, 'sonnet', 'the id reads as the alias the CLI takes back');
  assert.equal(normalizeSettings({ model: 'claude-opus-5-5' }, { ...CLAUDE, model: 'opus' }).provider, 'claude');
  assert.equal(normalizeSettings({ model: 'claude-fable-5-1' }, CLAUDE).model, 'fable');
  assert.equal(normalizeSettings({ model: 'claude-haiku-4-5-20251001' }, CLAUDE).model, 'haiku');
});

test('the same init event through the reducer leaves the chat on claude', async () => {
  const { makeEvent } = await lib('core/contract.js');
  const { rebuild } = await lib('core/reducer.js');
  const at = new Date().toISOString();
  const events = [
    makeEvent({ kind: 'conversation.created', conversationId: 'c1', cursor: 1, at, content: { title: 'x', settings: { provider: 'claude', model: 'sonnet' }, cwd: null } }),
    makeEvent({ kind: 'conversation.meta', conversationId: 'c1', cursor: 2, at, content: { sessionId: 's1', settings: { model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions' } } })
  ];
  const settings = rebuild(events).conversations.c1.settings;
  assert.equal(settings.provider, 'claude');
  assert.equal(settings.model, 'sonnet');
});

test('chats that really are direct, or are moved on purpose, behave as before', async () => {
  const { normalizeSettings } = await lib('core/contract.js');
  const direct = { ...CLAUDE, provider: 'direct', model: 'claude-sonnet-5-5' };
  assert.equal(normalizeSettings({ model: 'claude-opus-5-5' }, direct).provider, 'direct');
  assert.equal(normalizeSettings({ model: 'claude-opus-5-5' }, direct).model, 'claude-opus-5-5');
  assert.equal(normalizeSettings({ model: 'claude-sonnet-5-5' }, {}).provider, 'direct', 'no provider anywhere: the model decides');
  // an explicit provider always wins, and a claude alias still moves a direct chat to claude
  assert.equal(normalizeSettings({ provider: 'direct', model: 'claude-sonnet-5-5' }, CLAUDE).provider, 'direct');
  assert.equal(normalizeSettings({ model: 'opus' }, direct).provider, 'claude');
  assert.equal(normalizeSettings({ model: 'gpt-6-astra' }, CLAUDE).provider, 'codex');
});

// ---- 3. the auto router on the claude provider ------------------------------

const COLD = { idleMs: 2 * 3_600_000, turns: 40 };
const WARM = { idleMs: 60_000, turns: 40 };

test('auto routing sets the claude alias without switching provider', async () => {
  const { routePatch } = await lib('core/model-route.js');
  const { normalizeSettings } = await lib('core/contract.js');
  assert.deepEqual(routePatch({ ...CLAUDE, model: 'opus' }, 'what was the last deploy?', COLD), { model: 'sonnet' });
  assert.deepEqual(routePatch(CLAUDE, 'fix the header and add a test', COLD), { model: 'opus' });
  assert.deepEqual(routePatch(CLAUDE, 'fix the header', { turns: 1, idleMs: 0 }), { model: 'opus' }, 'a small chat may flip');
  assert.equal(routePatch(CLAUDE, 'fix the header', WARM), null, 'a warm chat keeps its cache, as on direct');
  assert.equal(routePatch(CLAUDE, 'what was the last deploy?', COLD), null, 'already on the family');
  assert.equal(routePatch({ ...CLAUDE, model: 'haiku' }, 'fix the header', COLD), null);
  assert.equal(routePatch({ ...CLAUDE, model: 'fable' }, 'fix the header', COLD), null, 'fable is not a gate family');
  assert.equal(routePatch({ ...CLAUDE, autoModel: false, model: 'opus' }, 'what was it?', COLD), null, 'a model picked by hand turns it off');
  // applying the patch the way the server does keeps the chat on claude
  const merged = normalizeSettings(routePatch(CLAUDE, 'fix the header', COLD), CLAUDE);
  assert.equal(merged.provider, 'claude');
  assert.equal(merged.model, 'opus');
});

test('auto routing is defined where the gate has families to choose between; direct is unchanged', async () => {
  const { routePatch } = await lib('core/model-route.js');
  assert.deepEqual(routePatch({ provider: 'direct', model: 'claude-sonnet-5-5', autoModel: true }, 'fix the header', COLD), { model: 'claude-opus-5-5' });
  assert.deepEqual(routePatch({ model: 'claude-opus-5-5', autoModel: true }, 'what was it?', COLD), { model: 'claude-sonnet-5-5' }, 'no provider reads as direct');
  // codex and kimi have no opus/sonnet gate: routing across providers would be wrong, so they are left alone
  assert.equal(routePatch({ provider: 'codex', model: 'gpt-6-astra', autoModel: true }, 'fix the header', COLD), null);
  assert.equal(routePatch({ provider: 'kimi', model: 'kimi-k3', autoModel: true }, 'fix the header', COLD), null);
});

// ---- 4. a script-written chat is not a run this server owes ------------------

const owed = (store) => store.unfinished({ includeIds: true }).map(({ id, text }) => `${id}:${text}`);

test('a chat a script wrote through openStoreForScript is not re-asked by the next boot; the server\'s own is', async () => {
  const { openStoreForScript, openLegacyStore } = await lib('server/store.js');
  const dir = scratchDir('script');
  const file = path.join(dir, 'events.sqlite');
  try {
    const at = new Date().toISOString();
    const script = openStoreForScript(file);
    script.ensureConversation('imported-1', { at, title: 'imported', source: 'claude-cli' });
    script.append('imported-1', 'message.user', { itemId: 'u1', text: 'an old ask' }, { at });
    script.append('imported-1', 'assistant.message', { itemId: 'a1', text: 'an answer' }, { at });
    script.append('imported-1', 'message.user', { itemId: 'u2', text: 'the last thing said' }, { at });
    script.close();

    const server = openLegacyStore(file);
    try {
      const stored = [...server.allConversationEvents('imported-1')].filter((e) => e.kind === 'message.user');
      assert.deepEqual(stored.map((e) => e.content.text), ['an old ask', 'the last thing said'], 'the transcript is intact');
      assert.ok(stored.every((e) => e.content.writtenBy === 'script'));
      assert.deepEqual(owed(server), [], 'a trailing script-written message.user is history, not an unfinished run');

      // a live chat of this server, ending the same way, is still owed
      server.ensureConversation('live-1', { at, title: 'live' });
      server.append('live-1', 'message.user', { itemId: 'l1', text: 'ask the server took' }, { at });
      assert.deepEqual(owed(server), ['live-1:ask the server took']);

      // a script chat the owner then continues in the webchat: only his own message is owed
      server.append('imported-1', 'message.user', { itemId: 'u3', text: 'a follow-up typed in the app' }, { at });
      assert.deepEqual(owed(server).sort(), ['imported-1:a follow-up typed in the app', 'live-1:ask the server took']);
    } finally { server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the log-first store folds the same rule', async () => {
  const { openLogStore } = await lib('server/log-store.js');
  const dir = scratchDir('logstore');
  const at = new Date().toISOString();
  const store = openLogStore(dir, { transport: 'inline', probeEveryMs: 0, log: { error() {}, warn() {}, log() {} } });
  try {
    store.ensureConversation('c-script', { at, title: 'written by a script' });
    store.append('c-script', 'message.user', { itemId: 'u1', text: 'from a script', writtenBy: 'script' }, { at });
    store.ensureConversation('c-live', { at, title: 'live' });
    store.append('c-live', 'message.user', { itemId: 'u2', text: 'from the server' }, { at });
    await store.flush?.();
    assert.deepEqual(owed(store), ['c-live:from the server']);
  } finally { await store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

// ASSEMBLY.json is export-ignored (it names the private source layout), so a clean release tree has none.
test('the assembly record names the context hook and carries no hand edits of the fixed modules', { skip: !existsSync(path.join(WORKSPACE, 'ASSEMBLY.json')) && 'no ASSEMBLY.json in a release tree' }, () => {
  const m = JSON.parse(readFileSync(path.join(WORKSPACE, 'ASSEMBLY.json'), 'utf8'));
  assert.ok(m.files['packages/webchat/scripts/context-hook.mjs'], 'the hook is part of the assembly');
  for (const f of ['core/contract.js', 'core/model-route.js', 'server/store.js', 'server/store-shared.js', 'server/log-store.js']) {
    assert.equal(m.files[`packages/webchat/src/lib/${f}`]?.kind, 'transformed', `${f} carries its assembly transform`);
  }
});
