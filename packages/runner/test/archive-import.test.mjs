import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { read1PuxData } from '../src/vault/archive-import.mjs';

test('1PUX reads only exact export.data without extracting attachments and rejects malformed archive', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = JSON.stringify({ accounts: [{ vaults: [] }] });
  fs.writeFileSync(path.join(dir, 'export.data'), data);
  fs.writeFileSync(path.join(dir, 'attachment.txt'), 'unrelated attachment');
  execFileSync('/usr/bin/zip', ['-q', 'fixture.zip', 'export.data', 'attachment.txt'], { cwd: dir });
  const bytes = fs.readFileSync(path.join(dir, 'fixture.zip'));
  assert.equal(read1PuxData(bytes), data);
  assert.throws(() => read1PuxData(Buffer.from('invalid')), /Invalid/);
  assert.throws(() => read1PuxData(bytes.subarray(0, 50)), /Could not read/);
});
