// Who a shell belongs to. Every provider spawns one child per conversation turn, and that child's
// environment has carried TOPHAT_CONVERSATION_ID alone: the same value for the conversation and for
// every subagent under it, so two subagents running at once are indistinguishable to any tool that
// tries to scope state by it. TOPHAT_AGENT_ID names the agent itself instead; the runner sets it per
// subagent (`agent_8aa87b0d`, minted in rev5/agents.mjs), and what we set here is the value the
// conversation's own turn uses.
//
// Short, lowercase, no spaces and no slashes, because it is used as an tophat-cdp / tophat-ui job name
// and as a path segment. rev5/tools.mjs holds the identical rootAgentId for the runner's own side
// (a runner started by hand has no TOPHAT_AGENT_ID to inherit); keep the two in step, or a shell's id
// changes depending on who started the process.
import { createHash } from 'node:crypto';

/** The agent id of a conversation's own turn: stable per conversation, distinct from any subagent's. */
export function rootAgentId(conversationId) {
  return `root_${createHash('sha256').update(String(conversationId ?? '')).digest('hex').slice(0, 8)}`;
}
