// A notes block as an Automerge document.
//
// The block's lines are ONE text sequence with the newline as a character: every line begins with
// its own "\n" (so "\nfirst\nsecond"), and the identity of a line is the identity of that newline
// character. Splitting a line inserts a newline; joining two lines deletes one; neither copies a
// word. A concurrent edit of either half of a join, or of either side of a cut, lands on the same
// characters on every device, so there is nothing to double and nothing to lose: that is the class
// of bug the line-table merge (the one this replaces) could only bound, and it is why this is a
// sequence CRDT over the block's text rather than a list of lines each holding a string.
//
//   doc.text    "\nline one\nline two": the characters, newlines included
//   doc.ids     { cursor: rowId } the id the store already knows a newline's line by, for the blocks
//               that existed before this. A line with no entry is named by its newline's own id.
//   doc.place   { lineId: { after: lineId | null } } where a line was MOVED to. Automerge has no
//               move on a sequence, so a move is a last-writer-wins record about the line, not a
//               cut and paste of its words: two devices that move the same line concurrently cannot
//               make two lines, and an edit to a moved line still lands on its characters.
//   doc.head    the id of the block's first line, for text that has lost its first newline
//   doc.boot    what the doc was bootstrapped from (a hash). Two docs merge only when their boots
//               agree, because Automerge merges unrelated documents by keeping one of them.
//
// A line's other fields (kind, chat link, created_at, source, position of the block) are not text
// and stay per-field last-writer-wins in the store, as docstore's notes app keeps them.
//
// Everything here is pure. The Automerge module is handed in (`useAutomerge`) because the server and
// the tests import its node build and the browser loads its WebAssembly (notes-crdt-browser.js).

let A = null;
/** Hand in the Automerge module (any build): `useAutomerge(await import('@automerge/automerge'))`. */
export function useAutomerge(module) { A = module; }
export const automergeReady = () => A !== null;
function am() {
  if (!A) throw new Error('automerge is not loaded');
  return A;
}

// --- small helpers ----------------------------------------------------------------------------

/** A 128-bit hex digest (four cyrb-style 32-bit lanes): deterministic, sync, no crypto needed. */
export function hash128(text) {
  let h1 = 0x9e3779b9; let h2 = 0x243f6a88; let h3 = 0xb7e15162; let h4 = 0xdeadbeef;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
export function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The id a newline character names its line by when the store gave it none: its own op id. */
function derivedId(cursor) {
  const at = cursor.indexOf('@');
  return `l${cursor.slice(0, at)}-${cursor.slice(at + 1, at + 13)}`;
}

// --- reading ----------------------------------------------------------------------------------

/**
 * The lines of a document, in text order, with where each begins: `[{ id, body, start, cursor }]`.
 * `start` is the index of the line's newline; `body` begins one after it. Text that has lost its
 * first newline (another device deleted the first line's) begins with an implicit line, `start` -1.
 */
function textLines(read) {
  const { text, ids, head, cursorAt } = read;
  const out = [];
  let at = text.indexOf('\n');
  if (at !== 0) {
    out.push({ id: head, body: at < 0 ? text : text.slice(0, at), start: -1, cursor: null });
  }
  const taken = new Set(out.map((line) => line.id));
  while (at >= 0) {
    const next = text.indexOf('\n', at + 1);
    const cursor = cursorAt(at);
    let id = ids[cursor] ?? derivedId(cursor);
    if (taken.has(id)) id = `${derivedId(cursor)}~`;
    taken.add(id);
    out.push({ id, body: text.slice(at + 1, next < 0 ? text.length : next), start: at, cursor });
    at = next;
  }
  return out;
}

/**
 * Text order with the moves applied. A line with a `place` record whose anchor is a line of the block
 * (or the start) stands directly after its anchor; lines sharing an anchor go by id; a chain of
 * moves follows its anchors; a loop of moves, which no device writes but two can make, is left in
 * text order. The same document gives the same order everywhere.
 */
function displayOrder(lines, place) {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const moved = new Map();
  for (const line of lines) {
    const rec = place?.[line.id];
    if (!rec) continue;
    const after = rec.after ?? null;
    if (after === line.id || (after !== null && !byId.has(after))) continue;
    moved.set(line.id, after);
  }
  if (moved.size === 0) return lines;
  const kids = new Map();
  for (const [id, after] of moved) {
    if (!kids.has(after)) kids.set(after, []);
    kids.get(after).push(id);
  }
  for (const list of kids.values()) list.sort();
  const out = [];
  const seen = new Set();
  const emit = (line) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    out.push(line);
    for (const kid of kids.get(line.id) || []) emit(byId.get(kid));
  };
  for (const kid of kids.get(null) || []) emit(byId.get(kid));
  for (const line of lines) if (!moved.has(line.id)) emit(line);
  for (const line of lines) emit(line);      // a loop of moves: nothing is dropped
  return out;
}

function readOf(doc) {
  const Am = am();
  return { text: String(doc.text), ids: doc.ids || {}, head: doc.head, cursorAt: (i) => Am.getCursor(doc, ['text'], i) };
}

/** `{ lines: display order [{ id, body }], text: text order with starts }`. */
export function project(doc) {
  const text = textLines(readOf(doc));
  const display = displayOrder(text, doc.place);
  return { lines: display.map((line) => ({ id: line.id, body: line.body })), text, display };
}

export const linesOf = (doc) => project(doc).lines;
export const bodyOf = (doc) => project(doc).lines.map((line) => line.body).join('\n');

// --- making and moving documents --------------------------------------------------------------

/**
 * A document from lines `[{ id, body }]`. Deterministic for a given block id and lines (fixed actor
 * and time), so two devices that bootstrap the same rows get byte-identical documents, which merge
 * as one.
 */
export function bootstrap(blockId, lines) {
  const Am = am();
  const rows = (lines?.length ? lines : [{ id: blockId, body: '' }]).map((line, at) => ({
    id: String(line.id || (at === 0 ? blockId : `${blockId}~${at}`)), body: String(line.body ?? '')
  }));
  const boot = hash128(JSON.stringify([blockId, rows]));
  const actor = hash128(`actor:${blockId}`);
  let doc = Am.init({ actor });
  doc = Am.change(doc, { time: 0 }, (d) => {
    d.text = '';
    d.ids = {};
    d.place = {};
    d.head = rows[0].id;
    d.boot = boot;
    Am.splice(d, ['text'], 0, 0, rows.map((row) => `\n${row.body}`).join(''));
    let at = 0;
    for (const row of rows) {
      d.ids[Am.getCursor(d, ['text'], at)] = row.id;
      at += 1 + row.body.length;
    }
  });
  // Loaded again so that edits to it are made under an actor of its own: the bootstrap's actor is
  // the same on every device, and two devices editing under one actor is two histories under one name.
  return Am.load(Am.save(doc));
}

export const saveDoc = (doc) => am().save(doc);
export const loadDoc = (bytes) => am().load(bytes);
export const encodeDoc = (doc) => toBase64(am().save(doc));
export const decodeDoc = (text) => am().load(fromBase64(text));
export const heads = (doc) => am().getHeads(doc);
export const isDoc = (value) => Boolean(value) && typeof value === 'object' && typeof value.text === 'string' && typeof value.boot === 'string';

/** Whether two documents grew from one bootstrap, so merging them is a merge and not a replacement. */
export const sameLineage = (a, b) => isDoc(a) && isDoc(b) && a.boot === b.boot;

/** Every change either document has made, in one: commutative, idempotent, and a no-op for a replay. */
export function mergeDocs(a, b, { consume = false } = {}) {
  const Am = am();
  const merged = Am.merge(consume ? a : Am.clone(a), b);
  // The merged document is saved and loaded again. Automerge 3.5's in-memory view of a merge can
  // differ from the document it represents (a string a concurrent replacement left concatenated:
  // found by the model check, seed 320 of 3 replicas x 60 steps, with the saved bytes right and the
  // view wrong), and everything here reads the view. A loaded document is also one with an actor
  // of its own, which a document bootstrapped from fixed bytes must never edit under.
  const clean = Am.load(Am.save(merged));
  Am.free(merged);
  return clean;
}

/**
 * Give a document's WebAssembly memory back now. Automerge frees it when the handle is collected, and
 * collection does not see wasm memory, so a loop that makes thousands of documents (the model check)
 * runs the wasm heap into its 4 GB limit (`MemError`) before the garbage collector looks. Only for
 * a document nothing else holds.
 */
export function freeDoc(doc) {
  try { am().free(doc); } catch { /* already gone */ }
}

/** The same document, forked: edits to the copy leave the original alone. */
export const cloneDoc = (doc) => am().clone(doc);

// --- the diff ---------------------------------------------------------------------------------

/**
 * Hunks between two token arrays: `{ ai, ad, bi, bn }` removes `ad` tokens at `ai` of `a` and puts
 * `bn` tokens from `bi` of `b` there. A shortest edit script (Myers); a script longer than `maxD`
 * becomes one hunk over everything the two do not share at either end.
 */
export function diffTokens(a, b, maxD = 1200) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea -= 1; eb -= 1; }
  if (ea === s && eb === s) return [];
  const whole = [{ ai: s, ad: ea - s, bi: s, bn: eb - s }];
  if (ea === s || eb === s) return whole;
  const x = a.slice(s, ea);
  const y = b.slice(s, eb);
  const n = x.length;
  const m = y.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let px = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) { px += 1; py += 1; }
      v[off + k] = px;
      if (px >= n && py >= m) { found = d; break; }
    }
  }
  if (found < 0) return whole;
  const delA = new Uint8Array(n);
  const insB = new Uint8Array(m);
  let px = n;
  let py = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = px - py;
    const pk = (k === -d || (k !== d && prev[off + k - 1] < prev[off + k + 1])) ? k + 1 : k - 1;
    const prevX = prev[off + pk];
    const prevY = prevX - pk;
    while (px > prevX && py > prevY) { px -= 1; py -= 1; }
    if (px === prevX) insB[prevY] = 1; else delA[prevX] = 1;
    px = prevX;
    py = prevY;
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !delA[i] && !insB[j]) { i += 1; j += 1; continue; }
    const hunk = { ai: s + i, ad: 0, bi: s + j, bn: 0 };
    while ((i < n && delA[i]) || (j < m && insB[j])) {
      if (i < n && delA[i]) { i += 1; hunk.ad += 1; }
      if (j < m && insB[j]) { j += 1; hunk.bn += 1; }
    }
    hunks.push(hunk);
  }
  return hunks;
}

/** Longest increasing subsequence of `seq` (distinct numbers): the indexes into `seq` it keeps. */
function lisIndexes(seq) {
  const tails = [];
  const tailAt = [];
  const prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
    tailAt[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

// Line-level match for a write that names no ids: the lines both sides share, by words.
function matchByBody(oldLines, newLines) {
  const hunks = diffTokens(oldLines.map((line) => line.body), newLines.map((line) => line.body), 3000);
  const pairs = [];
  let i = 0;
  let j = 0;
  for (const h of hunks) {
    while (i < h.ai) { pairs.push([i, j]); i += 1; j += 1; }
    i += h.ad;
    j += h.bn;
  }
  while (i < oldLines.length && j < newLines.length) { pairs.push([i, j]); i += 1; j += 1; }
  return pairs;
}

// --- editing ----------------------------------------------------------------------------------

const same = (xs, ys) => xs.length === ys.length && xs.every((x, at) => x.body === ys[at].body && (ys[at].id == null || x.id === ys[at].id));

/**
 * The block as `newLines` (`[{ id, body }]`, display order), as edits to the document `doc`.
 *
 * The edit is the shortest script that turns the document's text into the new text, with a line's
 * identity honoured when the caller names it: a line whose id is in the document is that line (so a
 * line that moves, or whose words are rewritten, is not cut and pasted), an id the document does not
 * know, or none, is a new line. A join is one deleted newline, a split one inserted newline, a typed
 * word an insert at the spot, a deleted span a delete; a move is a `place` record. With no ids at all
 * lines are matched by their words, and the diff finds joins and splits from the characters.
 *
 * Returns the new document (the same object when nothing changed). The input document is left
 * usable unless `consume` is set: then it is spent (Automerge's own linear use), which is what a
 * page typing into one block wants, because forking a document costs as much as its history.
 */
export function applyLines(doc, newLinesIn, { consume = false } = {}) {
  const Am = am();
  const wanted = (newLinesIn?.length ? newLinesIn : [{ id: null, body: '' }])
    .map((line) => ({ id: line.id ?? null, body: String(line.body ?? '').replace(/\n/g, ' ') }));
  let cur = project(doc);
  if (same(cur.lines, wanted)) return doc;
  // A document whose first line has lost its newline: give it one again, so every line has its own.
  if (!consume) doc = Am.clone(doc);
  if (cur.text[0]?.start === -1) {
    doc = Am.change(doc, (d) => {
      Am.splice(d, ['text'], 0, 0, '\n');
      d.ids[Am.getCursor(d, ['text'], 0)] = cur.text[0].id;
    });
    cur = project(doc);
  }
  const T = cur.text;
  const known = new Set(T.map((line) => line.id));
  const hinted = wanted.some((line) => line.id != null && known.has(line.id));

  // Which new line is which old line: `keepOf[j]` is the index into T, or -1 for a new line.
  const keepOf = new Array(wanted.length).fill(-1);
  const used = new Set();
  if (hinted) {
    const at = new Map(T.map((line, i) => [line.id, i]));
    wanted.forEach((line, j) => {
      if (line.id != null && at.has(line.id) && !used.has(line.id)) { keepOf[j] = at.get(line.id); used.add(line.id); }
    });
  } else {
    const textIndex = new Map(T.map((line, i) => [line.id, i]));
    const pairs = matchByBody(cur.lines, wanted);
    for (const [oi, nj] of pairs) { keepOf[nj] = textIndex.get(cur.lines[oi].id); used.add(cur.lines[oi].id); }
    // Between two lines both sides share, the lines that are not the same words are paired in order:
    // a line retyped in place is that line (its characters are diffed, nothing is cut and pasted),
    // which matters most for a line that was moved, whose words are not where the screen shows it.
    const ends = [...pairs, [cur.lines.length, wanted.length]];
    let from = [0, 0];
    for (const end of ends) {
      const gapOld = []; const gapNew = [];
      for (let oi = from[0]; oi < end[0]; oi += 1) gapOld.push(oi);
      for (let nj = from[1]; nj < end[1]; nj += 1) gapNew.push(nj);
      for (let k = 0; k < Math.min(gapOld.length, gapNew.length); k += 1) {
        keepOf[gapNew[k]] = textIndex.get(cur.lines[gapOld[k]].id);
        used.add(cur.lines[gapOld[k]].id);
      }
      from = [end[0] + 1, end[1] + 1];
    }
  }

  // The target in TEXT order: kept lines where they stand, new lines right after the line before them.
  const target = [];
  const keptEntry = new Map();
  T.forEach((line, ti) => {
    const j = keepOf.indexOf(ti);
    if (j >= 0) { const entry = { kept: line.id, body: wanted[j].body, j }; target.push(entry); keptEntry.set(j, entry); }
  });
  const entryOf = new Map(keptEntry);
  wanted.forEach((line, j) => {
    if (keepOf[j] >= 0) return;
    const entry = { kept: null, body: line.body, j, explicit: line.id };
    let at = 0;
    for (let p = j - 1; p >= 0; p -= 1) { if (entryOf.has(p)) { at = target.indexOf(entryOf.get(p)) + 1; break; } }
    target.splice(at, 0, entry);
    entryOf.set(j, entry);
  });

  // Segments: from each kept line's newline to the next kept line's newline, on both sides.
  const keptSet = new Set(target.filter((entry) => entry.kept).map((entry) => entry.kept));
  const segments = [];
  const tokenize = (body) => Array.from(body);
  let ti = 0;
  let ni = 0;
  const first = { old: [], neo: [], oldStart: 0, newMeta: [] };
  const pushSegment = (s) => { s.done = true; if (s.old.length || s.neo.length) segments.push(s); };
  let seg = first;
  const sentinelKey = (side, id, j) => (hinted ? `\n#${side}:${id ?? j}` : '\n');
  while (ti < T.length || ni < target.length) {
    // Old lines up to the next kept line.
    while (ti < T.length && !keptSet.has(T[ti].id)) {
      seg.old.push(sentinelKey('old', T[ti].id, ti), ...tokenize(T[ti].body));
      ti += 1;
    }
    while (ni < target.length && !target[ni].kept) {
      seg.neo.push(sentinelKey('new', null, target[ni].j), ...tokenize(target[ni].body));
      seg.newMeta.push(ni);
      ni += 1;
    }
    pushSegment(seg);
    if (ti < T.length && ni < target.length) {
      // The kept line itself: its newline is shared, its words open the next segment.
      seg = { old: [...tokenize(T[ti].body)], neo: [...tokenize(target[ni].body)], oldStart: T[ti].start + 1, newMeta: [] };
      ti += 1;
      ni += 1;
    }
  }
  if (!seg.done) pushSegment(seg);

  const hunks = [];
  for (const s of segments) {
    const olds = s.old.map((t) => t);
    const news = s.neo.map((t) => t);
    const oldCum = [0];
    for (const t of olds) oldCum.push(oldCum.at(-1) + (t[0] === '\n' ? 1 : t.length));
    const newCum = [0];
    for (const t of news) newCum.push(newCum.at(-1) + (t[0] === '\n' ? 1 : t.length));
    const str = (t) => (t[0] === '\n' ? '\n' : t);
    for (const h of diffTokens(olds, news)) {
      hunks.push({
        pos: s.oldStart + oldCum[h.ai], del: oldCum[h.ai + h.ad] - oldCum[h.ai],
        ins: news.slice(h.bi, h.bi + h.bn).map(str).join('')
      });
    }
  }
  hunks.sort((a, b) => b.pos - a.pos);

  // Line ids the writer chose for new lines: honoured when the newline is new and the id is free.
  const oldCursors = new Set(T.map((line) => line.cursor));
  const out = Am.change(doc, (d) => {
    for (const h of hunks) Am.splice(d, ['text'], h.pos, h.del, h.ins);
    for (const dropped of T) if (!keptSet.has(dropped.id) && d.place[dropped.id]) delete d.place[dropped.id];
    const after = textLines(readOf(d));
    // `after` and `target` are the same lines in the same order: the text is the target's text.
    const idsNow = new Set(after.map((line) => line.id));
    const finalIds = after.map((line) => line.id);
    target.forEach((entry, k) => {
      const line = after[k];
      if (!line) return;
      if (entry.kept === null && entry.explicit != null && line.cursor && !oldCursors.has(line.cursor)
        && line.id !== entry.explicit && !idsNow.has(entry.explicit)) {
        d.ids[line.cursor] = entry.explicit;
        idsNow.delete(line.id);
        idsNow.add(entry.explicit);
        finalIds[k] = entry.explicit;
      }
    });
    // Where each wanted line is now, by id, so the display order can be made to match.
    const wantedIds = wanted.map((line, j) => finalIds[target.indexOf(entryOf.get(j))]);
    const shown = displayOrder(after.map((line, k) => ({ ...line, id: finalIds[k] })), d.place).map((line) => line.id);
    if (shown.length === wantedIds.length && shown.every((id, k) => id === wantedIds[k])) return;
    const atShown = new Map(shown.map((id, k) => [id, k]));
    const keep = lisIndexes(wantedIds.map((id) => atShown.get(id)));
    wantedIds.forEach((id, k) => {
      if (keep.has(k)) return;
      d.place[id] = { after: k === 0 ? null : wantedIds[k - 1] };
    });
    // Check the display now reads as wanted; if a stale record gets in the way, chain every line.
    const check = displayOrder(after.map((line, k) => ({ ...line, id: finalIds[k] })), d.place).map((line) => line.id);
    if (!check.every((id, k) => id === wantedIds[k])) {
      wantedIds.forEach((id, k) => { d.place[id] = { after: k === 0 ? null : wantedIds[k - 1] }; });
    }
  });
  return out;
}

// --- carets -----------------------------------------------------------------------------------

/**
 * A caret as a position in the block's display text (lines joined by newlines) made stable: an
 * Automerge cursor on the character it sits before. `where(cursor)` on the merged document reads it
 * back, after every edit that landed since.
 */
export function cursorFor(doc, offset) {
  const Am = am();
  const { display } = project(doc);
  let rest = Math.max(0, offset);
  for (const line of display) {
    if (rest <= line.body.length) {
      const at = (line.start < 0 ? 0 : line.start + 1) + rest;
      return { cursor: Am.getCursor(doc, ['text'], at), line: line.id };
    }
    rest -= line.body.length + 1;
  }
  return { cursor: Am.getCursor(doc, ['text'], String(doc.text).length), line: null };
}

export function offsetOf(doc, caret) {
  const Am = am();
  const at = Am.getCursorPosition(doc, ['text'], caret.cursor);
  const { display, text } = project(doc);
  const owner = [...text].reverse().find((line) => (line.start < 0 ? 0 : line.start + 1) <= at) || text[0];
  let base = 0;
  for (const line of display) {
    if (line.id === owner.id) return base + Math.min(owner.body.length, Math.max(0, at - (line.start < 0 ? 0 : line.start + 1)));
    base += line.body.length + 1;
  }
  return base;
}
