// The AAD prefixes a vault record may be sealed under come from vault.json beside config.json, never from an environment variable or a
// literal (ported from the upstream vault-aad-prefixes test, names scrubbed: the fallback prefix is "older").
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes, createCipheriv} from 'node:crypto';
import {openRecord, sealRecord, legacyAadPrefixes, vaultPrefixesFile} from '../src/vault/manager.mjs';

const sealUnder = (prefix, key, name, text) => {
  const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(`${prefix}:${name}`));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('AV01'), nonce, c.getAuthTag(), ct]);
};
const envWith = (t, vaultJson) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tophat-vault-prefix-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  if (vaultJson !== undefined) fs.writeFileSync(path.join(dir, 'vault.json'), vaultJson);
  return {TOPHAT_CONFIG: path.join(dir, 'config.json'), TOPHAT_VAULT_LEGACY_AAD_PREFIX: 'older'};
};
const withEnv = (env, fn) => {
  const saved = {...process.env};
  Object.assign(process.env, env);
  try {return fn();} finally {for (const k of Object.keys(env)) k in saved ? process.env[k] = saved[k] : delete process.env[k];}
};

test('a record sealed under another prefix opens when vault.json lists it, regardless of env', t => {
  const env = envWith(t, '{"aadPrefixes":["tophat","older"]}');
  const key = randomBytes(32);
  withEnv(env, () => {
    assert.deepEqual(legacyAadPrefixes(), ['older']);
    assert.equal(openRecord(key, 'catalog', sealUnder('older', key, 'catalog', 'x')).toString(), 'x');
    assert.equal(openRecord(key, 'catalog', sealRecord(key, 'catalog', 'y')).toString(), 'y');
  });
});

test('a prefix absent from vault.json does not open, and the env var is not a source', t => {
  const env = envWith(t, '{"aadPrefixes":["tophat"]}');
  const key = randomBytes(32);
  withEnv(env, () => assert.throws(() => openRecord(key, 'catalog', sealUnder('older', key, 'catalog', 'x')), /integrity/));
});

test('missing or malformed vault.json fails loudly and names the file, only when a fallback is needed', t => {
  const key = randomBytes(32);
  for (const body of [undefined, '{}', '{"aadPrefixes":[]}', 'not json']) {
    const env = envWith(t, body);
    withEnv(env, () => {
      assert.equal(openRecord(key, 'c', sealRecord(key, 'c', 'ok')).toString(), 'ok');
      assert.throws(() => openRecord(key, 'c', sealUnder('older', key, 'c', 'x')),
        error => /Vault AAD prefixes unavailable/.test(error.message) && error.message.includes(vaultPrefixesFile()));
    });
  }
});
