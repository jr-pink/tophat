// The viewer's WebCrypto cipher against the linknotes Node cipher: byte-identical sealed output from one random stream,
// and each side opens what the other sealed or wrapped. Offline.
import assert from 'node:assert/strict';
import test from 'node:test';
import nodeCrypto from 'node:crypto';
import * as nodeC from '../../linknotes/core/src/crypto.mjs';
import * as webC from '../src/core/crypto.mjs';
import { readKeyFile, writeKeyFile } from '../src/core/keys.mjs';

/** A deterministic byte stream (sha256 counter mode) for both implementations. */
function stream(seed) {
  let n = 0, buf = Buffer.alloc(0);
  return (len) => {
    while (buf.length < len) buf = Buffer.concat([buf, nodeCrypto.createHash('sha256').update(`${seed}:${n++}`).digest()]);
    const out = buf.subarray(0, len); buf = buf.subarray(len);
    return Buffer.from(out);
  };
}
async function withNodeRandom(rnd, work) {
  const orig = nodeCrypto.randomBytes;
  nodeCrypto.randomBytes = (len) => rnd(len);
  try { return await work(); } finally { nodeCrypto.randomBytes = orig; }
}

const KA = nodeCrypto.randomBytes(32), KB = nodeCrypto.randomBytes(32), KC = nodeCrypto.randomBytes(32);
const VALUE = { rows: [{ t: 'notes', pk: 'n_1', img: { id: 'n_1', body: 'a note with unicode: caf\u00e9 \u2014 \u{1F600}', at: '2026-11-01T00:00:00Z' } }] };

test('seal: the WebCrypto module writes the same bytes as the Node module from the same randomness', async () => {
  for (const clauses of [[[{ group: 'proj', epoch: 1, key: KA }]], [[{ group: 'alex', epoch: 2, key: KA }, { group: 'proj', epoch: 1, key: KB }], [{ group: 'team', epoch: 3, key: KC }]]]) {
    const aad = 'f'.repeat(64) + '|0|' + JSON.stringify({ acl: ['proj'] });
    const fromNode = await withNodeRandom(stream('s1'), () => nodeC.seal(VALUE, aad, clauses));
    const fromWeb = await webC.seal(VALUE, aad, clauses, stream('s1'));
    assert.equal(JSON.stringify(fromWeb), JSON.stringify(fromNode));
  }
});

test('open: each side opens what the other sealed; a missing clause key gives null; a wrong key throws', async () => {
  const clauses = [[{ group: 'proj', epoch: 1, key: KA }], [{ group: 'team', epoch: 1, key: KB }]];
  const aad = 'x|1|{"cnf":[["proj"],["team"]]}';
  const s1 = nodeC.seal(VALUE, aad, clauses);
  const keys = { 'proj|1': KA, 'team|1': KB };
  assert.deepEqual(await webC.open(s1, aad, (g, e) => keys[`${g}|${e}`] ?? null), VALUE);
  assert.equal(await webC.open(s1, aad, (g, e) => (g === 'proj' ? KA : null)), null);
  await assert.rejects(webC.open(s1, aad, (g) => (g === 'proj' ? KC : KB)));
  await assert.rejects(webC.open(s1, aad + 'tampered', (g, e) => keys[`${g}|${e}`]));
  const s2 = await webC.seal(VALUE, aad, clauses);
  assert.deepEqual(nodeC.open(s2, aad, (g, e) => keys[`${g}|${e}`] ?? null), VALUE);
});

test('device wraps: Node wraps, WebCrypto unwraps, and the reverse', async () => {
  const dev = nodeC.deviceKeys();
  const aad = 'proj|1|alex-laptop';
  const w1 = nodeC.wrapForDevice(dev.publicKey, KA, aad);
  assert.deepEqual(Buffer.from(await webC.unwrapForDevice(dev.privateKey, w1, aad)), KA);
  const w2 = await webC.wrapForDevice(dev.publicKey, KB, aad);
  assert.deepEqual(nodeC.unwrapForDevice(dev.privateKey, w2, aad), KB);
  await assert.rejects(webC.unwrapForDevice(nodeC.deviceKeys().privateKey, w1, aad), 'another device cannot unwrap');
  await assert.rejects(webC.unwrapForDevice(dev.privateKey, w1, 'proj|2|alex-laptop'), 'the aad binds scope, epoch and device');
});

test('sha256 and base64 agree with Node', async () => {
  const s = JSON.stringify(['outline-v1', ['n_a', 'n_b']]);
  assert.equal(await webC.sha256Hex(s), nodeC.sha256(s));
  const b = nodeCrypto.randomBytes(70000);
  assert.equal(webC.b64(b), b.toString('base64'));
  assert.deepEqual(Buffer.from(webC.unb64(b.toString('base64'))), b);
});

test('key file: sealed under a passphrase, opened only with it', async () => {
  const payload = { user: 'alex', scopes: { proj: { 1: KA.toString('base64') } }, exported_at: '2026-11-01T00:00:00Z' };
  const box = await writeKeyFile(payload, 'correct horse battery', { iterations: 1000 });
  assert.ok(!JSON.stringify(box).includes(KA.toString('base64')));
  assert.deepEqual((await readKeyFile(JSON.stringify(box), 'correct horse battery')).scopes, payload.scopes);
  await assert.rejects(readKeyFile(JSON.stringify(box), 'wrong horse battery'), /wrong passphrase/);
  await assert.rejects(writeKeyFile(payload, 'short'), /at least 8/);
});
