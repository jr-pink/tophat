// One tokenizer, one document-frequency table, one rare-word picker. Why: four
// extractors disagreed on stop words and thresholds, so push, pull and the
// fanout searched different words for the same sentence. Selection is by
// inverse document frequency over the knowledge tree; the stop list only
// catches what a df table cannot (pronouns, filler).
// tokenize/extractTerms/phrasesOf are byte-compatible ports of
// src/retrieval/terms.mjs (fuzzed in terms.test.mjs).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);

/** ripgrep by absolute path: launchd's PATH has no /opt/homebrew/bin. */
export function resolveRg(env = process.env, exists = existsSync) {
  if (env.TOPHAT_RIPGREP && exists(env.TOPHAT_RIPGREP)) return env.TOPHAT_RIPGREP;
  const h = homedir();
  return ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', '/opt/local/bin/rg', join(h, '.cargo/bin/rg'), join(h, '.local/bin/rg')]
    .find((c) => exists(c)) || 'rg';
}

export const STOP = new Set(`a an the this that these those there here it its i me my mine myself we us our ours you your yours
he him his she her hers they them their theirs who whom whose be am is are was were been being do does did done doing
have has had having will shall would should can could may might must ought and or but nor if then else than so because as
of to in on at by for with from into onto over under about after before between during without within across through above
below up down out off again once per via upon against what when where which why how whether not no only just very too much
many more most less least some any all both each every few other another same such own lot lots bit enough quite rather even
still yet already now today tonight soon later ago ever never always sometimes thing things stuff shit crap sort kind way ways
one ones line lines part parts time times point points case cases like really actually basically probably maybe perhaps
definitely obviously literally also pretty kinda sorta prolly probs please pls plz thanks thank thx sure ok okay yes yeah yep
nah nope hi hey hello lol lmao lmfao haha u ur urs im ive id ill youre theyre weve theyve youve dont doesnt didnt cant cannot
couldnt wouldnt shouldnt wasnt werent isnt arent havent hasnt hadnt wont aint thats whats hows heres theres lets itd itll
gonna wanna gotta smt smth sth wdym idk imo iirc tbh btw fyi rn bc tho yk ya ye smh ngl afaik ikr omg wtf eg ie etc vs aka
http https www com org net io html htm php aspx utm amp gt lt quot nbsp think thought thinking know knows knew guess wonder
mean means meant remember forget want wanted wants`.split(/\s+/));

// Casual spellings mapped to the document's word, for the df lookup only.
export const INFORMAL = new Map([['thru', 'through'], ['abt', 'about'], ['cuz', 'because'], ['bcuz', 'because'], ['b4', 'before'],
  ['alr', 'already'], ['rly', 'really'], ['rlly', 'really'], ['alot', 'lot'], ['ppl', 'people'], ['yday', 'yesterday'],
  ['tmrw', 'tomorrow'], ['tmr', 'tomorrow'], ['till', 'until']]);

const APOS_S = /([\p{L}\p{N}])[‘’ʼ']s(?![\p{L}\p{N}])/gu;
const APOS = /[‘’ʼ']/g;

export function normalizeTerm(raw) {
  return String(raw ?? '').toLowerCase().replace(APOS_S, '$1').replace(APOS, '')
    .replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

export function isCandidate(t) {
  if (!t || STOP.has(t) || STOP.has(INFORMAL.get(t))) return false;
  if (/^\d+(?:\.\d+)+$/u.test(t)) return true;
  if (/^\p{N}+$/u.test(t)) return t.length >= 3;
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(t)) return true;
  return /\p{L}/u.test(t) && t.length >= 2;
}

/** Candidate terms in typed order; backticked ones are tagged `quoted`; fenced code is dropped. */
export function tokenize(text) {
  let s = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ');
  const quoted = new Set();
  for (const m of s.matchAll(/`([^`\n]{1,80})`/g)) {
    for (const w of m[1].split(/[^\p{L}\p{N}._&/@+#-]+/u)) { const t = normalizeTerm(w); if (isCandidate(t)) quoted.add(t); }
  }
  s = s.replace(/`/g, ' ').replace(APOS_S, '$1').replace(APOS, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => ' ' + u.replace(/[:/?#=&]+/g, ' ') + ' ');
  const seen = new Map();
  const add = (t, q) => { if (isCandidate(t) && !seen.has(t)) seen.set(t, { term: t, quoted: q }); };
  for (const w of s.split(/[\s,;:!?()[\]{}"'<>|\\]+/u)) {
    const t = normalizeTerm(w);
    if (!isCandidate(t)) continue;
    add(t, quoted.has(t));
    if (/^[\p{L}\p{N}][\p{L}\p{N}-]*(\.[\p{L}\p{N}-]+)+$/u.test(t)) add(t.split('.')[0], quoted.has(t));
  }
  return [...seen.values()];
}

// ---- document frequency over knowledge/*.md + AGENTS.md ---------------------
// The owner's quoted words (stream.md, day/week indexes, reflections) are left
// out, so a misspelling stays rare for the right reason.
const DF_VERSION = 2;
export const DF_MIN_DOCS = 50;
export const dfPath = (indexDir) => join(indexDir, 'term-df.json');
const QUOTES = /^knowledge\/memory\/(stream\.md$|indexes\/(days|weeks)\/|reflections\/)/;

// The parsed table, kept while the file's mtime and size hold: the search worker lives across queries (prefetch.mjs),
// and parsing 2.5 MB of JSON was 70 ms of every query.
let dfCache = null;
export function loadDf(indexDir, { maxAgeMs = 7 * 864e5, now = Date.now() } = {}) {
  try {
    const file = dfPath(indexDir), st = statSync(file), key = `${file}|${st.mtimeMs}|${st.size}`;
    if (dfCache?.key !== key) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      dfCache = { key, table: j.version !== DF_VERSION || !j.df || !j.docs || j.docs < DF_MIN_DOCS ? null : { df: new Map(Object.entries(j.df)), docs: j.docs, builtAt: j.builtAt } };
    }
    const t = dfCache.table;
    return t ? { ...t, stale: now - Date.parse(t.builtAt || 0) > maxAgeMs } : null;
  } catch { return null; }
}

async function walkMd(repo, rel, out) {
  let entries = [];
  try { entries = await readdir(join(repo, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory() && !e.name.startsWith('.')) await walkMd(repo, p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
}

/** Walk the tree, count per-file term presence, write atomically; refuses a table under DF_MIN_DOCS. */
export async function buildDf(repo, { indexDir, write = true, env = process.env } = {}) {
  let files = [];
  try { files = (await run(resolveRg(env), ['--files', '-t', 'md', 'knowledge'], { cwd: repo, maxBuffer: 64 << 20, timeout: 20000 })).stdout.split('\n').filter(Boolean); } catch {}
  if (!files.length) await walkMd(repo, 'knowledge', files);
  files = [...files, 'AGENTS.md'].filter((f) => !QUOTES.test(f));
  const df = new Map(); let docs = 0;
  for (let i = 0; i < files.length; i += 64) {
    for (const text of await Promise.all(files.slice(i, i + 64).map((f) => readFile(join(repo, f), 'utf8').catch(() => null)))) {
      if (text == null) continue;
      docs++;
      const local = new Set();
      for (const w of text.split(/[^\p{L}\p{N}._&/@+#-]+/u)) { const t = normalizeTerm(w); if (t && t.length <= 40) local.add(t); }
      for (const t of local) df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const out = { version: DF_VERSION, builtAt: new Date().toISOString(), docs, df: Object.fromEntries(df) };
  if (write) {
    if (docs < DF_MIN_DOCS) throw new Error(`term-df: refusing to write ${docs} docs from ${repo}/knowledge`);
    mkdirSync(indexDir, { recursive: true });
    const p = dfPath(indexDir), tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out)); renameSync(tmp, p);
  }
  return { df, docs, builtAt: out.builtAt };
}

/**
 * Terms rarest first. An unseen term scores just under the median of the known
 * ones (subject or typo, the table cannot say); backticked terms are promoted.
 * Ties break on length then lexical order, so the order is total.
 */
export function extractTerms(text, { max = 6, df = null, docs = 0, indexDir = null } = {}) {
  let table = df, source = df ? 'df' : 'heuristic', stale = false;
  if (!table && indexDir) { const l = loadDf(indexDir); if (l) { table = l.df; docs = l.docs; stale = l.stale; source = 'df'; } }
  const cands = tokenize(text);
  const N = docs || 1;
  if (!table) {
    const order = cands.map((c) => ({ ...c, tier: c.quoted ? 0 : 1, idf: c.term.length, df: null }))
      .sort((a, b) => a.tier - b.tier || b.idf - a.idf || a.term.localeCompare(b.term));
    return { terms: order.slice(0, max).map((t) => t.term), ranked: order, source, stale, docs: N };
  }
  const idfOf = (d) => Math.log(N / (1 + d));
  const dfOf = (t) => table.get(INFORMAL.get(t) ?? t) ?? table.get(t) ?? 0;
  const known = cands.map((c) => dfOf(c.term)).filter((d) => d >= 2);
  const med = known.length ? idfOf(known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)]) : Infinity;
  const order = cands.map((c) => {
    const d = dfOf(c.term), own = idfOf(d);
    if (c.quoted) return { ...c, tier: 0, idf: own + 2, df: d };
    if (d <= 1) return { ...c, tier: 1, idf: Math.min(own, med - 1e-6), df: d };
    return { ...c, tier: 0, idf: own, df: d };
  }).sort((a, b) => b.idf - a.idf || b.term.length - a.term.length || a.term.localeCompare(b.term));
  return { terms: order.slice(0, max).map((t) => t.term), ranked: order, source, stale, docs: N };
}

/** Adjacent candidate pairs in typed order; a stop word or sentence punctuation breaks a run. */
export function phrasesOf(text) {
  const s = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`/g, ' ').replace(APOS_S, '$1').replace(APOS, '');
  const out = [], seen = new Set();
  for (const clause of s.split(/[,;:!?()[\]{}"'<>|\\\n]+|\.(?=\s|$)/u)) {
    let prev = null;
    for (const w of clause.split(/\s+/u)) {
      const t = normalizeTerm(w);
      if (!t || !isCandidate(t)) { prev = null; continue; }
      if (prev && prev !== t && !seen.has(`${prev} ${t}`)) { seen.add(`${prev} ${t}`); out.push([prev, t]); }
      prev = t;
    }
  }
  return out;
}

// A person named by kind: the word is dropped from the lexical terms and raised
// as a flag the `who` corpus answers.
export const PERSON_WORDS = new Set(['girl', 'girls', 'guy', 'guys', 'lady', 'ladies', 'dude', 'dudes', 'man', 'men', 'woman', 'women',
  'person', 'people', 'gal', 'kid', 'boy', 'bro']);
export function personReference(text) {
  const words = tokenize(text).map((c) => c.term);
  return { hint: words.filter((w) => PERSON_WORDS.has(w)), rest: words.filter((w) => !PERSON_WORDS.has(w)) };
}

// ---- rare(): the naming words of a message, for the pull prefetch's second pass
// Port of rev5/pull.mjs rareTerms + termQuery. Words that describe the asking
// (set up, adjust, roughly, seasons) are as contentless as pronouns here.
export const ORDINARY = new Set(`a about above after again against all also am an and any are as ask at back be because been before
being below between both but by came can cant come could did didnt do does doesnt doing done dont down during each else even
ever every few find first for from further get give go going good got had has have having he her here hers herself him himself
his how i if in into is it its itself just keep know let like look made make many may me might more most much must my myself
need never new no nor not now of off on once one only or other others ought our ours ourselves out over own please put really
right said same say see seem she should since so some still such take than that the their theirs them themselves then there
these they thing things think this those though through to too try under until up upon us use used using very want was way we
well were what when where whether which while who whom why will with within without would yes yet you your yours yourself
able actually always another anyone anything around better both came cannot enough everything far help here however instead
maybe next nothing okay old part perhaps probably quite rather something sometimes soon sure thanks thats theres together
tomorrow tonight whatever whenever wherever whoever set setting sets setup automation automate automatic schedule scheduled
adjust adjusting change changing follow following making build building fix fixing add adding run running send sending check
checking work working stuff day days week weeks month months year years today yesterday hour hours minute minutes time times
morning evening night lets bc rn lol pls plz thx tysm idk imo btw roughly rough sorta kinda basically generally ish past dim
dimmer bright brighter warm warmer cool cooler season seasons location based except bad best`.split(/\s+/).filter(Boolean));

/** Up to `limit` naming words (model numbers and hyphenated names first, then longest;
 * equal shapes keep typed order) and `query`: each word plus its five-character
 * prefix when the word is 7+ long, so the asker's spelling reaches the corpus
 * spelling.
 */
export function rare(text, { limit = 5 } = {}) {
  const seen = new Set(), out = [];
  for (const raw of String(text ?? '').split(/[^A-Za-z0-9-]+/)) {
    const token = raw.replace(/^-+|-+$/g, '');
    if (token.length < 4 || token.length > 40) continue;
    const lower = token.toLowerCase();
    if (seen.has(lower) || ORDINARY.has(lower) || /^\d+$/.test(lower)) continue;
    seen.add(lower); out.push(lower);
  }
  out.sort((a, b) => (Number(/[0-9-]/.test(b)) - Number(/[0-9-]/.test(a))) || (b.length - a.length));
  const terms = out.slice(0, limit);
  return { terms, query: [...new Set(terms.flatMap((t) => (t.length >= 7 ? [t, t.slice(0, 5)] : [t])))].join(' ') };
}
