// The two things the notes page needs from the browser that are worth testing on their own: where
// a click lands in the raw markdown of a rendered block, and how a time reads in the gutter.

import { rawOffset, parseInline } from './notes-format.js';
import { parseListItem } from '$lib/core/notes-doc.js';

/**
 * The offset in `body` a click at (x, y) points at. A rendered block hides the list marker, so an
 * offset inside a line's text span is measured against that line's content and put back where the
 * marker's characters are. A click anywhere else on the line lands at the start of its content.
 */
export function offsetFromPoint(blockEl, x, y, body) {
  const lines = body.split('\n');
  const starts = [];
  let cursor = 0;
  for (const line of lines) { starts.push(cursor); cursor += line.length + 1; }

  // Browser caret hit-testing can choose the following line in trailing whitespace.
  // Pick the visual row first, and only use native caret geometry inside its text.
  const row = [...blockEl.querySelectorAll('[data-line]')].find(element => {
    const rect = element.getBoundingClientRect();
    return y >= rect.top && y < rect.bottom;
  });
  const index = row ? Number(row.dataset.line) : lines.length - 1;
  const line = lines[index] ?? '';
  const item = parseListItem(line);
  const prefix = row?.dataset.prefix !== undefined ? Number(row.dataset.prefix) : item ? item.prefix : 0;
  const inline = row?.dataset.inline ?? line.slice(prefix);
  const start = starts[index] ?? 0;

  const text = row?.querySelector?.('[data-text]');
  if (!text) return start + prefix;

  const position = caretPosition(x, y);
  if (!position || !text.contains(position.node)) {
    // To the right of the words is the end of the line; to the left of them, the start.
    const box = text.getBoundingClientRect();
    return x > box.right ? start + prefix + rawOffset(inline,parseInline(inline).text.length) : start + prefix;
  }
  const within = offsetWithin(text, position.node, position.offset);
  return Math.min(start + line.length, start + prefix + rawOffset(inline,within));
}

function caretPosition(x, y) {
  if (document.caretPositionFromPoint) {
    const found = document.caretPositionFromPoint(x, y);
    return found ? { node: found.offsetNode, offset: found.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

function offsetWithin(root, node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.nodeValue.length;
    current = walker.nextNode();
  }
  return total;
}

// --- the gutter, in the reference app's words -----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/** the reference app's day: it turns over at 4am, so a note written at 2am still belongs to the night before. */
function mostRecent4am(now) {
  const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0);
  if (now.getHours() < 4) boundary.setDate(boundary.getDate() - 1);
  return boundary;
}

/** the reference app's formatTimeGutter: a clock time today, then how long ago, at one decimal place. */
export function gutterTime(at, now = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  if (!date || Number.isNaN(date.getTime())) return '';
  if (date >= mostRecent4am(now)) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
  }
  const ago = now.getTime() - date.getTime();
  if (ago < WEEK) {
    const days = Math.floor(ago / DAY);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  if (ago < MONTH) return fraction(ago / WEEK, 'week');
  if (ago < YEAR) return fraction(ago / MONTH, 'month');
  return fraction(ago / YEAR, 'year');
}

function fraction(value, unit) {
  const whole = Math.floor(value);
  const tenth = Math.floor((value - whole) * 10);
  if (whole === 1 && tenth === 0) return `1 ${unit} ago`;
  if (tenth === 0) return `${whole} ${unit}s ago`;
  return `${whole}.${tenth} ${unit}s ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The gutter as a ruler rather than a column of dates, in two parts, because the two parts are
 * read differently: the date is always on screen ("Sep 23", and "2025 Jan 1" when the year turns
 * over, which includes the first tick of the document), and the time under the pointer. A tick on
 * the same day as the tick above it has no date to add, so that part is empty and only the time
 * is there to reveal.
 */
export function rulerTick(at, previous = null) {
  const date = at instanceof Date ? at : new Date(at);
  if (!date || Number.isNaN(date.getTime())) return { date: '', time: '' };
  const prior = previous === null || previous === undefined
    ? null
    : (previous instanceof Date ? previous : new Date(previous));
  const stale = prior && Number.isNaN(prior.getTime());

  const hour12 = date.getHours() % 12 || 12;
  const half = date.getHours() < 12 ? 'am' : 'pm';
  const sameHour = prior && !stale
    && prior.getFullYear() === date.getFullYear() && prior.getMonth() === date.getMonth()
    && prior.getDate() === date.getDate() && prior.getHours() === date.getHours();
  const time = date.getMinutes() === 0 && !sameHour
    ? `${hour12}${half}`
    : `${hour12}:${String(date.getMinutes()).padStart(2, '0')}${half}`;

  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  if (!prior || stale) return { date: `${date.getFullYear()} ${day}`, time };
  const sameYear = prior.getFullYear() === date.getFullYear();
  const sameDay = sameYear && prior.getMonth() === date.getMonth() && prior.getDate() === date.getDate();
  if (sameDay) return { date: '', time };
  if (sameYear) return { date: day, time };
  return { date: `${date.getFullYear()} ${day}`, time };
}
