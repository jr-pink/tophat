// The local webchat's address, read from the one place that states it: config.json `install.webchatPort`
// (rev6/base/config.mjs holds the schema default). Callers that used to spell `http://127.0.0.1:4178`
// (rev6/pull/chat.mjs, rev6/push/wake.mjs, rev6/upkeep, tools/tophat-projects, tools/tophat-findmy, tools/tophat-mcp)
// ask here instead, so moving the port is one edit. An explicit origin in the environment still wins, under both
// names callers already honoured (WEBCHAT_URL, TOPHAT_WEBCHAT_URL).
// Never: write a file, or invent a port; an invalid config throws (loadConfig), it does not fall back to a number.
import { loadConfig } from './config.mjs';

export function webchatPort({ env = process.env, config } = {}) {
  return (config || loadConfig({ env })).install.webchatPort;
}

export function webchatOrigin({ env = process.env, config } = {}) {
  const explicit = env.TOPHAT_WEBCHAT_URL || env.WEBCHAT_URL;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  return `http://127.0.0.1:${webchatPort({ env, config })}`;
}
