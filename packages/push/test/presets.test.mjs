// Model presets, the openai provider's request extras and usage, the model-keyed prompt appendix and the billed cost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_PRESETS, resolveModel } from '../presets.mjs';
import { makeProvider } from '../providers.mjs';
import { PROMPT, appendixFor, promptFor } from '../derive.mjs';
import { callCost } from '../budget.mjs';

test('a preset expands into a full model entry; the instance entry wins key by key', () => {
  const m = resolveModel({ preset: 'gpt-6.1-terra-openrouter', apiKeyEnv: 'K', maxTokens: 9000, body: { temperature: 0.2 } });
  assert.equal(m.provider, 'openai');
  assert.equal(m.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(m.model, 'openai/gpt-6.1-terra');
  assert.equal(m.maxTokens, 9000);
  assert.deepEqual(m.body, { provider: { data_collection: 'deny', zdr: true }, temperature: 0.2 });
  assert.deepEqual(m.price, { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.05 });
  assert.equal(resolveModel({ provider: 'stub' }).provider, 'stub');
  assert.throws(() => resolveModel({ preset: 'nope' }), /model.preset must be one of/);
  assert.ok(MODEL_PRESETS['gpt-6.1-terra-openai']);
});

test('the openai provider sends the body extras and the configured max-tokens field, and reads cached tokens and billed cost', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return new Response(JSON.stringify({ model: 'openai/gpt-6.1-terra', choices: [{ message: { content: '{"entities":[],"notes":[]}' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.00093 } }), { status: 200 }); };
  const p = makeProvider({ preset: 'gpt-6.1-terra-openrouter', apiKeyEnv: 'K' }, { fetch, env: { K: 'sk-x' } });
  const r = await p.complete({ system: 'S', user: 'U', maxTokens: 500 });
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer sk-x');
  assert.deepEqual(seen[0].body.provider, { data_collection: 'deny', zdr: true });
  assert.equal(seen[0].body.max_tokens, 500);
  assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 600, provider_cost_usd: 0.00093 });
  const direct = makeProvider({ preset: 'gpt-6.1-terra-openai', apiKeyEnv: 'K' }, { fetch, env: { K: 'sk-x' } });
  await direct.complete({ system: 'S', user: 'U', maxTokens: 500 });
  assert.equal(seen[1].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen[1].body.max_completion_tokens, 500);
  assert.equal(seen[1].body.max_tokens, undefined);
  assert.equal(seen[1].body.store, false);
});

test('an OpenAI-compatible 200 carrying only an error is an error, not an empty answer', async () => {
  const fetch = async () => new Response(JSON.stringify({ error: { code: 404, message: 'No endpoints found' } }), { status: 200 });
  const p = makeProvider({ provider: 'openai', model: 'm', apiKeyEnv: 'K' }, { fetch, env: { K: 'k' } });
  await assert.rejects(p.complete({ system: 'S', user: 'U', maxTokens: 10 }), /No endpoints found/);
});

test('the appendix reaches only its model; every other model gets the prompt unchanged', () => {
  assert.equal(promptFor({ provider: 'anthropic', model: 'claude-opus-5-5' }), PROMPT);
  const terra = promptFor({ preset: 'gpt-6.1-terra-openrouter' });
  assert.ok(terra.startsWith(PROMPT.trimEnd()));
  assert.match(terra, /AUDIT RULES/);
  assert.equal(promptFor({ provider: 'openai', model: 'gpt-6.1-terra' }), terra);
  assert.equal(promptFor({ preset: 'gpt-6.1-terra-openrouter', appendix: false }), PROMPT);
  assert.equal(appendixFor({ model: '../derive' }), '');
});

test('cost: the billed figure when reported, else usage at the prices with cached input at its own rate', () => {
  const price = { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.05 };
  assert.equal(callCost(price, { input_tokens: 1, output_tokens: 1, provider_cost_usd: 0.5 }), 0.5);
  assert.ok(Math.abs(callCost(price, { input_tokens: 1e6, output_tokens: 1e6, cached_input_tokens: 4e5 }) - (0.6 + 5 + 0.02)) < 1e-9);
  assert.ok(Math.abs(callCost({ inputPerMTok: 1, outputPerMTok: 5 }, { input_tokens: 1e6, output_tokens: 0, cached_input_tokens: 4e5 }) - 1) < 1e-9);
});
