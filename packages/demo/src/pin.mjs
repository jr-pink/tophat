// What a visitor may not choose. The page sends settings with some actions (and a working directory with a new chat); the demo
// ignores all of it and pins what the instance runs on: the cheap model, the direct runner (no other provider), no automatic model
// routing, no fast mode, one reasoning effort, and the instance's own workspace as every chat's working directory. A message sent
// to a conversation id that does not exist yet creates it with the settings in that message, so it is pinned as well.
const SETTINGS_OPS = new Set(['conversation.create', 'conversation.fork', 'conversation.set_settings', 'message.send']);
const CWD_OPS = new Set(['conversation.create', 'conversation.fork', 'message.send']);

export function pinAction(action, { model, cwd, reasoningEffort = 'medium' }) {
  if (!action?.payload || typeof action.payload !== 'object' || !SETTINGS_OPS.has(action.op)) return action;
  const pinned = { ...(typeof action.payload.settings === 'object' && action.payload.settings ? action.payload.settings : {}),
    model, provider: 'direct', permissionMode: 'bypassPermissions', autoModel: false, fastMode: false, reasoningEffort, cwd };
  action.payload.settings = pinned;
  if (CWD_OPS.has(action.op)) action.payload.cwd = cwd;
  return action;
}
