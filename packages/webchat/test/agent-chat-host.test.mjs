// chat_host and chat_workspace (rev6/pull/chat.mjs -> /api/agent ops host and workspace): the agent does what the chat menu does.
// the owner 2026-11-18 14:17 PST: "subagent fix the fact that u cant move a chat to teamhost , i can with my menu selector u should be able
// to do anything i can do"; and on folders, "don't create folders like that". The menu's host selector dispatches ACTIONS.HOST
// (conversation.set_host) through applyAction, whose case calls applyHostAction; the agent op must reach the very same function with the
// very same action, so this fails the day either side changes without the other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS } from '../src/lib/core/contract.js';
import { openLegacyStore } from '../src/lib/server/store.js';
import { applyHostAction, fileChatWorkspace, moveChatHost, resolveHost } from '../src/lib/server/agent-chat-ops.js';

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const hosts = [
  { id: '', label: 'home-mac', local: true, configured: true },
  { id: 'teamhost-tophat', label: 'teamhost', local: false, configured: true },
  { id: 'teamhost-other', label: 'teamhost-other', local: false, configured: false }
];

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-host-')));
  const store = openLegacyStore(join(dir, 'events.sqlite'));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['menu', 'agent']) {
    store.ensureConversation(id, { at: '2026-11-18T00:00:00.000Z', cwd: '/tmp', settings: {}, title: id });
    store.append(id, 'conversation.created', { title: id, settings: {}, cwd: '/tmp' }, { at: '2026-11-18T00:00:00.000Z' });
  }
  // The server's applyAction for the actions under test, using the shared event writers (app.js's cases call the same ones).
  const calls = [];
  const apply = (action) => {
    calls.push(action);
    const at = '2026-11-18T00:00:01.000Z';
    if (action.op === ACTIONS.HOST) applyHostAction({ store, id: action.conversation_id, payload: action.payload, at });
    else if (action.op === ACTIONS.WORKSPACE) store.append(action.conversation_id, 'conversation.workspace', { workspace: action.payload.workspace }, { at });
    else throw new Error(`unexpected ${action.op}`);
  };
  const hostEvents = (id) => [...store.allConversationEvents(id)].filter((e) => e.kind === 'conversation.host').map((e) => e.content);
  return { store, apply, calls, hostEvents };
}

test('resolveHost: teamhost by label or id, local by any of its names; unknown and addressless hosts are refused with the list', () => {
  assert.deepEqual(resolveHost(hosts, 'teamhost'), { host: 'teamhost-tophat', label: 'teamhost' });
  assert.equal(resolveHost(hosts, ' TeamHost ').host, 'teamhost-tophat');
  assert.equal(resolveHost(hosts, 'teamhost-tophat').host, 'teamhost-tophat');
  for (const w of ['local', 'this host', '', 'home-mac']) assert.equal(resolveHost(hosts, w).host, '', w);
  assert.match(resolveHost(hosts, 'mars').error, /no host "mars".*local \(home-mac\), teamhost \(teamhost-tophat\)/);
  assert.match(resolveHost(hosts, 'teamhost-other').error, /no address/);
});

test('the agent moves a chat exactly as the menu does: same action, same event, read back; idempotent', (t) => {
  const { store, apply, calls, hostEvents } = setup(t);
  // The menu: ACTIONS.HOST with { host } (session.js setHost) -> applyAction.
  apply({ op: ACTIONS.HOST, conversation_id: 'menu', payload: { host: 'teamhost-tophat' } });
  const moved = moveChatHost({ store, apply, hosts, id: 'agent', host: 'teamhost' });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body, { ok: true, id: 'agent', host: 'teamhost-tophat', label: 'teamhost', changed: true });
  assert.deepEqual(calls[1], { ...calls[0], conversation_id: 'agent' }, 'the agent sends the action the menu sends');
  assert.deepEqual(hostEvents('agent'), hostEvents('menu'), 'same conversation.host event, no auto flag (his choice, never the router\'s)');
  assert.equal(store.conversation('agent').host, 'teamhost-tophat');
  const again = moveChatHost({ store, apply, hosts, id: 'agent', host: 'teamhost' });
  assert.equal(again.body.changed, false);
  assert.equal(hostEvents('agent').length, 1, 'a repeat appends nothing');
  const back = moveChatHost({ store, apply, hosts, id: 'agent', host: 'local' });
  assert.deepEqual(back.body, { ok: true, id: 'agent', host: null, label: 'home-mac', changed: true });
  assert.equal(store.conversation('agent').host, null);
  apply({ op: ACTIONS.HOST, conversation_id: 'menu', payload: { host: null } });
  assert.deepEqual(hostEvents('agent'), hostEvents('menu'));
});

test('an unknown host changes nothing', (t) => {
  const { store, apply, calls } = setup(t);
  const r = moveChatHost({ store, apply, hosts, id: 'agent', host: 'nowhere' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('menu and agent paths cannot drift: both reach ACTIONS.HOST -> applyHostAction in the source', () => {
  const app = src('lib/server/app.js');
  assert.match(app, /case ACTIONS\.HOST:\s*applyHostAction\(\{ store, id, payload, at \}\)/, 'applyAction writes the host through the shared writer');
  for (const f of ['lib/client/session.js', 'lib/engine/session-host.js']) assert.match(src(f), /setHost: \([^)]*\) => dispatch\(ACTIONS\.HOST, [^,]+, \{ host: host \|\| null \}\)/, `${f} setHost`);
  const ops = src('lib/server/agent-chat-ops.js');
  assert.match(ops, /apply\(\{ op: ACTIONS\.HOST, conversation_id: id, payload: \{ host: r\.host \|\| null \} \}\)/, 'the agent applies the menu\'s action');
  const route = src('routes/api/agent/+server.js');
  assert.match(route, /op === 'host'[\s\S]{0,700}moveChatHost\(\{ store: app\.store, apply: applyAction, hosts: listHosts\(\)/, 'the route moves hosts through applyAction and the same host list the menu reads');
  const hostsRoute = src('routes/api/hosts/+server.js');
  assert.match(hostsRoute, /listHosts\(\)/, 'the menu lists hosts from listHosts too');
});

test('the runner tool sends op host and is registered with a spec', async () => {
  const chat = readFileSync(new URL('../../runner/rev6/pull/chat.mjs', import.meta.url), 'utf8');
  assert.match(chat, /async chat_host\(i\)[\s\S]{0,600}call\(\{ op: 'host', host \}\)/);
  assert.match(readFileSync(new URL('../../runner/rev6/pull/tools.mjs', import.meta.url), 'utf8'), /chat_host: \(i\) => chat\.chat_host\(i\)/);
  assert.ok(JSON.parse(readFileSync(new URL('../../runner/rev6/pull/tools.json', import.meta.url), 'utf8')).chat.chat_host.properties.host);
});

test('chat_workspace: an existing folder files (under its own spelling), an unknown name is refused with the folder list, create=true makes one', (t) => {
  const { apply, calls } = setup(t);
  const folders = ['Notes', 'Team Ops'];
  const ok = fileChatWorkspace({ apply, id: 'agent', workspace: 'notes', folders });
  assert.deepEqual(ok.body, { ok: true, id: 'agent', workspace: 'Notes', created: false });
  const refused = fileChatWorkspace({ apply, id: 'agent', workspace: 'Teamhost', folders });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no folder "Teamhost".*Existing folders: Notes, Team Ops.*create=true/);
  assert.equal(calls.length, 1, 'the refusal filed nothing');
  const made = fileChatWorkspace({ apply, id: 'agent', workspace: 'Teamhost', folders, create: true });
  assert.deepEqual(made.body, { ok: true, id: 'agent', workspace: 'Teamhost', created: true });
  const out = fileChatWorkspace({ apply, id: 'agent', workspace: '', folders });
  assert.equal(out.body.workspace, null);
  assert.equal(calls.at(-1).payload.workspace, null);
});
