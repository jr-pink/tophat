// Ripgrep with ASCII word boundaries plus an exact Unicode re-check, for the fastsearch harness piece (ASK_RG_ASCII_WB=1).
//
// Why: the query regex is an alternation of up to 24 terms, the short ones wrapped in `\b`, run with -i. ripgrep's fast
// engines cannot evaluate a Unicode `\b` once a haystack holds non-ASCII bytes, so it falls back to its slow engine: 9.9 s
// for one sentence query over the 61 MB iMessage index (165 matching lines), against 105 ms with `(?-u:\b)`. That was the
// 15 to 20 s tail of source search.
//
// Same output: `bounded()` only puts `\b` around pure ASCII alphanumeric terms, so every boundary sits beside an ASCII
// word character; a Unicode non-word character is always an ASCII non-word character, so the ASCII-boundary match set
// is a superset of the Unicode one. Each line it returns is re-tested in JS against the original pattern with Rust's
// Unicode `\w` (Alphabetic, M, Nd, Pc, Join_Control) and dropped when it fails, which leaves exactly the original lines.
// A pure-ASCII line skips the re-check: on ASCII text Unicode `\w` is exactly [A-Za-z0-9_], so the two patterns agree.
// A `-m N` cap counts superset lines, so a file that reaches the cap is searched again with the original pattern.
// Anything this cannot prove identical (other flags, other `\b` shapes, a binary-file notice) returns null and the
// caller runs the original command.

const W = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';
// `\bop\b` around a term that starts and ends with a word character is "op, not preceded or followed by a word
// character"; written literal first (the lookbehind re-reads the term) so V8 checks boundaries only where the term hits.
const unicodeBounded = (pattern) => pattern.replace(/\\b([A-Za-z0-9]{1,4})\\b/g, (_, t) => `${t}(?<!${W}${t})(?!${W})`);
const ASCII = /^[\x00-\x7f]*$/;
const UNSUPPORTED = new Set(['-o', '--only-matching', '-c', '--count', '--count-matches', '-l', '--files-with-matches', '--files-without-match',
  '-F', '--fixed-strings', '-v', '--invert-match', '--json', '-P', '--pcre2', '-w', '--word-regexp', '-x', '--line-regexp', '--passthru',
  '-A', '-B', '-C', '--context', '--after-context', '--before-context', '-U', '--multiline', '--vimgrep', '-0', '--null', '-e', '--regexp', '-f', '--file', '--', '-s', '--case-sensitive', '-S', '--smart-case']);

/** The rewrite for one argument list, or null when the fast path does not apply. Exported for tests. */
export function planFastRg(args) {
  if (args.some((a) => UNSUPPORTED.has(a) || /^-[ABCm]\d/.test(a) || /^--max-count=/.test(a))) return null;
  const at = args.map((a, i) => (a.includes('\\b') ? i : -1)).filter((i) => i >= 0);
  if (at.length !== 1) return null;
  const pattern = args[at[0]];
  if (pattern.includes('\\\\') || pattern.replace(/\\b[A-Za-z0-9]{1,4}\\b/g, '').includes('\\b')) return null;
  let re;
  try { re = new RegExp(unicodeBounded(pattern), args.includes('-i') || args.includes('--ignore-case') ? 'iu' : 'u'); } catch { return null; }
  const mi = args.indexOf('-m') >= 0 ? args.indexOf('-m') : args.indexOf('--max-count');
  const cap = mi >= 0 ? Number(args[mi + 1]) : null;
  if (mi >= 0 && !(cap > 0)) return null;
  const numbered = args.includes('-n') || args.includes('--line-number');
  const fast = ['--null', ...args.map((a, i) => (i === at[0] ? a.replaceAll('\\b', '(?-u:\\b)') : a))];
  return { re, cap, numbered, fast, patternAt: at[0] };
}

/**
 * Filter fast output back to the original's lines. With a `-m N` cap, keeps each file's first N surviving lines
 * (rg prints a file's lines together and in order, so these are the original's first N) and reports `short` when a
 * file reached `ranCap` raw lines yet kept fewer than N, i.e. the original may have more further down. Null when a
 * line cannot be parsed.
 */
export function filterFastOutput(out, plan, ranCap = plan.cap) {
  const kept = new Map(), raw = new Map();
  for (const line of String(out).split('\n')) {
    if (!line) continue;
    if (line.includes('binary file matches (found')) return null;
    const nul = line.indexOf('\0'), file = nul >= 0 ? line.slice(0, nul) : '', rest = nul >= 0 ? line.slice(nul + 1) : line;
    let content = rest;
    if (plan.numbered) { const m = /^\d+:/.exec(rest); if (!m) return null; content = rest.slice(m[0].length); }
    raw.set(file, (raw.get(file) || 0) + 1);
    if (!kept.has(file)) kept.set(file, []);
    const list = kept.get(file);
    if ((!plan.cap || list.length < plan.cap) && (ASCII.test(content) || plan.re.test(content))) list.push(nul >= 0 ? `${file}:${rest}` : rest);
  }
  const short = Boolean(plan.cap && ranCap && [...raw].some(([f, n]) => n >= ranCap && kept.get(f).length < plan.cap));
  const lines = [...kept.values()].flat();
  return { text: lines.length ? `${lines.join('\n')}\n` : '', short };
}

/**
 * Run `cmd args` through the fast path with `run(cmd, args)` (resolves stdout; rejects as the caller's runner does,
 * code 1 meaning no match). Resolves the original-equivalent stdout, or null to tell the caller to run the original.
 * A capped search whose superset filled the cap before the original would have is rerun with the cap widened 8x,
 * then uncapped.
 */
export async function fastRg(run, cmd, args) {
  const plan = planFastRg(args);
  if (!plan) return null;
  const mi = plan.fast.indexOf('-m') >= 0 ? plan.fast.indexOf('-m') : plan.fast.indexOf('--max-count');
  for (const ranCap of plan.cap ? [plan.cap, plan.cap * 8, 0] : [0]) {
    const fastArgs = !plan.cap ? plan.fast : ranCap ? plan.fast.map((a, i) => (i === mi + 1 ? String(ranCap) : a)) : plan.fast.filter((_, i) => i !== mi && i !== mi + 1);
    let out;
    try { out = await run(cmd, fastArgs); } catch (e) {
      if (e && e.code === 1 && !e.killed && !e.signal) return '';
      throw e;
    }
    const r = filterFastOutput(out, plan, ranCap);
    if (!r) return null;
    if (!r.short) return r.text;
  }
  return null;
}
