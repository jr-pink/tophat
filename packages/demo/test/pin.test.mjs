// What a visitor may not choose: every action that can set a conversation's settings or working directory is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinAction } from '../src/pin.mjs';

const pin = { model: 'claude-haiku-5-5', cwd: '/w' };
const hostile = { provider: 'claude', model: 'claude-opus-5-5', autoModel: true, permissionMode: 'plan', fastMode: true, reasoningEffort: 'high', cwd: '/etc' };

for (const op of ['conversation.create', 'conversation.fork', 'conversation.set_settings', 'message.send']) {
  test(`${op}: settings are pinned, whatever the page sent`, () => {
    const a = pinAction({ op, payload: { settings: { ...hostile }, cwd: '/etc', text: 'x' } }, pin);
    assert.deepEqual(a.payload.settings, { provider: 'direct', model: 'claude-haiku-5-5', autoModel: false, permissionMode: 'bypassPermissions', fastMode: false, reasoningEffort: 'medium', cwd: '/w' });
    if (op !== 'conversation.set_settings') assert.equal(a.payload.cwd, '/w');
  });
}

test('a message that sends no settings still gets pinned ones (it creates the chat when the id is new)', () => {
  const a = pinAction({ op: 'message.send', conversation_id: 'new', payload: { text: 'hi' } }, pin);
  assert.equal(a.payload.settings.provider, 'direct');
  assert.equal(a.payload.cwd, '/w');
});

test('other actions pass untouched', () => {
  const a = { op: 'conversation.rename', payload: { title: 't' } };
  assert.deepEqual(pinAction(structuredClone(a), pin), a);
});
