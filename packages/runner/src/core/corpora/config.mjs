// Which directories the fanout searches is owner configuration, never a path
// in this repository. The corpora live in their own owner-only file beside
// config.json, read here and validated here, because a root naming a person, a
// project or a machine is exactly what this repository must not carry.
//
// Unknown keys are refused rather than ignored, for the reason the nightly
// evaluation block is: a runner that reads `enabled` and skips everything else
// makes a misspelled key and a deliberately disabled corpus the same
// observation, for ever.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CORPUS_KINDS = ['markdown', 'documents', 'code'];
const CORPUS_KEYS = ['id', 'kind', 'roots', 'extensions', 'exclude', 'enabled', 'pooled', 'deadlineMs',
  'tierDeadlineMs', 'maxFiles', 'maxBytes', 'maxHits'];
const TOP_KEYS = ['budgetMs', 'termFrequencyFile', 'documentIndexFile', 'corpora'];

// Per kind, because the three read different things at different costs. The
// documents corpus is the one whose backing index this runtime does not own,
// so it gets the largest budget and the only per-tier one.
const DEFAULTS = {
  markdown: { deadlineMs: 1500, maxFiles: 20000, maxBytes: 2e6, maxHits: 12, pooled: false, extensions: ['.md', '.markdown', '.txt'] },
  documents: { deadlineMs: 2500, tierDeadlineMs: 1000, maxFiles: 400, maxBytes: 4e6, maxHits: 10, pooled: false, extensions: [] },
  // Pooled by default. A corpus that answers nothing for most questions and
  // prints a block on every one is pure cost: measured on the previous runtime,
  // printing the code corpus left every retrieval-quality figure identical and
  // added kilobytes to every lookup. It competes in the pooled best block, so
  // a question it can answer still gets answered, and a question it cannot
  // costs nothing.
  code: { deadlineMs: 1200, maxFiles: 4000, maxBytes: 5e5, maxHits: 8, pooled: true, extensions: ['.mjs', '.js', '.ts', '.py', '.sh', '.json'] },
};

export const DEFAULT_BUDGET_MS = 3000;

function refuse(message) {
  const error = new Error(message);
  error.corporaConfig = true;
  throw error;
}

function checkKeys(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) refuse(`Unknown ${where} key: ${key}`);
}

function positiveInteger(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) refuse(`${name} must be a positive integer`);
  return value;
}

function validateCorpus(raw, ids) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('Each corpus must be an object');
  checkKeys(raw, CORPUS_KEYS, 'corpus');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw.id || '') || ids.has(raw.id)) refuse('Corpus IDs must be unique safe identifiers');
  ids.add(raw.id);
  if (!CORPUS_KINDS.includes(raw.kind)) refuse(`Corpus kind must be one of ${CORPUS_KINDS.join(', ')}`);
  const defaults = DEFAULTS[raw.kind];
  if (!Array.isArray(raw.roots) || !raw.roots.length) refuse(`Corpus ${raw.id} needs at least one root`);
  // A root may be written `~/...` so the file survives a change of home directory.
  const home = process.env.HOME || os.homedir();
  const roots = raw.roots.map((root) => (root === '~' ? home : typeof root === 'string' && root.startsWith('~/') ? path.join(home, root.slice(2)) : root));
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) refuse(`Corpus ${raw.id} roots must be absolute paths (or start with ~/)`);
  }
  for (const key of ['enabled', 'pooled']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') refuse(`Corpus ${raw.id} ${key} must be true or false`);
  }
  if (raw.extensions !== undefined) {
    const bad = !Array.isArray(raw.extensions) || raw.extensions.some(value => typeof value !== 'string' || !value.startsWith('.'));
    if (bad) refuse(`Corpus ${raw.id} extensions must be dotted suffixes`);
  }
  if (raw.tierDeadlineMs !== undefined && raw.kind !== 'documents') refuse(`Corpus ${raw.id} has no tiers to bound`);
  // Patterns, because the binding constraint on a real knowledge tree is what
  // the walk spends its deadline on rather than how long the deadline is.
  // Narrowing the root fixes one tree; an exclusion fixes the general case, and
  // is what the previous runtime eventually wrote as an `.rgignore`.
  //
  // Refused by name if it does not compile, for the same reason the rest of
  // this file refuses: a pattern silently dropped searches a different corpus
  // than the one configured and nothing says so.
  const exclude = [];
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude)) refuse(`Corpus ${raw.id} exclude must be an array of patterns`);
    for (const pattern of raw.exclude) {
      if (typeof pattern !== 'string' || !pattern) refuse(`Corpus ${raw.id} exclude patterns must be non-empty strings`);
      try { exclude.push(new RegExp(pattern)); }
      catch { refuse(`Corpus ${raw.id} exclude pattern ${JSON.stringify(pattern)} is not a regular expression`); }
    }
  }
  return {
    id: raw.id,
    kind: raw.kind,
    roots,
    extensions: raw.extensions ? raw.extensions.slice() : defaults.extensions.slice(),
    exclude,
    excludeSource: raw.exclude ? raw.exclude.slice() : [],
    enabled: raw.enabled !== false,
    pooled: raw.pooled ?? defaults.pooled,
    deadlineMs: positiveInteger(raw.deadlineMs, `Corpus ${raw.id} deadlineMs`) ?? defaults.deadlineMs,
    tierDeadlineMs: positiveInteger(raw.tierDeadlineMs, `Corpus ${raw.id} tierDeadlineMs`) ?? defaults.tierDeadlineMs ?? null,
    maxFiles: positiveInteger(raw.maxFiles, `Corpus ${raw.id} maxFiles`) ?? defaults.maxFiles,
    maxBytes: positiveInteger(raw.maxBytes, `Corpus ${raw.id} maxBytes`) ?? defaults.maxBytes,
    maxHits: positiveInteger(raw.maxHits, `Corpus ${raw.id} maxHits`) ?? defaults.maxHits,
  };
}

/** Where the corpora file lives. Beside config.json by default, overridable so
 * a test can point at a temporary home without touching the owner's. */
export function corporaConfigFile(config, explicit) {
  if (explicit) return explicit;
  if (process.env.TOPHAT_RETRIEVAL_CONFIG) return process.env.TOPHAT_RETRIEVAL_CONFIG;
  // Direct callers (including the webchat hook) do not pass through the CLI
  // wrapper. Keep the context schema separate from the raw-source fanout's
  // retrieval.json, while accepting older installations with a single file.
  const context = path.join(config.paths.configDir, 'context-retrieval.json');
  try { fs.lstatSync(context); return context; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path.join(config.paths.configDir, 'retrieval.json');
}

/** Resolve the configured corpora. An absent file is an absent configuration
 * and not an error: a runtime with nothing configured still answers from the
 * event plane, and says in its report that no filesystem corpus was
 * configured. A malformed file is the owner's mistake and is refused by name,
 * since silently searching nothing looks exactly like finding nothing. */
export function resolveCorpora(config, { file } = {}) {
  const target = corporaConfigFile(config, file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { file: target, configured: false, budgetMs: DEFAULT_BUDGET_MS, termFrequencyFile: null, documentIndexFile: null, corpora: [] };
    refuse(`Corpora configuration at ${path.basename(target)} is not readable JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('Corpora configuration must be an object');
  checkKeys(raw, TOP_KEYS, 'retrieval');
  if (raw.corpora !== undefined && !Array.isArray(raw.corpora)) refuse('retrieval.corpora must be an array');
  for (const key of ['termFrequencyFile', 'documentIndexFile']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key])) refuse(`retrieval.${key} must be an absolute path`);
  }
  const ids = new Set();
  return {
    file: target,
    configured: true,
    budgetMs: positiveInteger(raw.budgetMs, 'retrieval.budgetMs') ?? DEFAULT_BUDGET_MS,
    termFrequencyFile: raw.termFrequencyFile ?? null,
    // The documents plane's index, which this runtime reads and does not own.
    // Absent means the plane is off rather than that it failed, the same way an
    // absent corpora file means no filesystem corpus rather than an error.
    documentIndexFile: raw.documentIndexFile ?? null,
    corpora: (raw.corpora ?? []).map(entry => validateCorpus(entry, ids)),
  };
}

/** The roots of a corpus that exist right now. A configured root that is not
 * there is absent rather than an error: an owner who has not mounted a volume,
 * or who configured a corpus on another machine, gets a lookup that answers
 * from everything else and says which corpus had no root. */
export function presentRoots(corpus) {
  return corpus.roots.filter(root => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}
