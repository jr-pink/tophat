

export const PROVIDERS = Object.freeze(['claude', 'codex', 'kimi', 'direct']);

export const PROVIDER_LABELS = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  direct: 'Direct (rev 5)'
});


export const CLAUDE_MODELS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);

export const CODEX_MODELS = Object.freeze([
  'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'
]);
export const KIMI_MODELS = Object.freeze(['kimi-k3']);

// The direct provider speaks to the model APIs itself, so its models are API ids, not CLI aliases: Anthropic
// Messages for claude-*, OpenAI Responses for gpt-* (rev5/openai.mjs). A gpt model needs its own key file on
// the runner; without one the runner answers with an auth failure naming the missing file, never a substitute model.
export const DIRECT_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'gpt-6-astra']);

export const CATALOGUE = Object.freeze({
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  kimi: KIMI_MODELS,
  direct: DIRECT_MODELS
});

export const DEFAULT_MODEL = Object.freeze({
  claude: 'opus',
  codex: 'gpt-6-astra',
  kimi: 'kimi-k3',
  direct: 'claude-sonnet-5-5'
});

export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const DEFAULT_REASONING_EFFORT = 'medium';

export const CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    fork: true,
    resume: true,
    midTurnSteer: true,
    compact: true,
    setModelLive: true,
    setPermissionModeLive: true,
    fastMode: true,
    reasoningEffort: false,
    subagents: true
  }),
  codex: Object.freeze({
    fork: true,
    resume: true,
    midTurnSteer: true,
    compact: true,
    
    
    setModelLive: true,
    
    
    setPermissionModeLive: true,
    fastMode: false,
    reasoningEffort: true,
    subagents: true
  }),
  kimi: Object.freeze({
    fork: true,
    resume: true,
    midTurnSteer: true,
    compact: true,
    setModelLive: true,
    setPermissionModeLive: true,
    
    
    fastMode: false,
    reasoningEffort: false,
    subagents: true
  }),
  direct: Object.freeze({
    fork: true,
    resume: true,
    midTurnSteer: true,
    compact: true,
    setModelLive: true,
    setPermissionModeLive: true,
    fastMode: false,
    reasoningEffort: true,
    subagents: false
  })
});

export function capabilitiesOf(provider) {
  return CAPABILITIES[provider] || CAPABILITIES.claude;
}

export function providerOfModel(model) {
  for (const provider of PROVIDERS) {
    if (CATALOGUE[provider].includes(model)) return provider;
  }
  return 'claude';
}

const CODEX_MODEL_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DIRECT_MODEL_SHAPE = /^(?:claude|gpt)-[a-z0-9][a-z0-9.-]{0,63}$/i;

export function acceptModel(provider, model) {
  if (typeof model !== 'string' || !model) return null;
  if (CATALOGUE[provider]?.includes(model)) return model;
  for (const other of PROVIDERS) {
    if (other !== provider && CATALOGUE[other].includes(model)) return null;
  }
  if (provider === 'codex' && CODEX_MODEL_SHAPE.test(model)) return model;
  if (provider === 'direct' && DIRECT_MODEL_SHAPE.test(model)) return model;
  return null;
}

export function isProvider(value) {
  return PROVIDERS.includes(value);
}
