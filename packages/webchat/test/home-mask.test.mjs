// An instance in public prompt mode never tells a client where on the host's disk it runs: /api answers write the home directory as ~.
import assert from 'node:assert/strict';
import test from 'node:test';
import { maskHomeText, homePattern, maskResponse, maskStream, publicMode } from '../src/lib/server/home-mask.js';

const HOME = '/Users/visitorhost';
const through = async (chunks) => {
  const s = maskStream({ home: HOME }), w = s.writable.getWriter();
  const done = new Response(s.readable).text();
  for (const c of chunks) await w.write(new TextEncoder().encode(c));
  await w.close();
  return done;
};

test('public mode is TOPHAT_RUNNER_PROMPT_MODE=public', () => {
  assert.equal(publicMode({ TOPHAT_RUNNER_PROMPT_MODE: 'public' }), true);
  assert.equal(publicMode({}), false);
});

test('the server home and any other /Users or /home directory become ~', () => {
  const p = homePattern(HOME);
  assert.equal(maskHomeText(`{"cwd":"${HOME}/.local/state/x/workspace"}`, p), '{"cwd":"~/.local/state/x/workspace"}');
  assert.equal(maskHomeText('/Users/someone-else/a and /home/dev_1/b', p), '~/a and ~/b');
});

test('every field the API sends is covered: rows, events, sidebar, capabilities', async () => {
  const body = JSON.stringify({ conversations: [{ cwd: `${HOME}/w` }], events: [{ content: { cwd: `${HOME}/w` } }], sidebar: { rows: [{ cwd: `${HOME}/w` }] }, capabilities: { defaultCwd: `${HOME}/w` } });
  const res = maskResponse(new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }), { home: HOME });
  assert.equal(res.headers.get('content-length'), null);
  const out = await res.text();
  assert.ok(!out.includes('visitorhost'));
  assert.equal(JSON.parse(out).capabilities.defaultCwd, '~/w');
});

test('a path split across stream chunks is masked; other text passes at once', async () => {
  assert.equal(await through(['data: {"cwd":"/Us', 'ers/visitorhost/w"}\n\n']), 'data: {"cwd":"~/w"}\n\n');
  assert.equal(await through(['{"cwd":"/Users/visitor', 'host/w"}']), '{"cwd":"~/w"}');
  const html = new Response(`<p>${HOME}</p>`, { headers: { 'content-type': 'text/html' } });
  assert.equal(maskResponse(html, { home: HOME }), html);
});
