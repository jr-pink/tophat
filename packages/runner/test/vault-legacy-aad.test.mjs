// A vault written under an older AAD prefix stays readable through TOPHAT_VAULT_LEGACY_AAD_PREFIX; writes use the current prefix.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PasswordManager } from '../src/vault/manager.mjs';

const reseal = (file, key, name, from, to) => {
  const bytes = fs.readFileSync(file);
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
  d.setAAD(Buffer.from(`${from}:${name}`)); d.setAuthTag(bytes.subarray(16, 32));
  const plain = Buffer.concat([d.update(bytes.subarray(32)), d.final()]);
  const nonce = randomBytes(12), c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(`${to}:${name}`));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, 4), nonce, c.getAuthTag(), ct]));
};

test('a record sealed under a legacy AAD prefix reads only when that prefix is named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-aad-'));
  const m = new PasswordManager({ directory: path.join(dir, 'vault'), keyFile: path.join(dir, 'vault-master-key') });
  const saved = process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX;
  try {
    delete process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX;
    m.write('note-one', 'hello');
    assert.equal(m.read('note-one'), 'hello');
    const key = m.key();
    reseal(m.file('note-one'), key, 'note-one', 'tophat', 'older');
    assert.throws(() => m.read('note-one'), /integrity/);
    process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX = 'older';
    assert.equal(m.read('note-one'), 'hello');
    // a new write is sealed under the current prefix, and still reads with the fallback on
    m.write('note-two', 'fresh');
    reseal(m.file('note-two'), key, 'note-two', 'tophat', 'tophat');
    delete process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX;
    assert.equal(m.read('note-two'), 'fresh');
  } finally {
    if (saved === undefined) delete process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX; else process.env.TOPHAT_VAULT_LEGACY_AAD_PREFIX = saved;
    m.lock?.(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
