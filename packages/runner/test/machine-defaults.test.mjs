// Nothing in the product points at one machine's own files. A message store, a bridged-chat API, a browser endpoint,
// a subscription OAuth file, a keyring directory and a knowledge tree are named by the instance or absent; no path of
// an older install on somebody's laptop survives as a default.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const read = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');
const CODE = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('message stores and the bridged-chat API default to absent', async () => {
  const { messageSources } = await import('../rev6/tools/runner/messages.mjs');
  const off = messageSources({ HOME: '/nowhere' });
  assert.equal(off.imessage.path, '');
  assert.equal(off.beeper.path, '');
  const on = messageSources({ HOME: '/nowhere', TOPHAT_RUNNER_IMESSAGE_DB: '/tmp/a.db', TOPHAT_RUNNER_BEEPER_INDEX: '/tmp/b.db' });
  assert.equal(on.imessage.path, '/tmp/a.db');
  assert.equal(on.beeper.path, '/tmp/b.db');
  const { BEEPER_API_DEFAULT } = await import('../src/connectors/beeper-assets.mjs');
  assert.equal(BEEPER_API_DEFAULT, '');
});

test('no owner-machine path is a default anywhere in the two packages', () => {
  const files = ['rev6/tools/runner/messages.mjs', 'rev6/base/config.mjs', 'rev6/sources/imessage.mjs', 'src/connectors/imessage.mjs',
    'rev6/push/identity.mjs', 'src/connectors/beeper-assets.mjs', 'rev6/tools/runner/browser.mjs', 'rev5/openai.mjs', 'rev6/pull/credentials.mjs',
    'rev6/base/paths.mjs', 'rev6/tools/runner/web.mjs', 'src/vault/secret-index.mjs',
    '../webchat/src/lib/server/system-state.js', '../webchat/src/lib/server/replies.js', '../webchat/src/lib/server/app.js',
    '../webchat/src/routes/api/quicklook/+server.js', '../webchat/src/lib/services/voice/server/recognition-config.js', '../webchat/src/routes/files/+page.server.js'];
  const bad = [];
  for (const f of files) {
    const code = CODE(read(f));
    for (const re of [/Library\/Messages/, /BeeperTexts/, /\.codex/, /localhost:23373/, /127\.0\.0\.1:9222/, /tophat-(?:legacy|old)\b|\/tophat\/old\//]) {
      if (re.test(code)) bad.push(`${f}: ${re}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the browser endpoint and the publishing hook are off unless configured', () => {
  assert.match(CODE(read('rev6/tools/runner/browser.mjs')), /endpoint = process\.env\.TOPHAT_CDP_ENDPOINT \|\| ''/);
  const ql = CODE(read('../webchat/src/routes/api/quicklook/+server.js'));
  assert.match(ql, /TOPHAT_QUICKLOOK_PUBLISH/);
  assert.match(ql, /publishing is not configured on this instance/);
  assert.match(CODE(read('../webchat/src/lib/server/app.js')), /TOPHAT_CHAT_POST_MODULE/);
  // the browser helper is a configured binary, never one guessed from a home directory
  assert.match(CODE(read('rev6/tools/runner/web.mjs')), /const defaultCdpBin = \(\) => process\.env\.TOPHAT_CDP_BIN \|\| '';/);
});
