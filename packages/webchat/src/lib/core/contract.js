

import { latestOf } from './model-family.js';
import {
  CLAUDE_MODELS, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, REASONING_EFFORTS,
  acceptModel, capabilitiesOf, isProvider, providerOfModel
} from './providers.js';

export const CONTRACT_VERSION = 1;
export const SCHEMA_HASH = 'tophat-webchat-v1';

export const ACTIONS = Object.freeze({
  CREATE: 'conversation.create',
  FORK: 'conversation.fork',
  SEND: 'message.send',
  INTERRUPT: 'run.interrupt',
  RENAME: 'conversation.rename',
  PIN: 'conversation.set_pinned',
  ARCHIVE: 'conversation.set_archived',
  ASIDE: 'conversation.set_aside',
  // Which named workspace (a folded group in the sidebar) the chat is filed under; null is unfiled.
  WORKSPACE: 'conversation.set_workspace',
  // Which peer (a hub device id, server/hosts.js) runs the chat; null is this host.
  HOST: 'conversation.set_host',
  DEFER: 'conversation.set_deferred',
  TOUCH: 'conversation.touch',
  READ: 'conversation.set_read',
  SETTINGS: 'conversation.set_settings',
  // Move the chat, and its whole history, to another scope (core/scopes.js, server/scopes.js).
  MOVE_SCOPE: 'conversation.move_scope'
});

export const EVENT_KINDS = Object.freeze([
  'conversation.created',
  'conversation.renamed',
  'conversation.pinned',
  'conversation.archived',
  'conversation.aside',
  'conversation.workspace',
  'conversation.host',
  'conversation.deferred',
  'conversation.meta',
  'conversation.opened',
  'message.user',
  'evaluation.snapshot',
  'assistant.delta',
  'assistant.message',
  'thinking.delta',
  'tool.started',
  'tool.input_delta',
  'tool.completed',
  'hook.fired',
  
  
  
  'pace.check',
  'context.compacted',
  'background.turn',
  'agent.started',
  'agent.completed',
  'run.status',
  'run.cancelled',
  'run.error',
  'run.completed'
]);

export const RUN_STATES = Object.freeze([
  'idle', 'queued', 'starting', 'thinking', 'running', 'cancelled', 'errored', 'completed'
]);

export const PERMISSION_MODES = Object.freeze([
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'
]);

export const MODELS = CLAUDE_MODELS;

export function fastModeAvailable(model, provider = providerOfModel(model)) {
  return capabilitiesOf(provider).fastMode && model === 'opus';
}

export function effectiveFastMode(settings = {}) {
  const provider = settings.provider || providerOfModel(settings.model);
  return Boolean(settings.fastMode) && fastModeAvailable(settings.model, provider);
}

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'direct',
  model: 'claude-sonnet-5-5',
  autoModel: true,
  fastMode: false,
  permissionMode: 'bypassPermissions',
  
  
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  cwd: null
});

// The Claude CLI answers its init event with the model it resolved to, a full id (claude-sonnet-5-5), and names no
// provider. For a chat already on the claude provider that is the CLI describing itself, not a request to move to the
// api-key runner: the provider stays and the id reads as the alias the CLI takes back (sonnet).
const CLAUDE_REPORTED_ID = /^claude-(opus|sonnet|haiku|fable)-/;
function claudeAliasOf(model) {
  const m = CLAUDE_REPORTED_ID.exec(String(model || ''));
  return m && CLAUDE_MODELS.includes(m[1]) ? m[1] : null;
}

export function normalizeSettings(value = {}, base = DEFAULT_SETTINGS) {
  const reported = !isProvider(value.provider) && base.provider === 'claude' ? claudeAliasOf(value.model) : null;
  const provider = isProvider(value.provider)
    ? value.provider
    : (reported ? 'claude' : value.model ? providerOfModel(value.model) : (base.provider || providerOfModel(base.model)));
  
  
  
  const accepted = acceptModel(provider, reported ?? value.model)
    ?? acceptModel(provider, base.model)
    ?? DEFAULT_MODEL[provider];
  const autoModel = (value.autoModel ?? base.autoModel) !== false;
  // On auto a Claude model is its family, so an older version reads as the family's newest (core/model-family.js).
  const model = provider === 'direct' && autoModel ? latestOf(accepted) : accepted;
  return {
    provider,
    model,
    reasoningEffort: REASONING_EFFORTS.includes(value.reasoningEffort)
      ? value.reasoningEffort
      : (REASONING_EFFORTS.includes(base.reasoningEffort) ? base.reasoningEffort : DEFAULT_REASONING_EFFORT),
    
    
    
    fastMode: Boolean(value.fastMode ?? base.fastMode),
    autoModel,
    permissionMode: PERMISSION_MODES.includes(value.permissionMode)
      ? value.permissionMode
      : base.permissionMode,
    cwd: typeof value.cwd === 'string' && value.cwd ? value.cwd : base.cwd
  };
}

let fallbackCounter = 0;
export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  fallbackCounter += 1;
  return `id-${fallbackCounter}`;
}

export function makeAction({
  op,
  conversationId,
  payload = {},
  deviceId,
  deviceSeq,
  actionId = newId(),
  at = null
}) {
  if (!Object.values(ACTIONS).includes(op)) throw new TypeError(`Unsupported action: ${op}`);
  if (!conversationId) throw new TypeError('Action requires a conversation id');
  if (!deviceId) throw new TypeError('Action requires a device id');
  if (!Number.isSafeInteger(deviceSeq) || deviceSeq < 1) throw new TypeError('Invalid device seq');
  return {
    contract_version: CONTRACT_VERSION,
    schema_hash: SCHEMA_HASH,
    action_id: actionId,
    idempotency_key: actionId,
    device_id: deviceId,
    device_seq: deviceSeq,
    conversation_id: conversationId,
    op,
    payload,
    at
  };
}

export function validateAction(action) {
  if (action?.contract_version !== CONTRACT_VERSION || action?.schema_hash !== SCHEMA_HASH) {
    throw new TypeError('Unsupported action schema');
  }
  return makeAction({
    op: action.op,
    conversationId: action.conversation_id,
    payload: action.payload || {},
    deviceId: action.device_id,
    deviceSeq: action.device_seq,
    actionId: action.action_id,
    at: action.at ?? null
  });
}

export function makeEvent({ kind, conversationId, cursor, runId = null, content = {}, at }) {
  if (!EVENT_KINDS.includes(kind)) throw new TypeError(`Unsupported event kind: ${kind}`);
  return {
    contract_version: CONTRACT_VERSION,
    schema_hash: SCHEMA_HASH,
    event_id: `${conversationId}:${cursor}`,
    conversation_id: conversationId,
    run_id: runId,
    cursor,
    kind,
    content,
    at
  };
}

export function validateEvent(raw) {
  if (raw?.contract_version !== CONTRACT_VERSION || raw?.schema_hash !== SCHEMA_HASH) {
    throw new TypeError('Unsupported event schema');
  }
  if (!EVENT_KINDS.includes(raw.kind)) throw new TypeError(`Unsupported event kind: ${raw.kind}`);
  if (!raw.event_id || !raw.conversation_id) throw new TypeError('Event missing identity');
  if (!Number.isSafeInteger(raw.cursor) || raw.cursor < 1) throw new TypeError('Invalid cursor');
  return raw;
}

export function compareEvents(a, b) {
  return a.cursor - b.cursor || String(a.event_id).localeCompare(String(b.event_id));
}
