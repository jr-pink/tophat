// What a check-off or an edit in the system state area says to the memory plane.
//
// Revision 1 of the design settled this: when the owner ticks a box or rewrites a line in the state
// area, that is not a fact to file and it is not a job for a second, weaker model with a debounce
// timer. So the edit is written into the rev5 raw data plane as one owner record and the next push
// cycle interprets it against evidence.
//
// Everything here is pure: the words of the record and the exact shape of the row. The write, the
// digest and the sqlite lock live in src/lib/server/state-report.js, because they are effects.

import { parseListItem, stripWeight } from './notes-doc.js';
import { owner } from '../../../../runner/owner.mjs';

export const STATE_REPORT_SOURCE = 'notes-state';

// The plane's own convention for the owner and for the thing reading him, as the webchat records in
// raw_data already write them: author "owner", which is the identity that resolves to the owner, and
// "tophat" on the other side of the conversation.
export const OWNER = 'owner';
export const PARTICIPANTS = ['owner', 'tophat'];

// A check-off is a claim, not a receipt. The instruction travels in the record rather than in
// push_prompt.txt, because it is the record talking about itself and it should not become a
// standing rule about every other source.
const CLAIM =
  'Owner-reported completion takes effect immediately on the existing task. Preserve the owner report; '
  + 'independent evidence may strengthen its basis without reopening it.';

const PHRASES = {
  done: 'marked this done',
  dropped: 'marked this dropped',
  todo: 'moved this back to not done',
  await: 'parked this until its condition comes true',
  bullet: 'took the checkbox off this'
};

/** How the record opens: what he actually did to the marker, in the words he would use. */
function whatHeDid(after) {
  const item = parseListItem(after);
  if (!item) return 'changed this line';
  return PHRASES[item.listType === 'checkbox' ? item.checkboxState : 'bullet'] || 'changed this line';
}

/**
 * The record's text. The interpreter gets the line as it now reads, the thread it sits under and
 * the line as it read before, because a marker on its own says nothing about what was finished.
 * Scores are stripped: they are for the page's folds and never for a model.
 */
export function stateReportText({ kind, before = '', after = '', thread = null }) {
  const now = stripWeight(after).trim();
  const was = stripWeight(before).trim();
  const under = thread ? stripWeight(thread).trim() : '';
  if (kind === 'check') {
    return [
      `${owner()} ${whatHeDid(now)} in the system state area of his notes:`,
      `  ${now}`,
      ...(under ? [`under the thread: ${under}`] : []),
      `It had been: ${was}`,
      '',
      CLAIM
    ].join('\n');
  }
  return [
    `${owner()} rewrote a line in the system state area of his notes.`,
    `  before: ${was}`,
    `  after:  ${now}`,
    ...(under ? [`  under the thread: ${under}`] : [])
  ].join('\n');
}

/**
 * Python's `json.dumps(value, sort_keys=True, ensure_ascii=False)`, which is what rev5's store
 * writes its JSON columns with (rev5/store.py, `_j`). The row has to read back byte for byte the
 * way an ingested one does, and JSON.stringify puts no space after a comma, so this is spelled out
 * rather than borrowed.
 */
export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pyJson(value[key])}`).join(', ')}}`;
}

/**
 * One raw_data row, in the shapes that table already holds (rev5/store.py, `_raw_row`): revision
 * "1" because the record is written once and never revised, participants as the plane writes them,
 * and a locator that names the block and the line so a later reader can find the words again. The
 * thread column is the section's block id, which is what groups these records with each other;
 * the thread line the owner's edit sat under is prose, and it travels in the text and the locator.
 */
export function stateReportRow({
  kind, section = null, blockId = null, lineId = null, line = null, before = '', after = '',
  thread = null, now, policy = { model: 'allow', publish: 'none', reason: null }
}) {
  const at = String(now);
  const nativeId = [blockId || 'state', lineId || `line-${line ?? 0}`, at].join('/');
  const revision = '1';
  return {
    source: STATE_REPORT_SOURCE,
    account: '',
    nativeId,
    revision,
    role: 'owner',
    author: OWNER,
    participants: PARTICIPANTS,
    thread: blockId,
    occurredAt: at,
    availableAt: at,
    text: stateReportText({ kind, before, after, thread }),
    locator: {
      account: '',
      block: blockId,
      field: 'text',
      kind,
      line: lineId,
      line_index: Number.isInteger(line) ? line : null,
      native_id: nativeId,
      revision,
      section,
      source: STATE_REPORT_SOURCE,
      thread: blockId,
      thread_line: thread ? stripWeight(thread).trim() : null
    },
    policy
  };
}
