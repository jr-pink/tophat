// A published quicklook artifact (/view/<ULID>/) runs sandboxed in an opaque origin, so 'self' matches
// nothing: its HTML's CSP must name the artifact's own folder (origin + /view/<ULID>/) for scripts,
// styles, images, media, fonts, workers and fetches, or a multi-file artifact (HTML + ES modules +
// images + a .glb) renders blank. The prefix must be on the host the browser asked on, not only the
// configured ORIGIN, and a forged Host must not inject CSP text. Everything else stays closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE } from '../src/components.mjs';

const WEBCHAT = path.join(WORKSPACE, 'packages/webchat');
const { interactiveCsp } = await import(pathToFileURL(path.join(WEBCHAT, 'src/lib/server/file-response.js')).href);
const directive = (csp, name) => csp.split(';').map((d) => d.trim()).find((d) => d === name || d.startsWith(name + ' '));

test('an artifact page may load every kind of sub-resource from its own folder and nothing else', () => {
  const src = 'https://chat.example/view/01M6ZCZ7WWNHHYJK0QACC8NTWG/ https://other.example/view/01M6ZCZ7WWNHHYJK0QACC8NTWG/';
  const csp = interactiveCsp(src);
  for (const d of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'worker-src', 'connect-src']) {
    assert.ok(directive(csp, d).endsWith(' ' + src), `${d}: ${directive(csp, d)}`);
  }
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.doesNotMatch(csp, /allow-same-origin|'self'|\*/);
  for (const d of ["default-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.equal(directive(csp, d.split(' ')[0]), d);
  // with no artifact the page stays fully closed
  assert.equal(directive(interactiveCsp(), 'connect-src'), "connect-src 'none'");
  assert.equal(directive(interactiveCsp(), 'img-src'), 'img-src data: blob:');
});

test('the /view route names the asked host (forwarded host first, validated) and answers CORS *', () => {
  const route = readFileSync(path.join(WEBCHAT, 'src/routes/view/[...path]/+server.js'), 'utf8');
  assert.match(route, /x-forwarded-host/);
  assert.match(route, /x-forwarded-proto/);
  assert.match(route, /artifactSrc/);
  assert.match(route, /extraHeaders: CORS/);
  const cors = readFileSync(path.join(WEBCHAT, 'src/lib/server/quicklook-live.js'), 'utf8');
  assert.match(cors, /'access-control-allow-origin': '\*'/);
});
