// SerpAPI is web_search's first provider: real Google organic results, so operators like site:linkedin.com/in
// work as typed. It must return Google's organic results in rank order, keep the key (a query parameter) out
// of every result and error, be found by its conventional key file name, and fall through to Brave when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWeb, webConfig, webConfigured } from '../rev6/tools/runner/web.mjs';

const KEY = 'serp-SECRET-0123456789';
function keyDir(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'serpkey-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('serpapi is first in the default order and is found by its conventional key file', (t) => {
  assert.equal(webConfig({}).order[0], 'serpapi');
  assert.equal(webConfig({}).order[1], 'brave');
  const dir = keyDir(t, { 'serpapi-api-key': KEY + '\n' });
  assert.equal(webConfig({ TOPHAT_SECRETS_DIR: dir }).serpapiKeyFile, join(dir, 'serpapi-api-key'));
  assert.equal(webConfigured({ TOPHAT_SECRETS_DIR: dir, TOPHAT_RUNNER_WEB_JINA: '0' }), true);
});

test('serpapi returns Google organic results in rank order with the query passed through unchanged', async (t) => {
  const dir = keyDir(t, { 'serpapi-api-key': KEY + '\n' });
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(String(url)));
    return json({ search_metadata: { status: 'Success' }, organic_results: [
      { position: 1, title: 'Jane Doe - Founder - Acme Robotics | LinkedIn', link: 'https://www.linkedin.com/in/janedoe', snippet: 'Stanford. Warehouse robotics.' },
      { position: 2, title: 'No link row' },
      { position: 3, title: 'John Roe | LinkedIn', link: 'https://www.linkedin.com/in/johnroe', snippet: 'Neuromodulation', date: 'Mar 3, 2026' }] });
  };
  const q = 'site:linkedin.com/in "robotics" "warehouse" Stanford';
  const got = await searchWeb(q, { env: { TOPHAT_SECRETS_DIR: dir }, fetchImpl, count: 5 });
  assert.equal(got.provider, 'serpapi');
  assert.deepEqual(got.results.map((r) => r.url), ['https://www.linkedin.com/in/janedoe', 'https://www.linkedin.com/in/johnroe']);
  assert.equal(got.results[0].engine, 'google via serpapi');
  assert.equal(got.results[1].published, 'Mar 3, 2026');
  assert.equal(seen[0].host, 'serpapi.com');
  assert.equal(seen[0].searchParams.get('engine'), 'google');
  assert.equal(seen[0].searchParams.get('q'), q);
  assert.equal(seen[0].searchParams.get('api_key'), KEY);
  assert.equal(JSON.stringify(got).includes(KEY), false, 'the key never appears in a result');
});

test('a serpapi error falls through to brave, is named in tried, and never carries the key', async (t) => {
  const dir = keyDir(t, { 'serpapi-api-key': KEY, 'brave-search-api-key': 'brave-k' });
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'serpapi.com') return json({ error: `Invalid API key ${KEY}` }, 401);
    if (u.host === 'api.search.brave.com') return json({ web: { results: [{ title: 'B', url: 'https://example.org/b', description: '<b>d</b>' }] } });
    return json({}, 500);
  };
  const got = await searchWeb('x', { env: { TOPHAT_SECRETS_DIR: dir }, fetchImpl });
  assert.equal(got.provider, 'brave');
  assert.match(got.tried[0].failed, /serpapi answered HTTP 401: Invalid API key \[key\]/);
  assert.equal(JSON.stringify(got).includes(KEY), false);
});

test('a real Google no-results answer is a no-match note, not an outage; no key file is skipped with the fix', async (t) => {
  const dir = keyDir(t, { 'serpapi-api-key': KEY });
  const empty = await searchWeb('zzqx', { env: { TOPHAT_SECRETS_DIR: dir, TOPHAT_RUNNER_WEB_SEARCH_ORDER: 'serpapi' }, fetchImpl: async () => json({ error: "Google hasn't returned any results for this query." }) });
  assert.deepEqual(empty.results, []);
  assert.match(empty.note, /no results/);
  assert.equal(empty.error, undefined);
  const bare = mkdtempSync(join(tmpdir(), 'serpkey-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const none = await searchWeb('x', { env: { TOPHAT_SECRETS_DIR: bare, TOPHAT_RUNNER_WEB_SEARCH_ORDER: 'serpapi' } });
  assert.match(none.error, /serpapi: no SerpAPI key \(drop one at .*serpapi-api-key/);
});
