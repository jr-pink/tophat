import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { world, settle } from '@tophat-md/linknotes/testing';
import { contextFor, runOnce } from '../index.mjs';

let w;
after(async () => { await w?.close(); });
test('context carries shared and own-private notes for the asker and never the other party\'s private notes; the runner calls the provider once', async () => {
  w = await world();
  const A = w.sqlite('qa'), B = w.sqlite('qb');
  await A.createScope('qa'); await A.createScope('qshared'); await B.createScope('qb');
  await settle(A, B); await A.addMember('qshared', 'qb', 'write'); await settle(A, B);
  const r = await A.apply({ entities: [{ id: '$t', name: 'Water Boiler', type: 'artifact', scopes: ['qa', 'qshared'] }],
    notes: [{ body: 'The water boiler holds 200 litres.', entities: ['$t'], scopes: ['qshared'] }, { body: 'PRIVATE: the boiler was a gift.', entities: ['$t'], scopes: ['qa'] }] }, { scopes: ['qa', 'qshared'] });
  await settle(A, B);
  await B.apply({ notes: [{ body: 'B-OWN: the boiler sits by the window.', entities: [r.id_map.$t], scopes: ['qb'] }] });
  const ctx = await contextFor(B, 'how big is the water boiler?');
  assert.match(ctx.text, /200 litres/); assert.match(ctx.text, /B-OWN/); assert.doesNotMatch(ctx.text, /PRIVATE/);
  let calls = 0;
  const provider = { async complete({ user }) { calls++; assert.match(user, /QUESTION\nhow big/); return { text: '200 litres [P1]', usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' }; } };
  const out = await runOnce(B, provider, 'how big is the water boiler?');
  assert.equal(out.answer, '200 litres [P1]'); assert.equal(calls, 1);
});
