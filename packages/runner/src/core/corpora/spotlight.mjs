// The documents corpus: the operating system's own full-text index over every
// PDF, word-processor file and note on the machine.
//
// This is the one corpus whose index this runtime does not own, which decides
// almost everything about how it is written. It cannot be rebuilt, its warmth
// varies by an order of magnitude between calls, and it ANDs the words of a
// query. So it is bounded twice, its tiers race rather than sum, and a cut
// resolves distinctly from an empty answer: a slow index and an absent
// document must never print the same, because the second is an answer and the
// first is a question about the budget.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { presentRoots } from './config.mjs';
import { budgeted, rankLines, spreadPaths, tierQueries, winningTier } from './rank.mjs';

const TEXT_SUFFIXES = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'];
const CONVERTIBLE = ['.doc', '.docx', '.rtf', '.rtfd', '.pages', '.odt', '.webarchive'];

/** Run a command and return stdout, or null when it fails or is cut. The
 * external tools here fail in ordinary ways: a missing binary, a document the
 * converter cannot read, a file that moved since the index saw it. None of
 * those is an error for the lookup; they are each one document less. */
function runCommand(file, args, { timeoutMs = 2000, maxBuffer = 4e6 } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (error, stdout) => {
      resolve(error && !stdout ? null : String(stdout ?? ''));
    });
  });
}

/** The default index reader. One `mdfind` per root, so the caller's roots are
 * honoured rather than trusting a repeated flag. */
async function mdfind(query, roots, { timeoutMs }) {
  const runs = await Promise.all(roots.map(root =>
    runCommand('mdfind', ['-onlyin', root, query], { timeoutMs })));
  const paths = [];
  for (const output of runs) {
    if (output === null) continue;
    for (const line of output.split('\n')) if (line.trim()) paths.push(line.trim());
  }
  return [...new Set(paths)];
}

/** Readable text of one document, by suffix. A converter that is not installed
 * or refuses the file yields null, and the document then contributes its path
 * without a quote rather than disappearing. */
export async function documentText(file, { maxBytes = 4e6 } = {}) {
  const suffix = path.extname(file).toLowerCase();
  if (suffix === '.pdf') return await runCommand('pdftotext', ['-l', '10', '-q', file, '-'], { maxBuffer: maxBytes });
  if (CONVERTIBLE.includes(suffix)) {
    return await runCommand('textutil', ['-convert', 'txt', '-stdout', file], { maxBuffer: maxBytes });
  }
  if (TEXT_SUFFIXES.includes(suffix) || suffix === '') {
    const output = await runCommand('cat', [file], { maxBuffer: maxBytes });
    return output;
  }
  return null;
}

async function quoteDocuments(paths, terms, { maxHits, text }) {
  const quoted = await Promise.all(paths.map(async file => {
    const body = await text(file);
    if (body === null || !body.trim()) {
      // The index says the words are in there and the converter cannot show
      // them. The path is still the answer, so it is returned without a quote
      // and marked, rather than being dropped as though nothing matched.
      return [{ path: file, line: null, quote: '', score: 0.5, matched: [], unquoted: true }];
    }
    const hits = rankLines({ text: body, terms, path: file, max: 2 });
    return hits.length ? hits : [{ path: file, line: null, quote: '', score: 0.5, matched: [], unquoted: true }];
  }));
  return spreadPaths(quoted.flat(), { max: maxHits, perPath: 2 });
}

/** Search the documents corpus. `index` and `text` are injected so this is
 * testable without a real Spotlight index: a spec that needs the machine's own
 * index tests the machine rather than this code. */
export async function searchDocuments({
  corpus,
  terms,
  deadlineMs = corpus.deadlineMs,
  tierDeadlineMs = corpus.tierDeadlineMs ?? Math.max(600, Math.round(deadlineMs * 0.4)),
  platform = process.platform,
  index = mdfind,
  text = documentText,
} = {}) {
  const base = { id: corpus.id, kind: corpus.kind, pooled: corpus.pooled, hits: [], cut: null, absent: false, note: null };
  if (platform !== 'darwin') return { ...base, absent: true, note: 'the documents corpus needs the macOS index' };
  const roots = presentRoots(corpus);
  if (!roots.length) return { ...base, absent: true, note: `no configured root of ${corpus.id} exists on this machine` };
  if (!terms.length) return { ...base, note: 'no query terms' };

  // Four tiers, run concurrently. Concurrently rather than in order because
  // the broad-phrase query costs about as much on its own as all four
  // together: the tiers race, so the specific one costs nothing when the broad
  // one is slow, and the most specific non-empty one wins.
  const tiers = tierQueries({ terms, wholePhrase: terms.length > 1 });
  const answered = await budgeted(Promise.all(tiers.map(query =>
    budgeted(index(query, roots, { timeoutMs: tierDeadlineMs }), tierDeadlineMs))), deadlineMs);

  if (answered === null) {
    return { ...base, cut: deadlineMs, note: `cut at ${deadlineMs}ms before any tier answered; raise ${corpus.id}.deadlineMs` };
  }
  const cutTiers = answered.filter(result => result === null).length;
  if (cutTiers === tiers.length) {
    // Every tier cut is not an empty result. It says nothing about whether the
    // document exists, and the report names the knob rather than leaving the
    // reader to guess which of the two deadlines fired.
    return { ...base, cut: tierDeadlineMs, note: `all ${tiers.length} tiers cut at ${tierDeadlineMs}ms; raise ${corpus.id}.tierDeadlineMs` };
  }
  const winner = winningTier(tiers, answered);
  if (winner.index < 0) {
    const note = cutTiers ? `no document matched; ${cutTiers} of ${tiers.length} tiers were cut at ${tierDeadlineMs}ms` : 'no document matched';
    return { ...base, hits: [], note };
  }
  const hits = await quoteDocuments(winner.results.slice(0, corpus.maxFiles), terms, { maxHits: corpus.maxHits, text });
  const notes = [`matched on ${winner.broad ? 'one term' : 'the phrase'}: ${winner.query}`];
  if (cutTiers) notes.push(`${cutTiers} of ${tiers.length} tiers cut at ${tierDeadlineMs}ms`);
  return { ...base, hits, matchedTier: winner.index, broad: winner.broad, note: notes.join('; ') };
}
