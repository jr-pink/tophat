// Same-process frame plumbing: virtual target ids and execution-context lookup, on a fake socket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameConn, contextFor, frameOf, isVirtual, rootOf, virtualId } from '../cdp/browser/frames.mjs';

const ctx = (id, frameId, extra = {}) => ({ method: 'Runtime.executionContextCreated', params: { context: { id, auxData: { frameId, isDefault: true, type: 'default', ...extra } } } });
const fakeConn = (events) => ({ events, sent: [], __runtimeEnabled: true,
  async send(method, params) { this.sent.push([method, params]); return { result: {} }; }, focusEmulation: async () => true });

test('virtual ids round-trip and never look like a plain target', () => {
  const v = virtualId('AAAA1111', 'FRAME2');
  assert.equal(v, 'AAAA1111@FRAME2');
  assert.ok(isVirtual(v)); assert.ok(!isVirtual('AAAA1111'));
  assert.equal(rootOf(v), 'AAAA1111'); assert.equal(frameOf(v), 'FRAME2');
  assert.equal(rootOf(virtualId(v, 'FRAME3')), 'AAAA1111', 'a frame inside a virtual frame stays on the same socket');
});

test('contextFor picks the default-world context of that frame, honouring destroy and clear', async () => {
  const events = [ctx(1, 'F1'), ctx(2, 'F2', { isDefault: false, type: 'isolated' }), ctx(3, 'F2'), ctx(4, 'F3')];
  assert.equal(await contextFor(fakeConn(events), 'f2'), 3);
  events.push({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 3 } }, ctx(9, 'F2'));
  assert.equal(await contextFor(fakeConn(events), 'F2'), 9, 'a navigated frame resolves to its new context');
  events.push({ method: 'Runtime.executionContextsCleared', params: {} });
  await assert.rejects(contextFor(fakeConn(events), 'F2', 120), /no execution context for frame F2/);
});

test('FrameConn evaluates in the frame context and leaves other methods alone', async () => {
  const base = fakeConn([ctx(7, 'FX')]), fc = new FrameConn(base, 'FX');
  await fc.send('Runtime.evaluate', { expression: '1' });
  await fc.send('DOM.describeNode', { objectId: 'o' });
  assert.deepEqual(base.sent[0], ['Runtime.evaluate', { expression: '1', contextId: 7 }]);
  assert.deepEqual(base.sent[1], ['DOM.describeNode', { objectId: 'o' }]);
  await assert.rejects(contextFor({ send: async () => ({}) }, 'F'), /direct DevTools socket/);
});
