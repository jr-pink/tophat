// The owner's clock, for everything the model reads.
//
// Every instant the runner stores or receives is an ISO UTC string. The owner
// lives in one zone (TOPHAT_TIMEZONE, else this machine's), and "today",
// "yesterday" and weekdays only mean anything in that zone. Given UTC alone the
// model compared UTC dates: a message from the same Pacific afternoon read as
// "yesterday" because its UTC date was a day behind the clock's (frozen run
// round 2, F7). So every instant that reaches the model travels with an
// owner-local rendering beside it, and the prompt names the local time first.
//
// The same zone decides which calendar day a written date falls on, which is
// what the pre-send wording check needs: "Monday, September 11" is a conflict
// when September 11 of the nearest year is a Friday.

export function ownerZone(env = process.env) {
  return env.TOPHAT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const partsOf = (iso, timeZone, options) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

export function localTime(iso, env = process.env) {
  const timeZone = ownerZone(env);
  try {
    return `${new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(iso))} (${timeZone})`;
  } catch { return `unknown (time zone ${timeZone} not recognised)`; }
}

/** Null when the instant or zone is unusable. */
export function localStamp(iso, env = process.env) {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null;
  try {
    const p = partsOf(iso, ownerZone(env), { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  } catch { return null; }
}

/** The clock line of a system prompt: the owner's time first, the UTC instant beside it. */
export function clockLine(iso, env = process.env) {
  return `Owner local time: ${localTime(iso, env)}; the same instant in UTC: ${iso}.`;
}

/** The owner-local calendar date of an instant, "YYYY-MM-DD". */
export function localDate(iso, env = process.env) {
  const p = partsOf(iso, ownerZone(env), { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const TIME_KEY = /(?:^|_)at$/;

/**
 * A tool result with an owner-local rendering beside every instant: for each key `at` or `*_at` holding an ISO
 * instant, a sibling `<key>_local` follows it. Structure, order and every other value are untouched.
 */
export function withLocalTimes(value, env = process.env, depth = 0) {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withLocalTimes(v, env, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = withLocalTimes(v, env, depth + 1);
    if (TIME_KEY.test(key) && typeof v === 'string' && INSTANT.test(v) && !(`${key}_local` in value)) {
      const stamp = localStamp(v, env);
      if (stamp) out[`${key}_local`] = stamp;
    }
  }
  return out;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAY = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
// "Monday, September 11", "Mon Sep 11, 2026", "Monday the 11th of September", "Monday 9/11", "Monday 9/11/2026".
const WORDED = new RegExp(`\\b${WEEKDAY}\\b\\.?,?\\s+(?:the\\s+)?(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|(\\d{1,2})(?:st|nd|rd|th)\\s+(?:of\\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b)(?:,?\\s+(\\d{4})\\b)?`, 'gi');
const NUMERIC = new RegExp(`\\b${WEEKDAY}\\b\\.?,?\\s+(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, 'gi');

const utcDay = (y, m, d) => { const t = Date.UTC(y, m, d); const dt = new Date(t); return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null; };

/**
 * Written dates whose named weekday is not the weekday that date falls on: [{ phrase, date, named, actual }].
 * A date without a year is read in the year (of the previous, this or the next) that puts it nearest the owner's
 * local date at `now`. Nothing is inferred beyond the pairs written out; a bare "last Monday" is not checked.
 */
export function dateWordConflicts(text, now = new Date().toISOString(), env = process.env) {
  const conflicts = [];
  const today = Date.parse(`${localDate(now, env)}T00:00:00Z`);
  const year0 = new Date(today).getUTCFullYear();
  const check = (phrase, dayWord, m, d, yearText) => {
    const named = WEEKDAY_INDEX[dayWord.slice(0, 3).toLowerCase()];
    if (named === undefined || m === undefined || m < 0 || m > 11) return;
    let date = null;
    if (yearText) date = utcDay(yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText), m, d);
    else {
      for (const y of [year0 - 1, year0, year0 + 1]) {
        const candidate = utcDay(y, m, d);
        if (candidate && (!date || Math.abs(candidate.getTime() - today) < Math.abs(date.getTime() - today))) date = candidate;
      }
    }
    if (!date) return;
    if (date.getUTCDay() !== named) conflicts.push({ phrase, date: date.toISOString().slice(0, 10), named: WEEKDAYS[named], actual: WEEKDAYS[date.getUTCDay()] });
  };
  for (const hit of String(text || '').matchAll(WORDED)) {
    const [phrase, dayWord, monthA, dayA, dayB, monthB, year] = hit;
    const month = monthA || monthB;
    check(phrase, dayWord, MONTH_INDEX[month.slice(0, 3).toLowerCase()], Number(dayA || dayB), year);
  }
  for (const hit of String(text || '').matchAll(NUMERIC)) {
    const [phrase, dayWord, mm, dd, year] = hit;
    check(phrase, dayWord, Number(mm) - 1, Number(dd), year);
  }
  return conflicts;
}
