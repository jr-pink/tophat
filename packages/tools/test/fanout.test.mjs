// tophat-fanout: one test per route (OpenRouter :online, OpenAI Responses web_search, Google google_search), plus
// model resolution, the reframe template, failure isolation and the spend cap. No network: fetch is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFRAME_TEMPLATE, buildBrief, resolveModels, estimateWorstCase, runFanout, ROSTER } from '../fanout/tophat-fanout.mjs';

const CATALOG = [
  ['google/gemini-4-argon', 10, 1790], ['google/gemini-3.8-flash', 3.75, 1788], ['google/gemini-3.7-flash', 3.75, 1786],
  ['openai/gpt-6-luna', 0.5, 1790], ['openai/gpt-6-sol', 10, 1790], ['openai/gpt-6-astra', 50, 1788],
  ['moonshotai/kimi-k3.1-pro', 10, 1792], ['meta/muse-spark-1.3', 4.25, 1788], ['meta/muse-spark-1.2', 4.25, 1785], ['x-ai/grok-4.7', 6, 1790]
].map(([id, out, created]) => ({ id, created, pricing: { prompt: String(out / 5 / 1e6), completion: String(out / 1e6) } }));

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'fanout-'));
  const secrets = join(home, 'secrets'); mkdirSync(secrets);
  writeFileSync(join(secrets, 'openrouter-api-key'), 'sk-or-TESTKEY\n');
  const auth = join(home, 'codex-auth.json');
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: 'tok-TEST', account_id: 'acct-TEST' } }));
  return { home, env: { HOME: home, TOPHAT_FANOUT_SECRETS_DIR: secrets, TOPHAT_RUNNER_CHATGPT_AUTH_FILE: auth, TOPHAT_RUNNER_OPENAI_AUTH: 'chatgpt' } };
}

const json = (status, obj) => ({ status, text: async () => JSON.stringify(obj), json: async () => obj });
const sse = (events) => ({ status: 200, text: async () => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });

function fakeFetch(calls, { failOr = [] } = {}) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith('/models')) return json(200, { data: CATALOG });
    if (url.includes('openrouter.ai') && url.endsWith('/chat/completions')) {
      const model = body.model.replace(/:online$/, '');
      if (failOr.includes(model)) return json(400, { error: { message: 'bad model sk-or-TESTKEY' } });
      return json(200, { model, choices: [{ finish_reason: 'stop', message: { content: `reply from ${model}`, annotations: [{ url_citation: { url: 'https://example.org/a', title: 'A' } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.02, server_tool_use_details: { web_search_requests: 3 } } });
    }
    if (url.includes('chatgpt.com/backend-api/codex/responses')) {
      return sse([{ type: 'response.web_search_call.completed' }, { type: 'response.output_text.delta', delta: 'hello ' }, { type: 'response.output_text.delta', delta: `from ${body.model}` },
        { type: 'response.output_text.annotation.added', annotation: { url: 'https://example.org/o', title: 'O' } },
        { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } } } }]);
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return json(200, { modelVersion: 'g-test', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'grounded reply' }] }, groundingMetadata: { webSearchQueries: ['q1', 'q2'], groundingChunks: [{ web: { uri: 'https://example.org/g', title: 'G' } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test('reframe template carries the divergent prompts and no hardware wording', () => {
  for (const needle of ['FREE-ASSOCIATE', 'ASSUMPTION TO DROP', 'drop entirely', 'remind you of', 'cheaply', 'one day or one dollar', 'opposite approach', 'structurally similar']) assert.match(REFRAME_TEMPLATE, new RegExp(needle));
  assert.doesNotMatch(REFRAME_TEMPLATE, /hardware|off-the-shelf|repurpos/i);
  assert.match(buildBrief('my question'), /QUESTION AND CONTEXT:\nmy question/);
  assert.equal(buildBrief('as is', { raw: true }), 'as is');
});

test('resolveModels maps roster keys to catalog ids, accepts raw ids, skips unknowns', () => {
  const { resolved, skipped } = resolveModels([...Object.keys(ROSTER), 'gpt-6-sol', 'vendor/nope', 'nonsense'], CATALOG);
  assert.deepEqual(resolved.slice(0, 8).map((m) => m.orId), ['google/gemini-4-argon', 'google/gemini-3.8-flash', 'openai/gpt-6-luna', 'openai/gpt-6-sol', 'openai/gpt-6-astra', 'moonshotai/kimi-k3.1-pro', 'meta/muse-spark-1.3', 'x-ai/grok-4.7']);
  assert.equal(resolved.find((m) => m.key === 'luna').route, 'openai');
  assert.equal(skipped.length, 2);
  // a retired preferred id falls back to the newest in its family
  const noArgon = resolveModels(['gemini-top', 'meta'], CATALOG.filter((m) => m.id !== 'google/gemini-4-argon' && m.id !== 'meta/muse-spark-1.3'));
  assert.deepEqual(noArgon.skipped.map((s) => s.key), ['gemini-top']);
  assert.equal(noArgon.resolved[0].orId, 'meta/muse-spark-1.2');
});

test('OpenRouter path: :online suffix, cost from usage, files written, key never in output', async () => {
  const { home, env } = sandbox(); const calls = [];
  const out = join(home, 'out');
  const r = await runFanout({ prompt: 'q', models: ['kimi', 'grok', 'meta'], outDir: out, env, fetchImpl: fakeFetch(calls) });
  assert.equal(r.results.filter((x) => x.ok).length, 3);
  const chat = calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.deepEqual(chat.map((c) => c.body.model).sort(), ['meta/muse-spark-1.3:online', 'moonshotai/kimi-k3.1-pro:online', 'x-ai/grok-4.7:online']);
  assert.match(readFileSync(join(out, 'kimi.md'), 'utf8'), /reply from moonshotai\/kimi-k3.1-pro/);
  assert.equal(r.totals.cost_usd, 0.06);
  assert.ok(existsSync(join(out, '_merge-input.md')) && existsSync(join(out, '_brief.md')) && existsSync(join(out, '_run.json')));
  assert.doesNotMatch(r.mergeInput + readFileSync(join(out, '_run.json'), 'utf8'), /TESTKEY/);
});

test('OpenAI path: Responses API with web_search through rev5/openai.mjs, no max_output_tokens on the subscription', async () => {
  const { env } = sandbox(); const calls = [];
  const r = await runFanout({ prompt: 'q', models: ['luna'], env, fetchImpl: fakeFetch(calls) });
  const call = calls.find((c) => c.url.includes('chatgpt.com'));
  assert.deepEqual(call.body.tools, [{ type: 'web_search' }]);
  assert.equal(call.body.model, 'gpt-6-luna');
  assert.equal('max_output_tokens' in call.body, false);
  assert.equal(r.results[0].text, 'hello from gpt-6-luna');
  assert.equal(r.results[0].route, 'openai-chatgpt-subscription');
  assert.equal(r.results[0].searches, 1);
  assert.ok(r.results[0].api_equiv_usd > 0);
});

test('Gemini path: google_search grounding when a Google key file exists, else OpenRouter', async () => {
  const { home, env } = sandbox(); const calls = [];
  writeFileSync(join(env.TOPHAT_FANOUT_SECRETS_DIR, 'gemini-api-key'), 'AIza-TEST\n');
  const r = await runFanout({ prompt: 'q', models: ['gemini-fast'], env, fetchImpl: fakeFetch(calls) });
  const g = calls.find((c) => c.url.includes('generativelanguage'));
  assert.deepEqual(g.body.tools, [{ google_search: {} }]);
  assert.equal(g.headers['x-goog-api-key'], 'AIza-TEST');
  assert.equal(r.results[0].text, 'grounded reply');
  assert.equal(r.results[0].searches, 2);
  const none = sandbox(); const calls2 = [];
  const r2 = await runFanout({ prompt: 'q', models: ['gemini-fast'], env: none.env, fetchImpl: fakeFetch(calls2) });
  assert.equal(calls2.some((c) => c.url.includes('generativelanguage')), false);
  assert.equal(r2.results[0].route, 'openrouter');
});

test('a failing model is reported and skipped, not fatal; the others still land', async () => {
  const { home, env } = sandbox(); const calls = [];
  const out = join(home, 'o');
  const r = await runFanout({ prompt: 'q', models: ['kimi', 'grok'], outDir: out, env, fetchImpl: fakeFetch(calls, { failOr: ['x-ai/grok-4.7'] }) });
  assert.equal(r.results.filter((x) => x.ok).length, 1);
  assert.match(r.mergeInput, /## Not answered\n- grok: openrouter: openrouter HTTP 400/);
  assert.doesNotMatch(r.mergeInput, /TESTKEY/);
  assert.ok(existsSync(join(out, 'grok.FAILED.md')));
});

test('spend cap refuses before any model is called', async () => {
  const { env } = sandbox(); const calls = [];
  await assert.rejects(() => runFanout({ prompt: 'q', models: ['astra', 'sol'], env, maxUsd: 0.05, fetchImpl: fakeFetch(calls) }), /over --max-usd/);
  assert.equal(calls.filter((c) => c.url.includes('chatgpt.com') || c.url.endsWith('/chat/completions')).length, 0);
  assert.ok(estimateWorstCase(resolveModels(['astra'], CATALOG).resolved, 1000, 16000) > 0.8);
});

test('a hung model hits its deadline; the others are on disk before it ends', async () => {
  const { home, env } = sandbox(); const calls = [];
  const base = fakeFetch(calls);
  const hang = async (url, init) => {
    if (url.endsWith('/chat/completions') && JSON.parse(init.body).model.startsWith('x-ai/')) return new Promise(() => {});
    return base(url, init);
  };
  const out = join(home, 'h');
  const r = await runFanout({ prompt: 'q', models: ['kimi', 'grok'], outDir: out, env, fetchImpl: hang, timeoutMs: 200 });
  assert.equal(r.results.find((x) => x.key === 'kimi').ok, true);
  assert.equal(r.results.find((x) => x.key === 'grok').ok, false);
  assert.match(readFileSync(join(out, 'grok.FAILED.md'), 'utf8'), /no reply within/);
  assert.ok(existsSync(join(out, 'kimi.md')));
});
