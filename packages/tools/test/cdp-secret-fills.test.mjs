// A --secret-from fill marks its tab so `screenshot` masks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteSecretFill, secretFillRecord, secretFillsFile } from '../cdp/browser/secrets.mjs';
import { loadJob, saveJob } from '../cdp/browser/kernel.mjs';

test('a secret fill marks its tab and job, never the value; the mark lapses off-origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fills-'));
  const env = { TOPHAT_CDP_JOBS: path.join(dir, 'jobs') };
  try {
    saveJob({ job: 'pay', targetId: 'T1' }, env);
    noteSecretFill({ id: 'T1', url: 'https://pay.example/checkout' }, loadJob('pay', env), 'fill', { secret_from: 'card-test:number' }, env);
    const rec = secretFillRecord({ id: 'T1', url: 'https://pay.example/checkout?step=2' }, null, env);
    assert.equal(rec.vault, 'card-test');
    assert.ok(!fs.readFileSync(secretFillsFile(env), 'utf8').includes('number'));
    assert.equal(loadJob('pay', env).secret_fills[0].target, 'T1');
    assert.equal(secretFillRecord({ id: 'T2', url: 'https://pay.example/' }, null, env), null);
    assert.equal(secretFillRecord({ id: 'T1', url: 'https://other.example/done' }, null, env), null);
    assert.ok(secretFillRecord({ id: 'F1', parentId: 'T1', url: 'https://pay.example/frame' }, null, env));
    assert.ok(secretFillRecord({ id: 'T1', url: 'https://pay.example/x' }, loadJob('pay', env), { TOPHAT_CDP_JOBS: path.join(dir, 'elsewhere') }), 'the job alone carries the mark');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
