// Fixture tests for the extra adapters: Beeper (synthetic index.db), IMAP (a scripted server over a Duplex), Apple
// (synthetic CallHistory and Photos stores, a fake helper run), HTTP pulls (stub fetch). No network, no real stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { rng, tmp, beeperIndex, callsDb, photosDb } from './fixtures.mjs';
import * as beeper from '../adapters/beeper.mjs';
import * as imap from '../adapters/imap.mjs';
import * as apple from '../adapters/apple.mjs';
import * as pulls from '../adapters/http-pulls.mjs';
import { toRawRecord } from '../index.mjs';

test('beeper: rows and edits by {rowid, edit_ms}, text from JSON/FTS/OCR, direction by isSentByMe', async () => {
  const dir = tmp('linknotes-src-'), file = path.join(dir, 'index.db');
  beeperIndex(file, [{ message: { text: 'hello from whatsapp' }, mine: true }, { message: {}, fts: ['words only in fts'] }, { message: { text: 'see pic' }, ocr: [['RECEIPT 42', 'ocr']] }, { message: '{not json', textContent: 'legacy words' }]);
  const s = { id: 'beeper', family: 'beeper', config: { index: file } };
  const r = await beeper.poll(s, {});
  assert.equal(r.records.length, 4);
  assert.equal(r.records[0].metadata.direction, 'outgoing'); assert.equal(toRawRecord(s, r.records[0]).role, 'owner');
  assert.equal(r.records[1].text, 'words only in fts');
  assert.match(r.records[2].text, /\[image text\] RECEIPT 42/);
  assert.equal(r.records[3].text, 'legacy words');
  assert.equal(toRawRecord(s, r.records[0]).account, 'whatsapp');
  const again = await beeper.poll(s, { cursor: r.cursor });
  assert.equal(again.records.length, 0);
  await assert.rejects(beeper.poll({ id: 'b', family: 'beeper', config: { index: path.join(dir, 'none.db') } }, {}), { code: 'store-absent' });
});

function message(r, i) {
  const words = r.pick(['=?UTF-8?B?w6l0w6k=?=', '=?iso-8859-1?Q?caf=E9_au_lait?=', '=?utf-8?q?a_b?= =?utf-8?q?c?=', 'plain', '=?bogus?X?zz?=', r.text(1).replace(/[\r\n]/g, ' ')]);
  const b = `b${i}`, enc = r.pick(['7bit', 'base64', 'quoted-printable']), body = r.text(4);
  const encoded = enc === 'base64' ? Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\r\n') : enc === 'quoted-printable' ? body.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\r\n') : body;
  const head = `Date: ${r.pick(['Fri, 16 Oct 2026 10:00:00 -0700', 'garbage'])}\r\nFrom: ${words} <x@example.org>\r\nSubject: ${words}\r\n  folded\r\nMessage-ID: <m${i}@x>\r\n`;
  const k = r.int(4);
  if (k === 0) return Buffer.from(`${head}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${enc}\r\n\r\n${encoded}`, 'utf8');
  if (k === 1) return Buffer.from(`${head}Content-Type: text/html\r\n\r\n<style>s</style><p>${body}</p><br>&amp;`, 'utf8');
  const att = `--${b}\r\nContent-Type: application/pdf; name="r.pdf"\r\nContent-Disposition: attachment; filename="=?utf-8?q?r=C3=A9.pdf?="\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0x\r\n`;
  return Buffer.from(`${head}Content-Type: multipart/mixed; boundary="${b}"\r\n\r\npre\r\n--${b}\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: ${enc}\r\n\r\n${encoded}\r\n${k === 2 ? att : ''}--${b}--\r\n`, 'utf8');
}

/** A scripted IMAP server over a Duplex: folders {name: {uidvalidity, messages: {uid: Buffer}}}; records every command. */
function server(folders) {
  const log = []; let current = null;
  const sock = new Duplex({ read() {}, write(chunk, _e, done) {
    for (const line of chunk.toString('latin1').split('\r\n').filter(Boolean)) {
      const [tag, ...rest] = line.split(' '), cmd = rest.join(' '); log.push(cmd.split(' ').slice(0, 3).join(' '));
      const ok = (u = '') => sock.push(Buffer.from(`${u}${tag} OK done\r\n`, 'latin1'));
      if (/^AUTHENTICATE/.test(cmd)) ok();
      else if (/^EXAMINE/.test(cmd)) { current = folders[/"(.*)"/.exec(cmd)[1]]; if (!current) sock.push(Buffer.from(`${tag} NO no such folder\r\n`)); else ok(`* ${Object.keys(current.messages).length} EXISTS\r\n* OK [UIDVALIDITY ${current.uidvalidity}]\r\n`); }
      else if (/^UID SEARCH/.test(cmd)) ok(`* SEARCH ${Object.keys(current.messages).join(' ')}\r\n`);
      else if (/^UID FETCH/.test(cmd)) {
        const set = cmd.split(' ')[2], want = new Set(set.split(',').flatMap((p) => { const [a, b] = p.split(':').map(Number); return Array.from({ length: (b ?? a) - a + 1 }, (_, k) => a + k); }));
        const parts = Object.entries(current.messages).filter(([u]) => want.has(Number(u))).map(([u, data]) => {
          const d = /HEADER\.FIELDS/.test(cmd) ? data.subarray(0, data.indexOf('\r\n\r\n') + 4) : data;
          return Buffer.concat([Buffer.from(`* 1 FETCH (UID ${u} INTERNALDATE "16-Oct-2026 10:00:00 -0700" RFC822.SIZE ${data.length} BODY[] {${d.length}}\r\n`, 'latin1'), d, Buffer.from(')\r\n')]);
        });
        sock.push(Buffer.concat([...parts, Buffer.from(`${tag} OK done\r\n`)]));
      } else if (/^LOGOUT/.test(cmd)) { ok('* BYE\r\n'); } else sock.push(Buffer.from(`${tag} BAD unknown\r\n`));
    }
    done();
  } });
  sock.destroy = () => {}; setImmediate(() => sock.push(Buffer.from('* OK IMAP4 ready\r\n')));
  return { sock, log };
}
const tokenStore = () => { const d = tmp('linknotes-src-'), f = path.join(d, 'ms.json'); fs.writeFileSync(f, JSON.stringify({ upn: 'me@example.org', access_token: 'synthetic', expires_at: Date.now() + 3600e3, refresh_token: 'r' })); return f; };

test('imap: poll over a scripted server issues read-only commands, walks backfill then new mail, re-reads on UIDVALIDITY change, sent by configured folder/address', async () => {
  const r = rng(2), msgs = (n, off = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1 + off, message(r, i + off)]));
  const folders = { Archive: { uidvalidity: 531, messages: msgs(7) }, INBOX: { uidvalidity: 14, messages: msgs(3, 100) }, 'Sent Items': { uidvalidity: 11, messages: msgs(1, 200) } };
  const file = tokenStore(); let last;
  const session = (o) => imap.open({ file, ...o, connect: () => { last = server(folders); return last.sock; } });
  let cursor = null; const recs = [];
  for (let i = 0; i < 6; i++) { const out = await imap.poll({ id: 'work-mail', family: 'imap', config: { storeFile: file, batchSize: 4 } }, { cursor, session }); recs.push(...out.records); cursor = out.cursor; if (out.complete) break; }
  assert.equal(new Set(recs.map((x) => x.id)).size, 11);
  assert.ok(recs.filter((x) => x.id.startsWith('Sent Items')).every((x) => x.metadata.direction === 'sent'));
  folders.INBOX.messages[104] = message(r, 104);
  const fresh = await imap.poll({ config: { storeFile: file } }, { cursor, session });
  assert.deepEqual(fresh.records.map((x) => x.id), ['INBOX:14:104']);
  assert.ok(last.log.every((c) => /^(AUTHENTICATE|EXAMINE|UID SEARCH|UID FETCH|LOGOUT)/.test(c)), last.log.join(';'));
  const own = imap.toRecord({ folder: 'INBOX', uidvalidity: 1, uid: 1, internaldate: '', size: 1, data: Buffer.from('Date: Fri, 16 Oct 2026 10:00:00 -0700\r\nFrom: Me <me@example.org>\r\nSubject: s\r\n\r\nbody') }, { ownerAddresses: ['me@example.org'] });
  assert.equal(own.metadata.direction, 'sent');
});

test('imap: token refresh rotates and keeps every key; invalid_grant and a missing store are ReauthRequired', async () => {
  const d = tmp('linknotes-src-'), file = path.join(d, 'ms.json');
  fs.writeFileSync(file, JSON.stringify({ upn: 'u', access_token: 'a', expires_at: 1, refresh_token: 'r1', extra: 'kept' }));
  const got = await imap.accessToken({ file, fetch: async () => Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(got.token, 'a2'); assert.equal(s.refresh_token, 'r2'); assert.equal(s.extra, 'kept');
  fs.writeFileSync(file, JSON.stringify({ ...s, expires_at: 1 }));
  await assert.rejects(imap.accessToken({ file, fetch: async () => Response.json({ error: 'invalid_grant', error_description: 'x' }, { status: 400 }) }), { code: 'imap-reauth-required' });
  await assert.rejects(imap.accessToken({ file: null }), { name: 'ReauthRequired' });
});

test('apple: call history and photo metadata from synthetic stores (copies, cursors, metadata only)', async () => {
  const dir = tmp('linknotes-src-'), calls = path.join(dir, 'CallHistory.storedata'), lib = path.join(dir, 'Lib.photoslibrary');
  callsDb(calls, [{ id: 'c1', date: 700000000, duration: 61.4, out: 1, answered: 1, address: '+15550001111', name: 'Dana' }, { id: 'c2', date: 700000100, out: 0, answered: 0, address: '+15550002222' }]);
  const c = await apple.poll({ id: 'calls', family: 'apple', kind: 'apple-call-history', config: { databases: [calls] } }, {});
  assert.deepEqual(c.records.map((x) => x.text), ['outgoing call; with Dana; 61s', 'incoming call; with +15550002222; not answered']);
  assert.equal((await apple.poll({ id: 'calls', family: 'apple', kind: 'apple-call-history', config: { databases: [calls] } }, { cursor: c.cursor })).records.length, 0);
  fs.mkdirSync(path.join(lib, 'database'), { recursive: true });
  photosDb(path.join(lib, 'database/Photos.sqlite'), [{ uuid: 'P1', taken: 700000000, lat: 0.5, lon: 0.5, fav: 1 }, { uuid: 'P2', taken: 700000500 }], [[1, 'Lab', [1]]]);
  const p = await apple.poll({ id: 'photos', family: 'apple', kind: 'apple-photos', config: { library: lib } }, {});
  assert.equal(p.records.length, 2);
  assert.match(p.records[0].text, /^favorite photo; taken .*; at 0\.5000,0\.5000; in Lab$/);
  assert.equal(p.records[0].metadata.content, 'metadata-only');
  await assert.rejects(apple.poll({ id: 'x', family: 'apple', kind: 'apple-call-history', config: {} }, {}), { code: 'call-databases-required' });
});

test('apple: helper-backed kinds go through the helper app and fail by name off macOS or without it', async () => {
  await assert.rejects(apple.poll({ id: 'n', family: 'apple', kind: 'apple-notes', config: { helperApp: '/x.app', folderIds: ['f'] } }, { platform: 'linux' }), { code: 'macos-required' });
  await assert.rejects(apple.poll({ id: 'n', family: 'apple', kind: 'apple-contacts', config: {} }, { platform: 'darwin' }), { code: 'native-helper-required' });
  const run = async (cmd, args) => { const out = args[args.length - 1]; fs.writeFileSync(out, JSON.stringify({ status: 'ok', coverage: 'test', records: [{ id: 'note1', title: 'Rig', body: 'frame<br>welded', modified: '2026-11-01T00:00:00Z', folderId: 'f' }] })); };
  const r = await apple.poll({ id: 'n', family: 'apple', kind: 'apple-notes', config: { helperApp: '/x.app', folderIds: ['f'] } }, { platform: 'darwin', run });
  assert.equal(r.records[0].text, 'Rig\nframe\nwelded');
  assert.ok(fs.existsSync(new URL('../native/SourceReader.swift', import.meta.url)), 'the helper source ships for buildHelper');
});

test('http pulls: mercury isolates a failing account; toggl normalizes; credentials come only from the configured reference', async () => {
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ id: 'a1', name: 'Checking' }, { id: 'a2', name: 'Broken' }] });
    if (u.pathname.endsWith('/cards')) return Response.json({ cards: [] });
    if (u.pathname.includes('/a2/')) return new Response('nope', { status: 500 });
    return Response.json({ transactions: [{ id: 't1', amount: -5, postedAt: '2026-10-16T00:00:00Z' }] });
  };
  const out = await pulls.poll({ id: 'bank', kind: 'mercury', config: {} }, { fetch, readSecret: (n) => (n === 'mercury-api-token' ? 'synthetic' : null), now: new Date('2026-10-17T08:00:00Z') });
  assert.deepEqual(out.records.map((x) => x.id).sort(), ['a1:2026-10-17', 'a1:t1', 'a2:2026-10-17']);
  assert.equal(out.records[0].metadata.type.startsWith('linknotes.'), true);
  await assert.rejects(pulls.poll({ id: 'bank', kind: 'mercury', config: { credential: 'nope' } }, { fetch, readSecret: () => null }), { code: 'credential-required' });
  const e = pulls.normalizeToggl({ id: 7, project_id: 1, description: 'scan', start: '2026-10-16T00:00:00Z', stop: '2026-10-16T01:00:00Z', duration: 3600 }, new Map([['1', { name: 'Rig' }]]));
  assert.equal(e.source_id, '7');
});
