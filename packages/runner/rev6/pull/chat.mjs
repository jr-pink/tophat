// The chat's own agent names and files its conversation: chat_rename and chat_archive. Before this an
// agent had no way to touch its own chat's title or archive flag short of minting a browser session
// cookie.
//
// Scope is the conversation this runner serves (TOPHAT_CONVERSATION_ID, set by the webchat's direct
// provider for the root agent), never an id the model names. Both go through the webchat's local
// POST /api/agent (ops rename, archive) with the service token, which applies the same
// conversation.rename / conversation.set_archived actions the sidebar sends, so every open tab
// updates live. Root agent only: a subagent does not file its parent's chat.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { webchatOrigin } from '../base/endpoints.mjs';

// The webchat address is config.json install.webchatPort (rev6/base/endpoints.mjs), read at call time so a bad config fails the call, not the import.
export const agentUrl = (env = process.env) => env.TOPHAT_WEBCHAT_AGENT_URL || `${webchatOrigin({ env })}/api/agent`;
const MAX_TITLE = 90;
const MAX_WORKSPACE = 60;
// The specs are data, in tools.json's "chat" group (chatSpecs in tools.mjs).

function serviceToken(env) {
  const dir = env.TOPHAT_SECRETS_DIR || join(env.HOME || homedir(), '.config', 'tophat', 'secrets');
  try { return readFileSync(join(dir, 'webchat-service-token'), 'utf8').trim(); } catch { return ''; }
}

/** Handlers for one root agent, or null when this runner serves no webchat conversation. */
export function createChatTools({ env = process.env, conversationId = env.TOPHAT_CONVERSATION_ID, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!conversationId) return null;
  async function call(body) {
    const token = serviceToken(env);
    if (!token) return { error: 'no webchat service token; cannot reach this chat' };
    try {
      const res = await fetchImpl(agentUrl(env), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...body, conversationId }), signal: AbortSignal.timeout(timeoutMs) });
      let out = {};
      try { out = JSON.parse(await res.text() || '{}'); } catch { /* not json */ }
      return res.ok ? out : { error: out.error || `webchat answered HTTP ${res.status}` };
    } catch (error) { return { error: `webchat unreachable: ${error.name}: ${error.message}` }; }
  }
  return {
    async chat_rename(i) {
      const title = String(i?.title ?? '').replace(/\s+/gu, ' ').trim();
      if (!title) return { error: 'chat_rename needs a title' };
      if (title.length > MAX_TITLE) return { error: `title is ${title.length} characters; keep it to ${MAX_TITLE}` };
      return call({ op: 'rename', title });
    },
    async chat_archive(i) { return call({ op: 'archive', archived: i?.archived !== false }); },
    // A prose claim is not a handoff: this delivers the work to the other chat as an automated event (/api/agent op handoff, the same
    // settle path push wakes use) and answers delivered or an error.
    async chat_handoff(i) {
      const target = String(i?.conversation_id ?? '').trim(), text = String(i?.text ?? '').trim();
      if (!target) return { error: 'chat_handoff needs the conversation_id of the chat to wake' };
      if (!text) return { error: 'chat_handoff needs the text to hand over: what is owed, to whom, the work item id, the source thread and what you already checked' };
      if (target === conversationId) return { error: 'that is this chat; do the work here' };
      return call({ op: 'handoff', target, text });
    },
    // /api/agent op workspace existed but no tool reached it, so a chat's agent that was told "this chat didn't get filed" could
    // only rename it.
    async chat_workspace(i) {
      const workspace = String(i?.workspace ?? '').replace(/\s+/gu, ' ').trim();
      if (workspace.length > MAX_WORKSPACE) return { error: `workspace is ${workspace.length} characters; keep it to ${MAX_WORKSPACE}` };
      return call({ op: 'workspace', workspace });
    },
  };
}
