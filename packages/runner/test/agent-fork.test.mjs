// The Agent tool forks the parent's session by default (rev6/pull/agents.mjs forkOpening + ledger.fork); fork=false keeps a fresh session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openLedger, buildMessages } from '../rev6/pull/ledger.mjs';
import { forkOpening } from '../rev6/pull/agents.mjs';

test('Agent schema has fork, default true', () => {
  const spec = JSON.parse(readFileSync(new URL('../rev6/pull/tools.json', import.meta.url), 'utf8')).agents.Agent;
  assert.match(spec.properties.fork, /^b:default true/);
});

test('a fork copies the parent history verbatim and answers the open Agent call before the new task', () => {
  const ledger = openLedger(':memory:'), at = '2026-11-18T00:00:00Z';
  ledger.ensureSession('p', { model: 'm', cwd: '/', at });
  ledger.append('p', 'user', 'owner', [{ type: 'text', text: 'hello' }], at);
  ledger.append('p', 'assistant', 'assistant', [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }], at);
  ledger.ensureSession('p/agent/a', { model: 'm', cwd: '/', forkedFrom: 'p', at });
  ledger.fork('p', 'p/agent/a');
  ledger.append('p/agent/a', 'user', 'owner', forkOpening(ledger.active('p/agent/a'), 'do the task'), at);
  const { messages, orphans } = buildMessages(ledger.active('p/agent/a'));
  assert.deepEqual(orphans, []);
  assert.deepEqual(messages.slice(0, 2).map((m) => m.content), buildMessages(ledger.active('p')).messages.slice(0, 2).map((m) => m.content));
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content.at(-1).text, 'do the task');
});
