// The unsaved-form store on /secrets (core/secret-draft-state.js): a draft lives in the store, not in a component, so a re-render,
// a list refresh, a search or a reload cannot lose it; only clear() removes it; and it is kept in the tab's sessionStorage, never
// in localStorage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../runner/tools/docstore-kit/lib/model.js';
import { DRAFT_KEY_NEW, cleanData, editKey, secretDrafts } from '../src/lib/core/secret-draft-state.js';
import { draftIsDirty } from '../src/lib/core/secret-form.js';

const box = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] }; };
const open = (local, tab) => createApp({ storage: local, tabStorage: tab, engine: false });

test('typing patches the draft and the record is written to the tab storage, not to localStorage', () => {
  const local = box(), tab = box();
  const app = open(local, tab);
  const r = secretDrafts.use(app, DRAFT_KEY_NEW);
  r.dispatch('draft.set', { data: { kind: 'card' } });
  r.dispatch('draft.patch', { name: 'Test card', number: '4242' });
  app.flush();
  assert.deepEqual(r.get().data, { kind: 'card', name: 'Test card', number: '4242' });
  assert.ok(tab.getItem('qk:secret-draft:new'), 'in sessionStorage');
  assert.ok(![...local.m.keys()].some((k) => k.includes('secret-draft')), 'never in localStorage');
});

test('a reload (a new app over the same tab storage) finds the draft as it was', () => {
  const local = box(), tab = box();
  const first = open(local, tab);
  const r = secretDrafts.use(first, DRAFT_KEY_NEW);
  r.dispatch('draft.set', { data: { kind: 'login' } });
  r.dispatch('draft.patch', { name: 'half typed', password: 'p/w' });
  first.flush();
  const second = open(local, tab);
  const again = secretDrafts.use(second, DRAFT_KEY_NEW);
  assert.deepEqual(again.get().data, { kind: 'login', name: 'half typed', password: 'p/w' });
  assert.deepEqual(secretDrafts.keys(tab), ['new']);
});

test('nothing but an explicit clear removes it: a re-read, a patch of another form and a second subscriber leave it', () => {
  const tab = box();
  const app = open(box(), tab);
  const a = secretDrafts.use(app, DRAFT_KEY_NEW);
  a.dispatch('draft.patch', { name: 'keep me' });
  const other = secretDrafts.use(app, editKey('some-id'));
  other.dispatch('draft.set', { data: { name: 'x' }, base: { name: 'y' } });
  const seen = [];
  const stop = a.subscribe((s) => seen.push(s.data.name));
  stop();
  assert.equal(secretDrafts.use(app, DRAFT_KEY_NEW).get().data.name, 'keep me');
  a.dispatch('draft.clear', {});
  app.flush();
  assert.deepEqual(a.get().data, {});
  assert.equal(tab.getItem('qk:secret-draft:new'), null, 'the record is gone, not an empty husk');
  assert.ok(tab.getItem('qk:secret-draft:edit:some-id'), 'the other form is untouched');
});

test('an edit draft carries its base, so "unsaved" means "differs from what was loaded"', () => {
  const app = open(box(), box());
  const r = secretDrafts.use(app, editKey('c1'));
  const loaded = { kind: 'card', name: 'Zed', number: '4242' };
  r.dispatch('draft.set', { data: loaded, base: loaded });
  assert.equal(draftIsDirty(r.get().data, r.get().base), false);
  r.dispatch('draft.patch', { name: 'Zed 2' });
  assert.equal(draftIsDirty(r.get().data, r.get().base), true);
  r.dispatch('draft.patch', { name: 'Zed' });
  assert.equal(draftIsDirty(r.get().data, r.get().base), false);
});

test('a bad record (not strings, absurd keys) is repaired, never thrown', () => {
  assert.deepEqual(cleanData({ a: 'x', b: 3, c: null, ['k'.repeat(50)]: 'long key' }), { a: 'x' });
  assert.deepEqual(cleanData('nope'), {});
  const tab = box();
  tab.setItem('qk:secret-draft:new', '{"version":1,"base":{"data":[1,2],"base":"x"}}');
  const r = secretDrafts.use(open(box(), tab), DRAFT_KEY_NEW);
  assert.deepEqual(r.get().data, {});
});
