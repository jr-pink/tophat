// Ranking, quoting, tiering and deadlines: the four things every corpus in the
// fanout does the same way, kept here so making rarity mean something better
// does not have to be done once per corpus.

/** A term matcher bounded by word edges, with the term's own punctuation kept
 * inside it. `ask.mjs` and `7d/w` are single terms somebody typed on purpose,
 * so the boundary is a letter/digit lookaround rather than `\b`, which would
 * split on the dot and the slash. */
export function matcher(term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Distinct query terms present in `text`, weighted rarest-first. `terms`
 * arrives rarest-first from the extractor, so position is the weight and there
 * is no second ranking to keep in step with the first. */
export function scoreText(text, terms, matchers) {
  let score = 0;
  const matched = [];
  for (let i = 0; i < terms.length; i++) {
    if (!matchers[i].test(text)) continue;
    score += terms.length - i;
    matched.push(terms[i]);
  }
  return { score, matched };
}

const MAX_QUOTE = 400;
/** A quote is the line as it stands on disk, cut to a readable width with the
 * cut marked. The fanout routes rather than summarizing, so a quote is never
 * rewritten: whoever reads it opens the path beside it. */
export function quote(line) {
  const text = String(line).replace(/\s+/g, ' ').trim();
  return text.length > MAX_QUOTE ? text.slice(0, MAX_QUOTE) + ' ...' : text;
}

/** The best-matching lines of one document, with their exact line numbers.
 *
 * A term in the document's own name is evidence of the same kind as a term in
 * one of its lines, so the path scores into every line rather than breaking a
 * tie after the fact: a document filed under the thing being asked about
 * otherwise loses to a passing mention in a document about something else. */
export function rankLines({ text, terms, path: filePath, max = 3, pathWeight = 1 }) {
  if (!terms.length) return [];
  const matchers = terms.map(matcher);
  const pathScore = scoreText(filePath ?? '', terms, matchers).score * pathWeight;
  const hits = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const { score, matched } = scoreText(lines[i], terms, matchers);
    if (!score) continue;
    hits.push({ path: filePath, line: i + 1, quote: quote(lines[i]), score: score + pathScore, matched });
  }
  // A document whose name matches but whose body does not still answers "which
  // file is this", so it contributes one hit naming itself rather than none.
  if (!hits.length && pathScore > 0) {
    return [{ path: filePath, line: null, quote: '', score: pathScore, matched: scoreText(filePath, terms, matchers).matched }];
  }
  return hits.sort((a, b) => b.score - a.score || a.line - b.line).slice(0, max);
}

/** Order hits across documents, spreading over paths so one long document
 * cannot fill the whole result with its own repetitions. */
export function spreadPaths(hits, { max = 12, perPath = 2 } = {}) {
  const counts = new Map();
  const kept = [];
  for (const hit of hits.slice().sort((a, b) => b.score - a.score || String(a.path).localeCompare(String(b.path)))) {
    const seen = counts.get(hit.path) ?? 0;
    if (seen >= perPath) continue;
    counts.set(hit.path, seen + 1);
    kept.push(hit);
    if (kept.length >= max) break;
  }
  return kept;
}

/** The query tiers a word-ANDing index is given, most specific first.
 *
 * An index that ANDs its words cannot be handed a question asked in English:
 * the filler matches no document, so the whole phrase returns nothing while
 * the query's rarest word returns the right file. There are TWO single-term
 * tiers rather than one, and the second is not redundant. Rarity in the
 * owner's own notes is not rarity in the documents on the machine: a token can
 * be the rarest thing in the notes and appear in no document at all, while its
 * runner-up is in exactly the right one. A table built over markdown
 * structurally cannot know that, and a second concurrent query costs nothing
 * in wall clock because the tiers race rather than sum. */
export function tierQueries({ terms, wholePhrase = false }) {
  const useful = terms.filter(term => term.length >= 3);
  const bySpecificity = useful.length ? useful : terms;
  const tiers = [
    wholePhrase ? terms.join(' ') : '',
    bySpecificity.slice(0, 3).join(' '),
    bySpecificity[0] || '',
    bySpecificity[1] || '',
  ];
  return [...new Set(tiers)].filter(Boolean);
}

/** The most specific non-empty tier wins. `broad` says the winner was a single
 * word, whichever of the two single-term tiers answered; testing "the last tier
 * answered" names the wrong tier as soon as there are two of them.
 */
export function winningTier(tiers, answered) {
  const index = answered.findIndex(result => result && result.length);
  if (index < 0) return { index: -1, broad: false, results: [], query: null };
  return { index, broad: tiers.length > 1 && !tiers[index].includes(' '), results: answered[index], query: tiers[index] };
}

/** Race a promise against a deadline, resolving `null` on a cut.
 *
 * `null` rather than an empty array, because a cut and a genuine absence are
 * different statements and resolving both as empty is what makes a slow index
 * read as a document that does not exist. The timer is unrefed: an un-unrefed
 * one keeps the event loop alive after the work has finished, which puts the
 * deadline under every call as a floor instead of a ceiling. */
export function budgeted(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([promise, new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  })]);
}

/** Run a corpus under its own deadline. On a cut the corpus reports whatever it
 * pushed into `partial` plus the deadline that fired, so a bounded corpus says
 * when it was cut rather than answering as though it had finished.
 *
 * **A race resolves the caller; it does not stop the work.** Until the second
 * argument existed, a cut corpus went on walking and reading its whole tree
 * after the answer had been returned, pushing into an array nobody would read
 * again. One request hid that, since the process had nothing else to do with
 * the time. So `run` receives a `deadline` whose `cancelled` flag it is
 * expected to check on every iteration, and the loop that does not check it is
 * the loop that keeps the defect.
 */
export async function withDeadline(ms, run) {
  const partial = [];
  const deadline = { cancelled: false, ms };
  let finished = false;
  let timer;
  const result = await Promise.race([
    run(partial, deadline).then(value => { finished = true; return value; }),
    new Promise(resolve => { timer = setTimeout(() => { deadline.cancelled = true; resolve(null); }, ms); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (finished) return { ...result, cut: null };
  // The flag is set for the abandoned run whether the timer fired or the race
  // was lost some other way, so nothing keeps reading on behalf of an answer
  // that has already been given.
  deadline.cancelled = true;
  return { hits: partial, cut: ms };
}
