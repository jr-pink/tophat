// rev6 retrieval config: the one schema is retrieval.json as rev6/base/config.mjs
// validates it; this adds only what the index needs on top. Why: the four old
// readers each resolved the same file differently. The index directory is
// overridable (opts.indexDir or TOPHAT_REV6_INDEX_DIR) so a rev6 index can be
// built beside the live one, and every index-derived path follows it.
import path from 'node:path';
import { loadRetrievalConfig, resolveRetrievalConfig } from '../base/config.mjs';
import { retrievalConfigFile } from '../base/paths.mjs';
import { registryWith } from '../base/privacy.mjs';

// Corpus keys `--only` accepts, in tophat-ask's order; a typo is a usage error.
export const CORPORA = ['know', 'code', 'stream', 'chat', 'msg', 'mail', 'agent', 'file', 'journal', 'headspaces', 'web', 'who', 'name'];
// Planes group corpora for callers that think in kinds (push), not keys.
export const PLANES = {
  notes: ['know', 'stream', 'journal', 'headspaces'], messages: ['msg', 'who'], mail: ['mail', 'who'],
  agents: ['agent', 'chat'], files: ['file', 'name'], code: ['code'], web: ['web'], people: ['who'],
};
export const STEPS = ['streams', 'imessage', 'beeper', 'chats', 'journal', 'headspaces', 'terms', 'docs', 'files', 'people'];
export const REFRESH_HINT = 'run node rev6/retrieval/build.mjs';

/** Expand planes and keys into a corpus-key set; unknown names are returned, not dropped. */
export function selectCorpora(only = [], planes = []) {
  const keys = new Set(); const unknown = [];
  for (const k of only) (CORPORA.includes(k) ? keys.add(k) : unknown.push(k));
  for (const p of planes) (PLANES[p] ? PLANES[p].forEach((k) => keys.add(k)) : CORPORA.includes(p) ? keys.add(p) : unknown.push(p));
  return { keys, unknown };
}

/** Re-point every index-derived path at `indexDir`, keeping explicit env overrides. */
export function withIndexDir(cfg, indexDir, env = process.env) {
  if (!indexDir) return cfg;
  const dir = path.resolve(indexDir);
  const under = (envKey, name) => (env[envKey] ? path.resolve(env[envKey]) : path.join(dir, name));
  return { ...cfg, indexDir: dir, streamsDir: under('STREAM_INDEX_DIR', 'streams'), chatsIndex: under('CHATS_INDEX', 'chats.tsv'),
    journalIndex: under('TOPHAT_JOURNAL_INDEX', 'journal.tsv'), docsIndex: under('DOCS_INDEX', 'docs.tsv'),
    headspacesIndex: under('TOPHAT_HEADSPACES_INDEX', 'headspaces.tsv') };
}

/**
 * The resolved config plus `registry` (private roster + config people), or null when the file is absent.
 * `raw` skips the file (tests); `indexDir` overrides, else TOPHAT_REV6_INDEX_DIR.
 */
export function loadConfig({ env = process.env, file, raw, indexDir } = {}) {
  const cfg = raw ? resolveRetrievalConfig(raw, { env, file: file || null })
    : loadRetrievalConfig(env, file ? { file } : undefined);
  if (!cfg) return null;
  const out = withIndexDir(cfg, indexDir || env.TOPHAT_REV6_INDEX_DIR, env);
  return { ...out, registry: registryWith(cfg.privatePeople) };
}

export const configPath = (env = process.env) => (env.TOPHAT_RETRIEVAL_CONFIG ? path.resolve(env.TOPHAT_RETRIEVAL_CONFIG) : retrievalConfigFile(env));
