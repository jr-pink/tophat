// The one list of the owner's Gmail accounts.
//
// It is config.json `sources`, the entries of kind "gmail". Each carries, beside
// the plane-A grant (`config.credentialFile`, `clientFile`, `scopes`):
//   config.email     the address
//   config.humanConsent  the owner signs in and consents himself; no agent drives it
//
// Everything below derives from the entries; nothing keeps a copy.
//
// WHERE config.json IS HAS ONE ANSWER, and this file spells the same one
// rev6/base/paths.mjs does: TOPHAT_CONFIG, else <TOPHAT_CONFIG_DIR, else
// ~/.config/tophat>/config.json.
//
// It is spelled rather than imported because of the layering: rev6 may import
// src (text.mjs, secrets.mjs, the runner's redactor all do), and src may not
// import rev6, since rev5 is the documented rollback and must not depend on its
// successor. tests/gmail-config-dir.test.mjs holds the two spellings to one
// answer, and names the single remaining difference (a relative TOPHAT_CONFIG is
// made absolute here).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The token a retrieval.json stream list uses for "every Gmail stream in config.json". */
export const GMAIL_STREAMS_TOKEN = '@gmail';

/** The config directory: TOPHAT_CONFIG_DIR, else ~/.config/tophat. rev6/base/paths.mjs configDir. */
const configDirOf = (env) => env.TOPHAT_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.config', 'tophat');

/** config.json, as the runtime names it (TOPHAT_CONFIG), else <config dir>/config.json. */
export function tophatConfigFile(env = process.env) {
  return env.TOPHAT_CONFIG ? path.resolve(env.TOPHAT_CONFIG) : path.join(configDirOf(env), 'config.json');
}

function bad(id, message) { throw new Error(`config.json sources["${id}"] (gmail): ${message}`); }

/**
 * The Gmail accounts in a parsed config's `sources`, in file order:
 * {id, enabled, email, dir, stream, humanConsent, credentialFile, clientFile}.
 * A field that is present but malformed throws by name; `dir` and `stream`
 * may be absent (an install whose only grant is plane A's), and are then null.
 */
export function gmailAccounts(sources = []) {
  const out = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || s.kind !== 'gmail') continue;
    const c = s.config || {};
    if (c.email !== undefined && (typeof c.email !== 'string' || !c.email.includes('@'))) bad(s.id, 'config.email must be an address');
    if (c.mailDir !== undefined && (typeof c.mailDir !== 'string' || !path.isAbsolute(c.mailDir))) bad(s.id, 'config.mailDir must be an absolute path');
    if (c.stream !== undefined && (typeof c.stream !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.stream))) bad(s.id, 'config.stream must be a lowercase slug');
    out.push({ id: s.id, enabled: s.enabled === true, email: c.email || null, dir: c.mailDir || null, stream: c.stream || null,
      humanConsent: c.humanConsent === true, credentialFile: c.credentialFile || null, clientFile: c.clientFile || null });
  }
  return out;
}

/** The accounts from config.json on disk; [] when the file does not exist. Unreadable or invalid throws. */
export function readGmailAccounts({ file = tophatConfigFile() } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return gmailAccounts(JSON.parse(text).sources);
}

/** The runner's mail-tool map (TOPHAT_RUNNER_MAIL_ACCOUNTS): enabled accounts with a mailDir, {id: {dir, email, source: id}}. */
export function mailAccountsMap(sources = []) {
  return Object.fromEntries(gmailAccounts(sources).filter((a) => a.enabled && a.dir)
    .map((a) => [a.id, { dir: a.dir, email: a.email, source: a.id }]));
}

/** The enabled accounts' stream names, in file order. */
export function gmailStreamNames(accounts) {
  return accounts.filter((a) => a.enabled && a.stream).map((a) => a.stream);
}

/** A stream list with `@gmail` replaced by the Gmail streams, order kept, duplicates dropped. */
export function expandGmailToken(names, streams) {
  if (!Array.isArray(names) || !names.includes(GMAIL_STREAMS_TOKEN)) return names;
  return [...new Set(names.flatMap((n) => (n === GMAIL_STREAMS_TOKEN ? streams : [n])))];
}

/**
 * The config.json a retrieval.json's `@gmail` reads: TOPHAT_CONFIG when set, else the
 * config.json beside the retrieval file's real path (the rev5 retrieval.json is a
 * symlink into ~/.config/tophat), else the config.json named above.
 */
export function configBesideRetrieval(retrievalFile, env = process.env) {
  if (env.TOPHAT_CONFIG) return path.resolve(env.TOPHAT_CONFIG);
  if (retrievalFile) {
    try { const beside = path.join(path.dirname(fs.realpathSync(retrievalFile)), 'config.json'); if (fs.existsSync(beside)) return beside; } catch { /* fall through */ }
  }
  return tophatConfigFile(env);
}
