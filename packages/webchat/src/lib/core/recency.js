import { rankConversations as filteredConversations } from './frecency.js';

export { groupForks, trayCounts } from './frecency.js';

const activity = (chat) => Date.parse(chat.activeAt || chat.updatedAt || '') || 0;

// One sort with its keys computed once per chat.
export function rankConversations(conversations, options) {
  const rows = filteredConversations(conversations, { ...options, sorted: false });
  const keyed = rows.map((row) => ({ row, pin: row.pinned ? 1 : 0, at: activity(row) }));
  keyed.sort((a, b) => b.pin - a.pin || b.at - a.at || a.row.id.localeCompare(b.row.id));
  return keyed.map((entry) => entry.row);
}
