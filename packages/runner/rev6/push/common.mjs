// Shared helpers for rev6 push. Every digest and every stored JSON column must be byte-identical
// to rev5's Python (json.dumps(sort_keys=True, ensure_ascii=False)), because ids are digests of
// batch content and the store is shared with the Python runtime until cutover.
import { createHash } from 'node:crypto';

/** Python's json.dumps(value, sort_keys=True, ensure_ascii=False, default=str). */
export function pyDumps(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return String(value).replace(/e([+-])(\d)$/u, 'e$10$2');
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pyDumps).join(', ') + ']';
  if (value instanceof Date) return JSON.stringify(String(value));
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pyDumps(value[k])).join(', ') + '}';
  }
  return JSON.stringify(String(value));
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const digest = (value, size = 16) => sha256(pyDumps(value)).slice(0, size);

/** ISO 8601 to UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` (rev5.pages.instant). Throws on unreadable input. */
export function instant(value) {
  let text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) text += 'T00:00:00';
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:?\d{2}(?::\d{2})?)?$/u.exec(text.replace(/z$/u, 'Z'));
  if (!m) throw new Error(`Invalid isoformat string: '${value}'`);
  const [, day, hh, mi, ss = '00', frac = '', zone = 'Z'] = m;
  const ms = (frac + '000').slice(0, 3);
  const z = zone === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone.slice(0, 6);
  const t = Date.parse(`${day}T${hh}:${mi}:${ss}.${ms}${z}`);
  if (!Number.isFinite(t)) throw new Error(`Invalid isoformat string: '${value}'`);
  return new Date(t).toISOString();
}

export const nowIso = () => new Date().toISOString();
export const isoPlusSeconds = (seconds, from = Date.now()) => new Date(from + seconds * 1000).toISOString();
export const msOf = (iso) => Date.parse(String(iso).replace(/Z?$/u, (z) => (/[+-]\d\d:\d\d$/u.test(String(iso)) ? '' : 'Z')));

/** Strip a fenced reply down to its first JSON object (rev5's raw_decode idiom). */
export function firstJson(text) {
  const body = String(text ?? '').trim().replace(/^```(?:json)?|```$/gmu, '').trim();
  const start = body.indexOf('{');
  if (start < 0) throw new SyntaxError('no JSON object in response');
  return rawDecode(body.slice(start));
}

/** JSON.parse of the first complete value at the start of `text`, ignoring what follows. */
export function rawDecode(text) {
  try { return JSON.parse(text); } catch (error) {
    const end = jsonEnd(text);
    if (end > 0) return JSON.parse(text.slice(0, end));
    throw error;
  }
}
function jsonEnd(text) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

export const uniq = (items) => [...new Set(items)];
export const sortedStrings = (items) => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** Python `str.lower()` close enough for keys (no locale). */
export const lower = (s) => String(s ?? '').toLowerCase();
export const isStr = (v) => typeof v === 'string';
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Python truthiness for JSON-ish values. */
export const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length));
/** Python `str(x)` for the values model JSON carries. */
export const pyStr = (v) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'object' ? pyDumps(v) : String(v));
/** Python repr of a str, for messages that embed %r. */
export const pyRepr = (s) => (typeof s === 'string' ? (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`) : s === null || s === undefined ? 'None' : String(s));
/** Python json.dumps(value, ensure_ascii=False) without sort_keys: insertion order, Python separators. */
export function pyDumpsOrdered(v) {
  if (Array.isArray(v)) return '[' + v.map(pyDumpsOrdered).join(', ') + ']';
  if (isObj(v)) return '{' + Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => JSON.stringify(k) + ': ' + pyDumpsOrdered(x)).join(', ') + '}';
  return pyDumps(v);
}
// Python strings index by code point; JS by UTF-16 unit. Every length or slice that reaches a
// packet, a receipt or a stored count goes through these so astral characters (emoji) count once.
const ASTRAL = /[\ud800-\udbff][\udc00-\udfff]/;
export const cpLen = (s) => { s = String(s ?? ''); return ASTRAL.test(s) ? [...s].length : s.length; };
export function cpSlice(s, a, b) {
  s = String(s ?? '');
  if (!ASTRAL.test(s)) return s.slice(a, b);
  return [...s].slice(a, b).join('');
}
/** A RegExp with Python 3 `re` word boundaries (unicode letters, numbers and underscore), always /u. */
const PYW = '[\\p{L}\\p{N}_]', PYB = `(?:(?<=${PYW})(?!${PYW})|(?<!${PYW})(?=${PYW}))`;
export const pyRe = (src, flags = '') => new RegExp(src.replaceAll('\\b', PYB), flags + 'u');
export const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return Boolean(tz); } catch { return false; } };
/** Wall-clock fields of UTC milliseconds `t` in zone `tz` (weekday: Monday 0, as Python). */
export function zoned(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute, S: +p.second, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), t };
}
/** UTC milliseconds of a wall-clock time in `tz` (Python aware-datetime arithmetic, fold 0). */
export function wallToUtc(y, m, d, H, M, S, tz) {
  const want = Date.UTC(y, m - 1, d, H, M, S); let guess = want;
  for (let i = 0; i < 3; i++) { const p = zoned(guess, tz); guess += want - Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S); }
  return guess;
}
export const pad2 = (n) => String(n).padStart(2, '0');
export const isoSeconds = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/u, 'Z');
