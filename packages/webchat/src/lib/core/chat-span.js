// The span of a chat's messages as a short label for a search row (owner request, 2026-11-15 11:47 PST: the search should show "the
// chat message range (eg. a single day, if not today, or time range if past 24h) same as the notes app, or date to date"; then "2d ago
// actually is better"). From the chat's first message to its last:
//   both within the last 24 h      "10:56-11:44" (local clock times)
//   one older day                  "2d ago"
//   several days                   "5d-2d ago"
//   one end within 24 h, one older "3d-2h ago"
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const unit = (ms) => (ms < DAY ? `${Math.max(0, Math.round(ms / HOUR))}h` : `${Math.round(ms / DAY)}d`);

export function chatSpan(startIso, endIso, nowMs = Date.now()) {
  const end = Date.parse(endIso || '');
  if (!Number.isFinite(end)) return '';
  let start = Date.parse(startIso || '');
  if (!Number.isFinite(start) || start > end) start = end;
  const ageStart = nowMs - start, ageEnd = Math.max(0, nowMs - end);
  if (ageStart < DAY) return start === end || clock(start) === clock(end) ? clock(end) : `${clock(start)}-${clock(end)}`;
  const a = unit(ageStart), b = unit(ageEnd);
  return a === b ? `${b} ago` : `${a}-${b} ago`;
}
