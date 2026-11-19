// The credential form's model (core/secret-form.js): what a card saves as, what a draft is worth, what an edit round-trips.
// Fake values only (a Stripe test number).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KINDS, blankDraft, buildEntry, canEdit, cardBrand, deriveId, describeRevealed, draftFromEntry, draftHasContent,
  draftIsDirty, luhnOk, normalizeExpiry, uiKind, visibleGroups
} from '../src/lib/core/secret-form.js';

const card = { kind: 'card', name: 'Test card', holder: 'A Person', number: '4242 4242 4242 4242', exp: '7/2029', cvc: '913',
  line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', authorization: 'tests only', notes: 'n' };

test('the form offers login, card, secret, note and the other vault types', () => {
  const ids = KINDS.map((k) => k.id);
  for (const id of ['login', 'card', 'secret', 'note', 'totp', 'ssh-key', 'oauth', 'recovery-codes', 'passkey-reference']) assert.ok(ids.includes(id), id);
});

test('a card saves as the existing JSON string shape tophat-pass prints: a `secret` entry named card-<brand>-<last4>', () => {
  const r = buildEntry(card, { today: '2026-11-18' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.id, 'card-visa-4242');
  assert.equal(r.entry.kind, 'secret');
  assert.deepEqual(r.entry.groups, ['kind:card']);
  assert.equal(typeof r.entry.value, 'string');
  assert.deepEqual(Object.keys(JSON.parse(r.entry.value)), ['label', 'name_on_card', 'number', 'exp', 'cvc', 'billing_address', 'authorization', 'added']);
  assert.deepEqual(JSON.parse(r.entry.value), { label: 'Test card', name_on_card: 'A Person', number: '4242424242424242', exp: '07/29', cvc: '913',
    billing_address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' }, authorization: 'tests only', added: '2026-11-18' });
  assert.equal(r.entry.notes, 'n');
});

test('a taken card id gets a numeric suffix; an edit keeps its own id', () => {
  assert.equal(buildEntry(card, { taken: new Set(['card-visa-4242']) }).id, 'card-visa-4242-2');
  assert.equal(buildEntry(card, { taken: new Set(['card-visa-4242']), editId: 'card-visa-4242' }).id, 'card-visa-4242');
});

test('card validation names the field and never blocks on the checksum alone', () => {
  assert.deepEqual(Object.keys(buildEntry({ kind: 'card', name: 'x' }).errors), ['number']);
  assert.ok(buildEntry({ ...card, number: '1234' }).errors.number);
  assert.ok(buildEntry({ ...card, exp: '13/29' }).errors.exp);
  assert.ok(buildEntry({ ...card, cvc: '12' }).errors.cvc);
  const odd = buildEntry({ ...card, number: '4242424242424241' });
  assert.equal(odd.ok, true);
  assert.equal(odd.warnings.length, 1);
});

test('card helpers', () => {
  assert.equal(cardBrand('5555555555554444'), 'mastercard');
  assert.equal(cardBrand('378282246310005'), 'amex');
  assert.equal(luhnOk('4242424242424242'), true);
  assert.equal(luhnOk('4242424242424241'), false);
  assert.equal(normalizeExpiry('0729'), '07/29');
  assert.equal(normalizeExpiry('7 / 2029'), '07/29');
  assert.equal(normalizeExpiry('00/29'), null);
});

test('a login derives its name and id from the site and the user, and needs a password', () => {
  const r = buildEntry({ kind: 'login', website: 'https://www.Example.com/x', username: 'me@e.co', password: 'pw' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.name, 'example.com (me@e.co)');
  assert.equal(r.id, 'example-com-me-e-co');
  assert.deepEqual(r.entry.origins, ['https://www.Example.com/x']);
  assert.deepEqual(r.entry.value, { password: 'pw', usernames: ['me@e.co'] });
  assert.ok(buildEntry({ kind: 'login', name: 'a' }).errors.password);
});

test('secret, note, totp, recovery codes, passkey build the values the vault validates', () => {
  assert.equal(buildEntry({ kind: 'secret', name: 'k', secretValue: 'sk-1' }).entry.value, 'sk-1');
  const note = buildEntry({ kind: 'note', name: 'n', noteText: 'hello' });
  assert.deepEqual(note.entry.groups, ['kind:note']);
  assert.equal(uiKind({ id: 'n', kind: 'secret', groups: note.entry.groups }), 'note');
  assert.equal(buildEntry({ kind: 'totp', name: 't', totpSecret: 'JBSWY3DPEHPK3PXP' }).entry.kind, 'totp');
  assert.deepEqual(buildEntry({ kind: 'recovery-codes', name: 'r', recoveryCodes: 'a\nb\n\na' }).entry.value, ['a', 'b']);
  const pk = buildEntry({ kind: 'passkey-reference', name: 'p', website: 'https://example.com/login', provider: 'iCloud' });
  assert.deepEqual(pk.entry.value, { rpId: 'example.com', provider: 'iCloud' });
  assert.ok(buildEntry({ kind: 'oauth', name: 'o', account: 'a' }).errors.accessToken);
});

test('every kind with its required fields filled builds', () => {
  const full = { name: 'x', password: 'p', secretValue: 's', noteText: 'n', totpSecret: 'JBSWY3DPEHPK3PXP', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx',
    account: 'a', accessToken: 't', recoveryCodes: 'c', website: 'example.com', provider: 'p', number: '4242424242424242' };
  for (const { id } of KINDS) assert.equal(buildEntry({ ...full, kind: id }).ok, true, id);
});

test('uiKind reads a legacy card by its id prefix and hides the type tags from the group list', () => {
  assert.equal(uiKind({ id: 'card-mastercard-1234', kind: 'secret', groups: [] }), 'card');
  assert.equal(uiKind({ id: 'x', kind: 'secret', groups: [] }), 'secret');
  assert.equal(uiKind({ id: 'x', kind: 'login' }), 'login');
  assert.deepEqual(visibleGroups(['work', 'kind:card']), ['work']);
});

test('editing round-trips: what the form does not edit is written back (a login keeps its emails, phones and extra sites)', () => {
  const meta = { id: 'l', name: 'L', kind: 'login', origins: ['https://a.com', 'https://b.com'], groups: ['work'], notes: '' };
  const revealed = { value: { usernames: ['u', 'u2'], emails: ['e@x.co'], phones: ['5551234'], password: 'pw', totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } }, notes: 'nn' };
  const data = draftFromEntry(meta, revealed);
  assert.equal(data.username, 'u'); assert.equal(data.website, 'a.com'); assert.equal(data.notes, 'nn');
  const r = buildEntry({ ...data, password: 'new' }, { editId: 'l' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry.origins, ['https://a.com', 'https://b.com']);
  assert.deepEqual(r.entry.value, { password: 'new', usernames: ['u', 'u2'], emails: ['e@x.co'], phones: ['5551234'], totp: revealed.value.totp });
});

test('editing a card keeps its added date and any field the form does not know', () => {
  const stored = JSON.stringify({ label: 'Old', name_on_card: 'A', number: '4242424242424242', exp: '07/29', cvc: '913',
    billing_address: { line1: '1', city: 'c', state: 's', postal_code: 'z', country: 'US', line2: 'apt 4' }, authorization: 'a', added: '2026-01-02', extra: 'keep' });
  const data = draftFromEntry({ id: 'card-visa-4242', name: 'card-visa-4242', kind: 'secret', groups: [], origins: [] }, { value: stored });
  const r = buildEntry({ ...data, cvc: '914' }, { editId: 'card-visa-4242', today: '2026-11-18' });
  const out = JSON.parse(r.entry.value);
  assert.equal(out.added, '2026-01-02'); assert.equal(out.extra, 'keep'); assert.equal(out.billing_address.line2, 'apt 4'); assert.equal(out.cvc, '914');
  assert.equal(r.entry.groups.includes('kind:card'), true);
  assert.equal(canEdit({ kind: 'totp' }), false);
});

test('a revealed card is shown as rows, with the number and CVC marked secret', () => {
  const rows = describeRevealed({ id: 'card-x', kind: 'secret', groups: [] }, { value: JSON.stringify({ name_on_card: 'A', number: '4242', exp: '07/29', cvc: '9', billing_address: { line1: '1 Main', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } }), notes: 'hi' });
  assert.deepEqual(rows.filter((r) => r.secret).map((r) => r.label), ['Number', 'CVC']);
  assert.equal(rows.find((r) => r.label === 'Billing').value, '1 Main, Austin TX 78701, US');
  assert.equal(rows.at(-1).label, 'Notes');
});

test('a draft with only a kind is not worth keeping; one with typing is; an edit is dirty only when it differs from its base', () => {
  assert.equal(draftHasContent(blankDraft('card')), false);
  assert.equal(draftHasContent({ kind: 'card', name: ' ' }), false);
  assert.equal(draftHasContent({ kind: 'card', name: 'x' }), true);
  assert.equal(draftIsDirty({ kind: 'login', name: 'a' }, { kind: 'login', name: 'a' }), false);
  assert.equal(draftIsDirty({ kind: 'login', name: 'b' }, { kind: 'login', name: 'a' }), true);
  assert.equal(deriveId({ kind: 'secret', name: '' }, new Set(), 36).startsWith('secret-'), true);
});
