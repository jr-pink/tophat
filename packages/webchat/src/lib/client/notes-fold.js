// The shape of a note's lines: what is indented under what, which nodes start folded, and the
// importance score the builder leaves on a line.
//
// Folding is general to the notes document: any line with indented lines under it can fold, in the
// state area and in the rest of the page. What is different in the state area is the default, which
// is computed rather than stored: the builder writes an importance score on every line it generates
// and the rule below reads it, so the details of a thread are out of the way exactly when the next
// thread matters more than they do. A fold he sets by hand overrides the default and is kept by
// line id in the fold store; nothing here writes anything down.
//
// The score rides as a trailing HTML comment, `<!--w:0.82-->`. It is the only machine-readable
// thing allowed in his text, so it is stripped from everything a person reads and from everything a
// model is sent.

/** The trailing importance comment, anchored to the end so a `<!--` he types mid-line is his. */
export const SCORE_RE = /\s*<!--\s*w:\s*(-?\d+(?:\.\d+)?)\s*-->\s*$/u;

/** The importance the builder gave this line, or null when the line is his. */
export function scoreOf(line) {
  const found = SCORE_RE.exec(String(line ?? ''));
  if (!found) return null;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : null;
}

/** The line as the eye should see it, and as a model should be sent it. */
export function stripScore(line) {
  return String(line ?? '').replace(SCORE_RE, '');
}

/** Split the hidden score without eating whitespace the author just typed. */
export function splitScore(line) {
  const raw = String(line ?? '');
  const match = /\s?<!--\s*w:\s*(-?\d+(?:\.\d+)?)\s*-->\s*$/u.exec(raw);
  return match ? { text: raw.slice(0, match.index), score: match[0] } : { text: raw, score: '' };
}

/** Every line of a body with its score comment taken off. */
export function stripScores(text) {
  return String(text ?? '').split('\n').map(stripScore).join('\n');
}

/**
 * How deep a line sits. A list item indents in twos, which is what `notes-doc.js` writes, and a
 * plain line is measured the same way so prose under a heading can fold too. A tab is one level.
 */
export function lineDepth(line) {
  const lead = /^[\t ]*/u.exec(String(line ?? ''))[0];
  if (!lead) return 0;
  const tabs = (lead.match(/\t/gu) || []).length;
  const spaces = lead.replace(/\t/gu, '').length;
  return tabs + Math.floor(spaces / 2);
}

/**
 * The outline of a body: for each line, its depth, its direct children, how many lines hang under
 * it in total, and the sibling that follows it at its own level. A blank line belongs to whatever
 * it sits inside, so a gap inside a thread does not end it.
 */
export function outline(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const depths = list.map((line, index) => (String(line).trim() === '' ? null : lineDepth(line)));
  // A blank line takes the depth of the next line that has one, so it never closes a node early.
  for (let index = depths.length - 1; index >= 0; index -= 1) {
    if (depths[index] === null) depths[index] = index + 1 < depths.length ? depths[index + 1] : 0;
  }
  const nodes = list.map((line, index) => ({
    index, depth: depths[index], text: String(line), score: scoreOf(line),
    children: [], descendants: 0, next: null, parent: null
  }));
  for (const node of nodes) {
    for (let at = node.index + 1; at < nodes.length; at += 1) {
      if (nodes[at].depth <= node.depth) { if (nodes[at].depth === node.depth) node.next = at; break; }
      node.descendants += 1;
      if (nodes[at].depth === node.depth + 1) { node.children.push(at); nodes[at].parent = node.index; }
    }
  }
  return nodes;
}

/** If the next thread matters more than this thread's details, the details are in the way of
 * reading.
 *
 * No next sibling, no score on the node, or no score anywhere in its children means not folded:
 * the rule only speaks where the builder gave it something to compare.
 */
export function foldsByDefault(nodes, index) {
  const node = nodes[index];
  if (!node || node.children.length === 0) return false;
  if (node.score === null) return false;
  if (node.next === null) return false;
  const next = nodes[node.next];
  if (!next || next.score === null) return false;
  const kids = node.children.map((at) => nodes[at].score).filter((score) => score !== null);
  if (kids.length === 0) return false;
  return next.score > Math.max(...kids);
}

/** Every line index whose children the rule folds. */
export function defaultFolds(nodes) {
  const folded = new Set();
  for (const node of nodes) if (foldsByDefault(nodes, node.index)) folded.add(node.index);
  return folded;
}

/** The lines hidden right now: everything under a folded node, its own sub-folds included. */
export function hiddenUnder(nodes, folded) {
  const hidden = new Set();
  for (const index of folded) {
    const node = nodes[index];
    if (!node) continue;
    for (let at = index + 1; at <= index + node.descendants; at += 1) hidden.add(at);
  }
  return hidden;
}

/**
 * The thread a line sits under: the nearest top-level line above it, which in the state area is the
 * one thing that is happening. A heading line is the section, not a thread, so it is skipped.
 */
export function threadOf(lines, index) {
  const nodes = outline(lines);
  for (let at = Math.min(index, nodes.length - 1); at >= 0; at -= 1) {
    const node = nodes[at];
    if (node.depth !== 0) continue;
    if (/^##\s+/u.test(node.text)) return '';
    if (node.text.trim() === '') continue;
    return stripScore(node.text);
  }
  return '';
}

/**
 * The lines that differ between what was last reported and what stands now, by index. Several
 * edits inside the debounce window collapse here: the before is whatever was last reported, not
 * whatever the previous keystroke left. The score comment is not a change a person made.
 */
export function changedLines(before, after) {
  const was = Array.isArray(before) ? before : String(before ?? '').split('\n');
  const now = Array.isArray(after) ? after : String(after ?? '').split('\n');
  const out = [];
  for (let index = 0; index < Math.max(was.length, now.length); index += 1) {
    const from = stripScore(was[index] ?? '');
    const to = stripScore(now[index] ?? '');
    if (from !== to) out.push({ index, before: from, after: to });
  }
  return out;
}
