// `![caption](/abs/path/clip.m4a)` is an inline audio player. These tests cover each link that made it
// "do nothing": the syntax picks the audio kind for every audio extension, the server types each with an
// audio/* MIME and answers Range requests (Safari and iOS refuse audio without them), a path written under
// the wrong half of an app's home (.local/state for .local/share) or under a folder that has moved still
// finds the file, and the player card shows a visible error with a download link when loading fails.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'audio-embed-')));
process.env.WEBCHAT_HOME = home;
process.env.WEBCHAT_PATH_INDEX = join(home, 'path-index.txt');
process.env.WEBCHAT_INDEX_ROOTS = home;
const { mediaKind, richBlock } = await import('../src/lib/core/rich-content.js');
const { compileMarkdown } = await import('../src/lib/core/markdown.js');
const { mimeFor, isText, locateAny } = await import('../src/lib/server/files.js');
const { rawFileResponse } = await import('../src/lib/server/file-response.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

const AUDIO = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', oga: 'audio/ogg' };

for (const [ext, mime] of Object.entries(AUDIO)) {
  test(`.${ext} is audio: rich block, ${mime}, never text`, () => {
    assert.equal(mediaKind(`/a/b/clip.${ext}`), 'audio');
    assert.equal(mediaKind(`/a/b/CLIP.${ext.toUpperCase()}?x=1`), 'audio');
    const block = richBlock(`![sample](/a/b/clip.${ext})`);
    assert.equal(block.kind, 'audio');
    assert.equal(block.title, 'sample');
    assert.equal(block.url, `/api/file?path=${encodeURIComponent(`/a/b/clip.${ext}`)}&raw=1`);
    assert.equal(mimeFor(`/a/b/clip.${ext}`), mime);
    assert.equal(isText(`/a/b/clip.${ext}`), false);
  });
}

test('an audio line in a reply compiles to its own rich block, between prose', () => {
  const blocks = compileMarkdown('Listen:\n![clip](/x/air.m4a)\nand then more text');
  const rich = blocks.filter((b) => b.rich);
  assert.equal(rich.length, 1);
  assert.equal(rich[0].rich.kind, 'audio');
});

test('raw responses carry accept-ranges and answer a byte range with 206 and the right slice', async () => {
  const path = join(home, 'clip.m4a');
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  writeFileSync(path, bytes);
  const found = { path, size: bytes.length };
  const whole = rawFileResponse(found, mimeFor(path), null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-type'), 'audio/mp4');
  const first = rawFileResponse(found, 'audio/mp4', 'bytes=0-1');
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 0-1/1000');
  const tail = rawFileResponse(found, 'audio/mp4', 'bytes=990-');
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(990));
  assert.equal(rawFileResponse(found, 'audio/mp4', 'bytes=5000-').status, 416);
});

test('a path under .local/state finds the file that lives under .local/share, and the reverse', async () => {
  const real = join(home, '.local', 'share', 'app', 'workspace', 'air-clip');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'speech.m4a'), 'x');
  const wrong = join(home, '.local', 'state', 'app', 'workspace', 'air-clip', 'speech.m4a');
  const hit = await locateAny(wrong, home);
  assert.equal(hit?.path, join(real, 'speech.m4a'));
  assert.equal(hit.moved, wrong);
  const back = await locateAny(join(home, '.local', 'share', 'other', 'x.m4a'), home);
  assert.equal(back, null);
});

test('a moved generated file is found by the tail of its path in the file index, unless two files share it', async () => {
  const dir = join(home, 'elsewhere', 'renders', 'run1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'take.wav');
  writeFileSync(file, 'x');
  writeFileSync(process.env.WEBCHAT_PATH_INDEX, `take.wav\t${file}\n`);
  const missing = join(home, 'old-place', 'renders', 'run1', 'take.wav');
  assert.equal((await locateAny(missing, home))?.path, file);
  const twin = join(home, 'twin', 'renders', 'run1');
  mkdirSync(twin, { recursive: true });
  writeFileSync(join(twin, 'take.wav'), 'x');
  writeFileSync(process.env.WEBCHAT_PATH_INDEX, `take.wav\t${file}\ntake.wav\t${join(twin, 'take.wav')}\n`);
  assert.equal(await locateAny(missing, home), null);
});

test('the player card has a seek bar, speed, download and a visible failure with the reason', () => {
  const src = readFileSync(new URL('../src/lib/ui/AudioPlayer.svelte', import.meta.url), 'utf8');
  assert.match(src, /data-testid="audio-player"/);
  assert.match(src, /type="range"[^>]*aria-label="Seek"/);
  assert.match(src, /aria-label="Speed"/);
  assert.match(src, /download=1/);
  assert.match(src, /role="alert"/);
  assert.match(src, /404/);
  const rich = readFileSync(new URL('../src/lib/ui/RichContent.svelte', import.meta.url), 'utf8');
  assert.match(rich, /kind === 'audio'}\s*<AudioPlayer/);
  assert.doesNotMatch(rich, /<audio\b/);
});
