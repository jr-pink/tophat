// Images the model sees, besides an attachment that was on disk when its message arrived:
//   1. an attachment still uploading when its message was taken in is added as an image once it lands, before the
//      next model call of that turn (before this, the turn went out with only the path and nothing re-attached it);
//   2. read_document on an image path returns the image itself as a block, not only OCR text;
//   3. read_document OCRs a PNG on darwin, which needs src/attachments/OCR.swift shipped beside extract.mjs.
// Run through the real runner (packages/runner/rev6/pull/pull.mjs) against the fake Messages API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, textReply, toolReply, toolResultsOf } from '../rev5/fake-provider.mjs';
const reapAfter = (t, child) => t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
import { imageBlocksFor, landedImageBlocks, hydrateImageBlocks } from '../rev6/pull/context.mjs';
import { RESULT_BLOCKS, withImage } from '../rev6/pull/tools.mjs';
import { readDocument } from '../rev6/tools/runner/attachments.mjs';

const PULL = fileURLToPath(new URL('../rev6/pull/pull.mjs', import.meta.url));
const PNG = fileURLToPath(new URL('./fixtures/ocr-fixture.png', import.meta.url));
const darwin = process.platform === 'darwin' ? false : 'needs sips (macOS)';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tophat-vision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'key'), 'sk-ant-api03-synthetic0123456789', { mode: 0o600 });
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  mkdirSync(join(dir, 'uploads'), { recursive: true });
  return dir;
}

function drive(t, dir, fake, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: dir, TOPHAT_RUNNER_API_KEY_FILE: join(dir, 'key'), TOPHAT_RUNNER_API_BASE: fake.url, TOPHAT_RUNNER_RUNNER_DB: join(dir, 'runner.sqlite'),
    TOPHAT_RUNNER_DB: join(dir, 'memory.sqlite'), TOPHAT_RUNNER_GOALS_DIR: join(dir, 'goals'), TOPHAT_STATE_DIR: join(dir, 'state'), TOPHAT_RUNNER_PUSH: '0', TOPHAT_RUNNER_RETRIES: '0',
    TOPHAT_RUNNER_NO_RETRIEVAL: '1', TOPHAT_RUNNER_GOAL_HOOK: '0', TOPHAT_RUNNER_WEB: '0', TOPHAT_TIMEZONE: 'America/Los_Angeles', TOPHAT_REDACT_SECRETS: '0',
    TOPHAT_CONVERSATION_ID: 'conv-vision', TOPHAT_RUNNER_CHATGPT_AUTH_FILE: join(dir, 'no-codex.json'), TOPHAT_RUNNER_CHAT_TOOLS: '0', ...extraEnv };
  const child = spawn(process.execPath, [PULL, '--model', 'fake-model', '--permission-mode', 'bypassPermissions', '--session-id', 'sess-vision',
    '--cwd', join(dir, 'workspace'), '--add-dir', join(dir, 'uploads')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  reapAfter(t, child);
  const lines = [];
  let stderr = '';
  createInterface({ input: child.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* not json */ } });
  child.stderr.on('data', (c) => { stderr += c; });
  const until = (pred, label, ms = 20000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => (pred(lines) ? resolve() : Date.now() > deadline ? reject(new Error(`timed out waiting for ${label}; stderr ${stderr.slice(-800)}`)) : setTimeout(tick, 15));
    tick();
  });
  const say = (text) => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  return { lines, until, say };
}

/** Image blocks anywhere in a request body: top level in a user message, or inside a tool_result. */
function imagesIn(body) {
  const out = [];
  for (const m of body.messages || []) for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === 'image') out.push({ where: 'message', b });
    if (b.type === 'tool_result' && Array.isArray(b.content)) for (const c of b.content) if (c.type === 'image') out.push({ where: 'tool_result', b: c });
  }
  return out;
}

test('an attachment that is missing when its message is taken in is pending, and becomes an image once it lands', { skip: darwin }, (t) => {
  const dir = home(t), target = join(dir, 'uploads', 'photo.png');
  const env = { HOME: dir, TOPHAT_STATE_DIR: join(dir, 'state') };
  const first = imageBlocksFor(`look\n\nAttached files:\n- ${target}`, { env });
  assert.equal(first.blocks.length, 0);
  assert.deepEqual(first.pending.map((p) => p.path), [target]);
  assert.match(first.notes.join('\n'), /still uploading/);
  const waiting = landedImageBlocks([{ path: target, since: Date.now() }], { env });
  assert.equal(waiting.blocks.length, 0);
  assert.equal(waiting.still.length, 1);
  copyFileSync(PNG, target);
  const landed = landedImageBlocks(waiting.still, { env });
  assert.equal(landed.still.length, 0);
  assert.deepEqual(landed.blocks.map((b) => b.type), ['text', 'tophat_image']);
  const [msg] = hydrateImageBlocks([{ role: 'user', content: landed.blocks }], { env });
  assert.equal(msg.content[1].type, 'image');
  assert.equal(msg.content[1].source.media_type, 'image/png');
  const failed = landedImageBlocks([{ path: join(dir, 'uploads', 'gone.png'), since: Date.now() }], { env, exists: (p) => p.endsWith('.failed') });
  assert.match(failed.blocks[0].text, /upload .* failed/);
});

test('an upload that lands mid-turn reaches the next model call as an image', { skip: darwin }, async (t) => {
  const dir = home(t), target = join(dir, 'uploads', 'photo.png');
  const bodies = [];
  const fake = await startFakeProvider({ reply: (body) => {
    bodies.push(body);
    if (bodies.length === 1) { copyFileSync(PNG, target); return toolReply('list_files', { path: join(dir, 'uploads') }); }
    return textReply(toolResultsOf(body).length ? 'saw it' : 'hello');
  } });
  t.after(() => fake.close());
  const p = drive(t, dir, fake, { TOPHAT_RUNNER_UPLOAD_HOLD_MS: '0' });
  await p.until((l) => l.some((x) => x.subtype === 'init'), 'init');
  p.say(`what is in this\n\nAttached files:\n- ${target}`);
  await p.until((l) => l.some((x) => x.type === 'result'), 'result');
  assert.equal(imagesIn(bodies[0]).length, 0, 'the first call went out before the upload landed');
  const after = imagesIn(bodies[1]);
  assert.equal(after.length, 1, 'the second call carries the landed image');
  assert.equal(after[0].where, 'message');
  assert.equal(after[0].b.source.media_type, 'image/png');
  assert.ok(JSON.stringify(bodies[1].messages).includes('has landed'));
});

test('the first call of a turn holds briefly for an upload in flight', { skip: darwin }, async (t) => {
  const dir = home(t), target = join(dir, 'uploads', 'late.png');
  const bodies = [];
  const fake = await startFakeProvider({ reply: (body) => { bodies.push(body); return textReply('ok'); } });
  t.after(() => fake.close());
  const p = drive(t, dir, fake, { TOPHAT_RUNNER_UPLOAD_HOLD_MS: '5000' });
  await p.until((l) => l.some((x) => x.subtype === 'init'), 'init');
  p.say(`and this\n\nAttached files:\n- ${target}`);
  setTimeout(() => copyFileSync(PNG, target), 400);
  await p.until((l) => l.some((x) => x.type === 'result'), 'result');
  assert.equal(imagesIn(bodies[0]).length, 1);
});

test('read_document on a PNG returns the image itself as a block the model sees', { skip: darwin }, async (t) => {
  const dir = home(t), target = join(dir, 'uploads', 'shot.png');
  copyFileSync(PNG, target);
  const unit = withImage({ origin: { kind: 'file', path: target }, spans: [] }, { HOME: dir, TOPHAT_STATE_DIR: join(dir, 'state') });
  assert.equal(unit[RESULT_BLOCKS][0].type, 'tophat_image');
  assert.ok(!JSON.stringify(unit).includes('tophat_image'), 'the block rides beside the JSON, not in it');
  const bodies = [];
  const fake = await startFakeProvider({ reply: (body) => {
    bodies.push(body);
    return bodies.length === 1 ? toolReply('read_document', { path: target }) : textReply('looked');
  } });
  t.after(() => fake.close());
  const p = drive(t, dir, fake);
  await p.until((l) => l.some((x) => x.subtype === 'init'), 'init');
  p.say('look at the screenshot in uploads');
  await p.until((l) => l.some((x) => x.type === 'result'), 'result', 60000);
  const seen = imagesIn(bodies[1]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].where, 'tool_result');
  const result = bodies[1].messages.at(-1).content.find((b) => b.type === 'tool_result');
  const text = result.content.find((c) => c.type === 'text').text;
  assert.match(text, /image itself follows/);
  assert.match(text, /TOPHAT/, 'the OCR spans are still there');
});

test('read_document extracts the text of a small PNG (local OCR, darwin)', { skip: darwin }, async (t) => {
  const dir = home(t), target = join(dir, 'uploads', 'words.png');
  copyFileSync(PNG, target);
  const read = await readDocument({ path: target }, { env: { HOME: dir, TOPHAT_STATE_DIR: join(dir, 'state') }, cwd: dir, checkPath: (p) => p });
  assert.equal(read.error, undefined, read.error);
  // An image is 'partial' by design (OCR of visible text only); 'extraction-unavailable' meant OCR.swift was not shipped.
  assert.equal(read.files[0].status, 'partial', JSON.stringify(read.files[0]));
  assert.ok(!JSON.stringify(read.files[0]).includes('unavailable'), JSON.stringify(read.files[0]));
  assert.match(read.spans.map((s) => s.text).join(' '), /TOPHAT\s*4217/);
});
