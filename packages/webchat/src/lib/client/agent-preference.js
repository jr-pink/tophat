// The agent a new chat opens on. It used to be the compiled-in default in
// contract.js (or the deployment's pin), so working a week in Codex still meant
// every ⌘N landed on the default and had to be switched by hand. The agent he
// last used is kept here instead — in localStorage, beside the microphone he
// picked — and a new chat is created with it.
//
// Only a provider this build knows, with a model that provider owns, comes back
// out: a stored agent from an older build, or a model since retired, reads as
// nothing and the old default stands. Storage is per browser, like every other
// UI preference here; the server's pinnedDefaults still fills anything a chat
// does not name.

import { REASONING_EFFORTS, acceptModel, isProvider } from '../core/providers.js';

// Bumping the name drops the stale pick once; from there his last-used tracking carries on as
// before.
const AGENT_KEY = 'tophat.chat.agent.v2';

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function trusted(settings) {
  const provider = isProvider(settings?.provider) ? settings.provider : null;
  if (!provider) return null;
  // acceptModel refuses a model another provider owns, so a half-written pair
  // (claude + gpt-6-astra) is dropped rather than quietly repointed.
  const model = acceptModel(provider, settings?.model);
  if (!model) return null;
  return {
    provider,
    model,
    ...(REASONING_EFFORTS.includes(settings?.reasoningEffort)
      ? { reasoningEffort: settings.reasoningEffort }
      : {})
  };
}

/** The agent he last used, or null when there is none worth trusting. */
export function lastUsedAgent() {
  let raw = null;
  try { raw = storage()?.getItem(AGENT_KEY) || null; } catch { return null; }
  if (!raw) return null;
  try { return trusted(JSON.parse(raw)); } catch { return null; }
}

/** Remember the agent of the chat he is working in. Returns what was stored. */
export function rememberAgent(settings) {
  const agent = trusted(settings);
  if (!agent) return null;
  try { storage()?.setItem(AGENT_KEY, JSON.stringify(agent)); } catch { /* private mode */ }
  return agent;
}

/** What to spread into a `conversation.create` payload: the last-used agent, or
 *  nothing at all, which leaves the existing default in place. */
export function newChatSettings() {
  const agent = lastUsedAgent();
  return agent ? { settings: agent } : {};
}

/** Tests only: forget the stored choice. */
export function forgetAgent() {
  try { storage()?.removeItem(AGENT_KEY); } catch { /* private mode */ }
}
