// Model presets for the intake: a named, benchmarked model entry the instance file can pick with one key instead of
// spelling out the endpoint, provider routing and prices. The instance's own keys win over the preset's, so a preset
// is a starting point, never a lock-in:
//
//   "intake": { "model": { "preset": "gpt-6.1-terra-openrouter", "credential": { "keyring": "openrouter-api-key" } } }
//
// gpt-6.1-terra is the recommended intake model: on a 40-packet push benchmark it kept 97.5% of source facts (micro;
// 98.1% macro) against 81.3% for claude-opus-5-5, at about a quarter of the cost per packet (docs/push-model-bench.md).
// Its tuned rules are the appendix prompts/appendix/gpt-6.1-terra.txt, which derive.mjs appends for this model.
const TERRA = { model: 'gpt-6.1-terra', appendix: 'gpt-6.1-terra', maxTokens: 32000, timeoutMs: 900000,
  price: { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.05 } };

export const MODEL_PRESETS = Object.freeze({
  // OpenRouter, restricted to zero-data-retention endpoints that do not train on prompts.
  'gpt-6.1-terra-openrouter': { ...TERRA, provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-6.1-terra',
    body: { provider: { data_collection: 'deny', zdr: true }, temperature: 0 } },
  // OpenAI directly (an OpenAI API key); store: false so OpenAI keeps no stored completion. A new API organisation's rate
  // limits can be far below an intake's packet size: check the key's tokens-per-minute limit before choosing this.
  'gpt-6.1-terra-openai': { ...TERRA, provider: 'openai', baseUrl: 'https://api.openai.com/v1', maxTokensField: 'max_completion_tokens', body: { store: false } },
});

/** A model entry with its preset expanded (the entry's own keys win); an entry without a preset is returned as is. */
export function resolveModel(cfg = {}) {
  if (!cfg || cfg.preset === undefined) return cfg;
  const preset = MODEL_PRESETS[cfg.preset];
  if (!preset) throw new Error(`model.preset must be one of ${Object.keys(MODEL_PRESETS).join(', ')}`);
  const { preset: name, ...own } = cfg;
  return { ...preset, ...own, ...(preset.body || own.body ? { body: { ...(preset.body || {}), ...(own.body || {}) } } : {}),
    ...(own.price ? { price: { ...preset.price, ...own.price } } : {}), presetName: name };
}
