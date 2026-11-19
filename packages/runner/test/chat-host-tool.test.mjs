// chat_host / chat_workspace reach the webchat's /api/agent as ops host and workspace for this runner's own conversation only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatTools } from '../rev6/pull/chat.mjs';
import { chatSpecs } from '../rev6/pull/tools.mjs';

function tools(t, reply = { ok: true }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-host-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'webchat-service-token'), 'tok\n');
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return { ok: reply.status === undefined, status: reply.status || 200, text: async () => JSON.stringify(reply) }; };
  return { chat: createChatTools({ env: { TOPHAT_SECRETS_DIR: dir, TOPHAT_WEBCHAT_AGENT_URL: 'http://x/api/agent' }, conversationId: 'c-1', fetchImpl }), sent };
}

test('chat_host posts op host for this conversation with the service token and returns the read-back', async (t) => {
  const { chat, sent } = tools(t, { ok: true, id: 'c-1', host: 'teamhost-tophat', label: 'teamhost', changed: true });
  const out = await chat.chat_host({ host: '  teamhost ' });
  assert.equal(out.host, 'teamhost-tophat');
  assert.deepEqual(sent[0].body, { op: 'host', host: 'teamhost', conversationId: 'c-1' });
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.match((await chat.chat_host({})).error, /needs a host/);
});

test('chat_host surfaces the webchat error (unknown host lists the hosts)', async (t) => {
  const { chat } = tools(t, { status: 400, error: 'no host "x"; hosts this chat can run on: local (a), teamhost' });
  assert.match((await chat.chat_host({ host: 'x' })).error, /hosts this chat can run on/);
});

test('chat_workspace sends create only when asked', async (t) => {
  const { chat, sent } = tools(t);
  await chat.chat_workspace({ workspace: 'Notes' });
  await chat.chat_workspace({ workspace: 'New', create: true });
  assert.deepEqual(sent.map((s) => s.body.create), [undefined, true]);
});

test('the specs offer chat_host and describe the folder refusal', () => {
  const specs = chatSpecs();
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  assert.ok(byName.chat_host, 'chat_host is a tool');
  assert.match(byName.chat_workspace.description, /refused.*existing folders/s);
});
