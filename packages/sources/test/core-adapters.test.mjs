// Fixture tests for the core adapters (gmail, imessage, jsonl, webhook) and the runner. No network, no real stores:
// Gmail speaks to a stub fetch, iMessage reads a synthetic chat.db, everything in temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rng, tmp, chatDb, blobFor } from './fixtures.mjs';
import * as gmail from '../adapters/gmail.mjs';
import * as imessage from '../adapters/imessage.mjs';
import * as jsonl from '../adapters/jsonl.mjs';
import { accept, tokenDigest, listen } from '../webhook.mjs';
import { runSources, readState } from '../run.mjs';
import { toRawRecord, families } from '../index.mjs';
import { gmailCooldownFile, gmailCooldownUntil } from '../lib/gmail-cooldown.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
function mailbox(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}`, threadId: `t${i % 3}`, historyId: String(1000 + i), internalDate: String(1790000000000 - i * 60000), snippet: `snip ${i}`,
    labelIds: i % 4 === 0 ? ['SENT'] : ['INBOX'],
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: `subject ${i}` }, { name: 'From', value: i % 5 === 0 ? 'Me <me@example.org>' : 'X <x@example.com>' }],
      parts: [{ mimeType: 'text/plain', body: { data: b64(`plain body ${i}`) } }, { mimeType: 'text/html', body: { data: b64(`<p>html ${i}</p>`) } }] } }));
}
function api(mails, { pageSize = 100, fail429 = false } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url); const u = new URL(url);
    if (fail429) return new Response('{"error":{"message":"User-rate limit exceeded.  Retry after 2099-01-01T00:00:00.000Z"}}', { status: 429 });
    if (u.pathname.endsWith('/messages')) {
      const size = Number(u.searchParams.get('maxResults')) || pageSize, start = Number(u.searchParams.get('pageToken') || 0);
      const page = mails.slice(start, start + size);
      return Response.json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + size < mails.length ? { nextPageToken: String(start + size) } : {}) });
    }
    const m = mails.find((x) => x.id === decodeURIComponent(u.pathname.split('/').pop()));
    return m ? Response.json(m) : new Response('', { status: 404 });
  };
  return { fetch, calls };
}
function gmailSetup() {
  const dir = tmp('linknotes-src-'), cred = path.join(dir, 'gmail-token.json');
  fs.writeFileSync(cred, JSON.stringify({ access_token: 'synthetic-token', expiry_date: Date.now() + 3600e3 }));
  return { dir, cred, stateDir: path.join(dir, 'state') };
}

test('gmail: paged poll walks every message once, with text, revision, thread and direction from config-only owner addresses', async () => {
  const { cred, stateDir } = gmailSetup(), mails = mailbox(230);
  const source = { id: 'work-mail', family: 'gmail', account: 'me@example.org', config: { credentialFile: cred } };
  let cursor = null; const seen = [];
  for (let i = 0; i < 6; i++) { const r = await gmail.poll(source, { cursor, stateDir, fetch: api(mails).fetch }); seen.push(...r.records); cursor = r.cursor; if (r.complete) break; }
  const ids = new Set(seen.map((r) => r.id));
  assert.equal(ids.size, 230);
  const r5 = seen.find((r) => r.id === 'm0005'), r4 = seen.find((r) => r.id === 'm0004'), r1 = seen.find((r) => r.id === 'm0001');
  assert.match(r1.text, /^Subject: subject 1\nFrom: X <x@example.com>\nplain body 1$/);
  assert.equal(r1.revision, '1001'); assert.equal(r1.threadId, 't1');
  assert.equal(r4.metadata.direction, 'sent', 'SENT label');
  assert.equal(r5.metadata.direction, 'sent', 'From is the configured account');
  assert.equal(r1.metadata.direction, 'received');
  const raw = toRawRecord(source, r5);
  assert.deepEqual([raw.source, raw.role, raw.id, raw.thread], ['work-mail', 'owner', 'm0005', 't2']);
});

test('gmail: a 429 opens the per-mailbox cooldown; inside it no request is made; a missing credential is named', async () => {
  const { cred, stateDir } = gmailSetup(), source = { id: 'acct', family: 'gmail', config: { credentialFile: cred } };
  await assert.rejects(gmail.poll(source, { stateDir, fetch: api([], { fail429: true }).fetch }), { code: 'http-429', retryAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(gmailCooldownUntil('acct', { file: gmailCooldownFile({ stateDir }) }), '2099-01-01T00:00:00.000Z');
  const quiet = api(mailbox(3));
  await assert.rejects(gmail.poll(source, { stateDir, fetch: quiet.fetch }), { code: 'http-429', cooldown: true });
  assert.equal(quiet.calls.length, 0);
  await assert.rejects(gmail.poll({ id: 'none', family: 'gmail', config: { credential: 'no-such-secret-name' } }, { stateDir, fetch: quiet.fetch }), { code: 'credential-unavailable' });
});

test('gmail: an expired token refreshes in memory and the credential file is never rewritten', async () => {
  const { dir, stateDir } = gmailSetup();
  const cred = path.join(dir, 'old.json'), client = path.join(dir, 'client.json');
  fs.writeFileSync(cred, JSON.stringify({ access_token: 'old', refresh_token: 'r1', expiry_date: 1 }));
  fs.writeFileSync(client, JSON.stringify({ installed: { client_id: 'cid', client_secret: 'cs' } }));
  const before = fs.readFileSync(cred, 'utf8');
  const mails = mailbox(2), base = api(mails);
  const fetch = async (url, init) => (String(url).startsWith('https://oauth2.googleapis.com/token') ? Response.json({ access_token: 'fresh' }) : base.fetch(url, init));
  const r = await gmail.poll({ id: 'second-account', family: 'gmail', config: { credentialFile: cred, clientFile: client } }, { stateDir, fetch });
  assert.equal(r.records.length, 2);
  assert.equal(fs.readFileSync(cred, 'utf8'), before);
});

function chatFixture(n = 40) {
  const r = rng(7), dir = tmp('linknotes-src-'), file = path.join(dir, 'chat.db');
  chatDb(file, Array.from({ length: n }, (_, i) => {
    const t = `message number ${i} ${r.text(2)}`;
    return { date: (700000000 + i * 60) * 1e9, text: i % 3 === 0 ? null : t, blob: i % 3 === 0 ? blobFor(`blob body ${i}`) : null, fromMe: i % 2 === 0, chat: i % 4 === 0 ? 2 : 1, handle: 1 };
  }));
  return { dir, file };
}

test('imessage: poll pages through chat.db by rowid, recovers attributedBody text, and names the speaker by is_from_me', async () => {
  const { file } = chatFixture(40);
  const source = { id: 'imessage', family: 'imessage', config: { database: file, batchSize: 15 } };
  let cursor = null; const all = [];
  for (let i = 0; i < 10; i++) { const r = await imessage.poll(source, { cursor }); all.push(...r.records); cursor = r.cursor; if (r.complete) break; }
  assert.equal(all.length, 40);
  assert.deepEqual(cursor, { version: 1, rowid: 40 });
  const r0 = all[0], r1 = all[1];
  assert.equal(r0.text, 'blob body 0'); assert.equal(r0.metadata.bodySource, 'attributed-body');
  assert.equal(r0.metadata.direction, 'outgoing'); assert.equal(r1.metadata.direction, 'incoming');
  assert.equal(r0.threadId, 'imessage:chat99');
  assert.equal(toRawRecord(source, r0).role, 'owner'); assert.equal(toRawRecord(source, r1).role, 'human');
  const again = await imessage.poll(source, { cursor });
  assert.equal(again.records.length, 0);
});

test('imessage: a missing database fails by name, never as an empty history; recent/read work on the fixture', async () => {
  await assert.rejects(imessage.poll({ id: 'imessage', family: 'imessage', config: { database: '/nonexistent/chat.db' } }, {}), (e) => typeof e.code === 'string' && e.code.length > 0);
  const { file } = chatFixture(10);
  const rows = imessage.recent({ file, asOf: '2030-01-01T00:00:00Z', limit: 3 });
  assert.equal(rows.length, 3); assert.ok(rows[0].at >= rows[1].at);
  assert.equal(imessage.read('1', { file }).text, 'blob body 0');
});

test('jsonl: reads complete lines only, resumes from the byte cursor, reports malformed lines without dropping the rest', async () => {
  const dir = tmp('linknotes-drop-');
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, '{"id":"1","text":"one","time":"2026-11-01T00:00:00Z"}\nnot json\n{"id":"2","text":"two","time":"2026-11-01T00:01:00Z","author":"Dana"}\n{"id":"3","te');
  const s = { id: 'drop', family: 'jsonl', config: { dir } };
  const r1 = await jsonl.poll(s, {});
  assert.deepEqual(r1.records.map((r) => r.id), ['1', '2']); assert.equal(r1.health.malformed, 1);
  fs.appendFileSync(f, 'xt":"three","time":"2026-11-01T00:02:00Z"}\n');
  const r2 = await jsonl.poll(s, { cursor: r1.cursor });
  assert.deepEqual(r2.records.map((r) => r.id), ['3']);
  assert.equal(r2.records[0].text, 'three');
});

test('webhook: token bound to one source, validates records, spools atomically for the jsonl adapter (also over HTTP)', async () => {
  const spool = tmp('linknotes-spool-');
  const tokens = [{ sha256: tokenDigest('tok-for-phone-0123456789'), source: 'phone' }];
  const body = JSON.stringify({ records: [{ id: 'p1', text: 'from the phone', time: '2026-11-03T00:00:00Z' }] });
  assert.throws(() => accept({ spool, tokens }, 'phone', 'Bearer wrong-token-000000000', body), { code: 'unauthenticated' });
  assert.throws(() => accept({ spool, tokens }, 'laptop', 'Bearer tok-for-phone-0123456789', body), { code: 'token_not_for_this_source' });
  assert.throws(() => accept({ spool, tokens }, 'phone', 'Bearer tok-for-phone-0123456789', JSON.stringify({ records: [{ id: 'x' }] })), { status: 422 });
  assert.equal(accept({ spool, tokens }, 'phone', 'Bearer tok-for-phone-0123456789', body).accepted, 1);
  const server = await listen({ spool, tokens, port: 0 });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/records/phone`, { method: 'POST', headers: { authorization: 'Bearer tok-for-phone-0123456789' }, body: JSON.stringify({ records: [{ id: 'p2', text: 'second', time: '2026-11-03T00:01:00Z' }] }) });
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
  const got = await jsonl.poll({ id: 'phone', family: 'jsonl', config: { dir: spool } }, {});
  assert.deepEqual(got.records.map((r) => r.id).sort(), ['p1', 'p2']);
});

test('runner: cursor commits only after delivery; a failing source is isolated with a code-only cause', async () => {
  const dir = tmp('linknotes-run-'), stateDir = path.join(dir, 'state'), drop = path.join(dir, 'drop');
  fs.mkdirSync(drop);
  fs.writeFileSync(path.join(drop, 'x.jsonl'), '{"id":"1","text":"a","time":"2026-11-01T00:00:00Z"}\n');
  const sources = [{ id: 'drop', family: 'jsonl', config: { dir: drop } }, { id: 'broken', family: 'imessage', config: { database: '/nonexistent/chat.db' } }];
  let fail = true;
  const deliver = async (s, raw) => { if (fail) throw Object.assign(new Error('store down http://x?token=secret'), { code: 'store-down' }); return { stored: raw.map((r) => r.id) }; };
  const r1 = await runSources({ sources, stateDir, deliver, force: true });
  assert.equal(r1.polled, 0); assert.deepEqual(r1.errors.map((e) => e.source), ['drop', 'broken']);
  assert.ok(!JSON.stringify(readState(stateDir)).includes('secret'), 'no message prose in state');
  assert.equal(readState(stateDir).sources.drop.cursor, undefined, 'cursor did not move past undelivered records');
  fail = false;
  const r2 = await runSources({ sources, stateDir, deliver, force: true });
  assert.equal(r2.polled, 1); assert.deepEqual(r2.delivered.drop.stored, ['1']);
  const r3 = await runSources({ sources: [sources[0]], stateDir, deliver, force: true });
  assert.deepEqual(r3.delivered.drop.stored, [], 'nothing new');
  assert.ok(families().includes('gmail') && families().includes('imessage') && families().includes('jsonl'));
});
