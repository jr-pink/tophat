/** Deferring a chat: a time, a condition, or both.
 *
 * and a defer until, where i can set a time or condition. same as todo tasks.
 *
 * Same shape as the notes await marker (`core/notes-doc.js`, `rev5/push.py`): the date half is
 * decided here, in code, for nothing; a condition with no date in it waits for the nightly model
 * to say it is met. The difference from notes is the clock. A todo is a day.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Where a bare day lands when he named no hour: the start of the working morning. */
export const DEFAULT_HOUR = 9;
/** "tonight" and "this evening". */
export const EVENING_HOUR = 18;

const MONTHS = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'],
  ['june', 'jun'], ['july', 'jul'], ['august', 'aug'], ['september', 'sept', 'sep'],
  ['october', 'oct'], ['november', 'nov'], ['december', 'dec']
];
const MONTH_RE = new RegExp(`\\b(${MONTHS.flat().join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'u');
const MONTH_INDEX = new Map(MONTHS.flatMap((names, month) => names.map((name) => [name, month])));

const WEEKDAYS = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tues', 'tue'], ['wednesday', 'weds', 'wed'],
  ['thursday', 'thurs', 'thur', 'thu'], ['friday', 'fri'], ['saturday', 'sat']
];
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAYS.flat().join('|')})\\b`, 'u');
const WEEKDAY_INDEX = new Map(WEEKDAYS.flatMap((names, day) => names.map((name) => [name, day])));

const DURATION_RE = /\bin\s+(a|an|one|two|three|four|five|six|seven|\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|month|months)\b/u;
const SMALL = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/u;

const atLocal = (base, { year, month, day, hour = DEFAULT_HOUR, minute = 0 }) => {
  const anchor = new Date(base);
  return new Date(
    year ?? anchor.getFullYear(),
    month ?? anchor.getMonth(),
    day ?? anchor.getDate(),
    hour, minute, 0, 0
  );
};

const startOfDay = (ms) => {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day;
};

/** The hour and minute the words name, or null. */
function clockIn(text) {
  const found = CLOCK_RE.exec(text);
  if (!found) return null;
  if (found[3]) {
    const raw = Number(found[1]);
    if (raw > 12) return null;
    const hour = (raw % 12) + (found[3] === 'pm' ? 12 : 0);
    return { hour, minute: Number(found[2] || 0) };
  }
  const hour = Number(found[4]);
  const minute = Number(found[5]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The calendar day the words name, as a local Date at midnight, or null. */
function dayIn(text, now) {
  const base = startOfDay(now).getTime();

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/u.exec(text);
  if (iso) return atLocal(base, { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]), hour: 0 });

  const named = MONTH_RE.exec(text);
  if (named) {
    const month = MONTH_INDEX.get(named[1]);
    const day = Number(named[2]);
    if (named[3]) return atLocal(base, { year: Number(named[3]), month, day, hour: 0 });
    const year = new Date(base).getFullYear();
    const thisYear = atLocal(base, { year, month, day, hour: 0 });
    return thisYear.getTime() >= base ? thisYear : atLocal(base, { year: year + 1, month, day, hour: 0 });
  }

  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/u.exec(text);
  if (slash) {
    const month = Number(slash[1]) - 1;
    const day = Number(slash[2]);
    if (slash[3]) {
      const year = Number(slash[3]);
      return atLocal(base, { year: year < 100 ? 2000 + year : year, month, day, hour: 0 });
    }
    const year = new Date(base).getFullYear();
    const thisYear = atLocal(base, { year, month, day, hour: 0 });
    return thisYear.getTime() >= base ? thisYear : atLocal(base, { year: year + 1, month, day, hour: 0 });
  }

  if (/\btomorrow\b/u.test(text)) return startOfDay(base + DAY);
  if (/\b(today|tonight|this\s+evening|later\s+today)\b/u.test(text)) return startOfDay(base);
  if (/\b(this\s+weekend|the\s+weekend)\b/u.test(text)) {
    const ahead = (6 - new Date(base).getDay() + 7) % 7 || 7;   // the coming Saturday, never today
    return startOfDay(base + ahead * DAY);
  }
  if (/\bnext\s+week\b/u.test(text)) {
    const ahead = (1 - new Date(base).getDay() + 7) % 7 || 7;   // Monday
    return startOfDay(base + ahead * DAY);
  }
  if (/\bnext\s+month\b/u.test(text)) {
    const anchor = new Date(base);
    return atLocal(base, { year: anchor.getFullYear(), month: anchor.getMonth() + 1, day: anchor.getDate(), hour: 0 });
  }

  const weekday = WEEKDAY_RE.exec(text);
  if (weekday) {
    const ahead = (WEEKDAY_INDEX.get(weekday[1]) - new Date(base).getDay() + 7) % 7 || 7;
    return startOfDay(base + ahead * DAY);
  }
  return null;
}

/** `until` is an ISO instant when the words name one and null when they do not; `condition` is
 * always the words themselves, because the tray shows them and the nightly model reads them. A
 * chat deferred on "when the invoice arrives" has a condition and no clock; one deferred on
 * "friday 3pm" has both, and the clock is enough to bring it back without asking anyone.
 */
export function parseDefer(text, now = Date.now()) {
  const raw = String(text ?? '').trim();
  const condition = raw || null;
  const lower = raw.toLowerCase();
  if (!lower) return { until: null, condition: null };

  const duration = DURATION_RE.exec(lower);
  if (duration) {
    const count = SMALL[duration[1]] ?? Number(duration[1]);
    const unit = duration[2];
    const span = unit.startsWith('mi') || unit === 'm' ? MINUTE
      : unit.startsWith('h') ? HOUR
      : unit.startsWith('d') ? DAY
      : unit.startsWith('w') ? 7 * DAY
      : 30 * DAY;
    return { until: new Date(now + count * span).toISOString(), condition };
  }

  const clock = clockIn(lower);
  const day = dayIn(lower, now);
  const evening = /\b(tonight|this\s+evening)\b/u.test(lower);
  const hour = clock ? clock.hour : (evening ? EVENING_HOUR : DEFAULT_HOUR);
  const minute = clock ? clock.minute : 0;

  if (day) {
    const when = atLocal(day.getTime(), { year: day.getFullYear(), month: day.getMonth(), day: day.getDate(), hour, minute });
    return { until: when.toISOString(), condition };
  }
  if (clock) {
    // An hour with no day is the next time that hour comes round.
    let when = atLocal(now, { hour, minute });
    if (when.getTime() <= now) when = new Date(when.getTime() + DAY);
    return { until: when.toISOString(), condition };
  }
  return { until: null, condition };
}

/**
 * Where a deferred chat stands right now: 'due' once its hour has passed, 'waiting' while it has
 * not, null when the chat is not deferred at all. A chat with a condition and no hour waits until
 * the nightly step or he himself clears it, which is exactly how an await todo behaves.
 */
export function deferState(conversation, now = Date.now()) {
  const until = conversation?.deferUntil ? Date.parse(conversation.deferUntil) : NaN;
  const condition = conversation?.deferCondition || null;
  if (!Number.isFinite(until) && !condition) return null;
  if (Number.isFinite(until)) return until <= now ? 'due' : 'waiting';
  return 'waiting';
}

/** True while the chat should be out of the main list: deferred and not yet due. */
export const isDeferred = (conversation, now = Date.now()) => deferState(conversation, now) === 'waiting';

/** The one line a deferred row shows: when it comes back, or what it waits on. */
export function deferLabel(conversation, now = Date.now()) {
  const until = conversation?.deferUntil ? Date.parse(conversation.deferUntil) : NaN;
  const condition = conversation?.deferCondition || null;
  if (!Number.isFinite(until)) return condition || '';
  const date = new Date(until);
  const today = startOfDay(now).getTime();
  const days = Math.round((startOfDay(until).getTime() - today) / DAY);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  const when = days <= 0 ? time
    : days === 1 ? `tomorrow ${time}`
    : days < 7 ? `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return condition && !looksLikeTimeOnly(condition) ? `${condition} · ${when}` : when;
}

/** A condition that is nothing but a time phrase adds nothing to the formatted hour beside it. */
export function looksLikeTimeOnly(condition) {
  const text = String(condition || '').toLowerCase().trim();
  if (!text) return true;
  const stripped = text
    .replace(DURATION_RE, ' ')
    .replace(CLOCK_RE, ' ')
    .replace(MONTH_RE, ' ')
    .replace(WEEKDAY_RE, ' ')
    .replace(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?)\b/u, ' ')
    .replace(/\b(today|tonight|this evening|later today|tomorrow|this weekend|the weekend|next week|next month|at|on|by|in|until|till|morning|afternoon|evening|night|am|pm)\b/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  return stripped === '';
}

/** The quick picks in the defer popover. The text is what a hand would type, and parses the same. */
export const DEFER_PRESETS = Object.freeze([
  { label: 'In an hour', text: 'in 1 hour' },
  { label: 'This evening', text: 'tonight' },
  { label: 'Tomorrow', text: 'tomorrow 9am' },
  { label: 'This weekend', text: 'this weekend' },
  { label: 'Next week', text: 'next week' }
]);
