// The assembled webchat with no decoder prompt configured must still transcribe. The assembly blanks the
// upstream vocabulary prompt; it used to blank it to '', which recognitionSettings rejects
// (invalid-recognition-prompt), so every transcription on an instance without recognition.prompt failed with a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const configModule = path.join(here, '..', '..', 'webchat', 'src', 'lib', 'services', 'voice', 'server', 'recognition-config.js');

test('no recognition.prompt and no TOPHAT_WHISPER_PROMPT: settings validate with no prompt', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recog-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ recognition: { binary: '/usr/bin/true', converter: '/usr/bin/true', modelDir: dir } }));
  const before = { config: process.env.TOPHAT_CONFIG, prompt: process.env.TOPHAT_WHISPER_PROMPT, home: process.env.HOME };
  process.env.TOPHAT_CONFIG = file;
  process.env.HOME = dir; // the live-state guard refuses a test whose config resolves under the real home
  delete process.env.TOPHAT_WHISPER_PROMPT;
  try {
    const { recognitionSettingsNow } = await import(configModule);
    const settings = recognitionSettingsNow();
    assert.equal(settings.prompt ?? null, null);
  } finally {
    if (before.config === undefined) delete process.env.TOPHAT_CONFIG; else process.env.TOPHAT_CONFIG = before.config;
    process.env.HOME = before.home;
    if (before.prompt !== undefined) process.env.TOPHAT_WHISPER_PROMPT = before.prompt;
  }
});
