// A matcher for every secret the owner's vault holds, so a tool result that
// would carry one to the model, the transcript or the event log can be scrubbed
// first. The incident that prompted it: a CLI usage error echoed a password
// into stderr, the shell tool returned stderr verbatim, and the chat stored it.
// Fixing each CLI is necessary; this is the net under all of them, for any tool
// that ever prints a value.
//
// Values are matched exactly (length >= minLength) in memory, inside this
// process, and never printed, logged or returned: `redact()` hands back text
// with `[redacted:VAULT-ID]` in place of each hit, plus the ids that hit.
// JSON-escaped forms are matched too, because object results are stringified.
//
// What is indexed: login password and TOTP seed, secret values (every string
// leaf when the value is JSON), totp seeds, ssh-key private keys/passphrases,
// recovery codes, oauth token blobs. Not indexed: usernames, emails, phones,
// provider/account labels, passkey references (not secrets, and redacting them
// would mangle ordinary output).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PasswordManager} from './manager.mjs';
import {cardFields, compileNumeric} from './card-redact.mjs';
import {fileURLToPath} from 'node:url';
import {isMainThread, parentPort, Worker, workerData} from 'node:worker_threads';

const SECRET_KINDS = new Set(['login', 'secret', 'totp', 'ssh-key', 'recovery-codes', 'oauth']);
const SKIP_FIELDS = new Set(['usernames', 'emails', 'phones', 'provider', 'account', 'rpId', 'credentialId', 'algorithm', 'digits', 'period']);

// A JSON secret (a card, an oauth blob) mixes secret leaves with labels
// ("Mastercard", a billing address); only keys that name a secret are indexed.
const SECRET_KEY = /pass|secret|token|key|number|cvc|cvv|cvn|pin|code|credential|refresh|access|auth|seed|private|signature/i;

function leaves(value, out, key = '', keyed = false) {
  if (value === null || value === undefined || SKIP_FIELDS.has(key)) return;
  if (typeof value === 'string') { if (!keyed || SECRET_KEY.test(key)) out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) leaves(item, out, key, keyed); return; }
  if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) leaves(v, out, k, true); }
}

/** A URL without credentials, a filesystem path or a bare email address is configuration or an identifier, not a secret: redacting it mangles ordinary output. */
function looksLikeLocation(text) {
  return /^https?:\/\/[^\s@]+$/i.test(text) || /^(\/|~\/)[^\s]*$/.test(text) || /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text);
}

/** A piece is a whitespace-free token of 8+ characters mixing letters and
 * digits, or 12+ digits; prose words, dates, phone numbers and locations stay
 * readable.
 */
export function codePieces(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,;•]+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (token.length < 8 || looksLikeLocation(token) || /^\d{4}-\d{2}-\d{2}/.test(token)) continue;
    if (!/^[A-Za-z0-9._~+\/=-]+$/.test(token)) continue;
    const digits = (token.match(/\d/g) || []).length;
    if ((digits && /[A-Za-z]/.test(token)) || (digits >= 12 && digits === token.replace(/[^A-Za-z0-9]/g, '').length)) out.push(token);
  }
  return out;
}

/** The strings of one entry's value that are secret, by kind. */
export function secretStrings(kind, value) {
  const out = [];
  if (kind === 'login') {
    if (value && typeof value === 'object') {
      if (value.password) out.push(String(value.password));
      if (value.totp) out.push(String(value.totp.secret ?? value.totp));
    }
  } else if (kind === 'secret' && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed = null;
      try { parsed = JSON.parse(trimmed); } catch { /* not JSON: the whole string stands */ }
      if (parsed !== null) leaves(parsed, out, '', true); else out.push(value);
    } else if (!looksLikeLocation(trimmed)) {
      out.push(value);
      if (/\s/.test(trimmed)) out.push(...codePieces(trimmed));
    }
  } else if (SECRET_KINDS.has(kind)) {
    leaves(value, out);
  }
  return out;
}

/** Every secret string in the vault and the legacy keyring, with card fields: the I/O half of a build. */
function gatherSecrets({directory, keyFile, keyringDirectory, extraRows = []}) {
  const found = [];
  const cards = [];
  let error = null;
  for (const [id, t] of extraRows) { found.push([id, t]); if (/\s/.test(String(t ?? '').trim())) for (const piece of codePieces(t)) found.push([id, piece]); const card = cardFields(t); if (card) cards.push([id, card]); }
  try {
    if (fs.existsSync(directory)) {
      const manager = new PasswordManager({directory, ...(keyFile ? {keyFile} : {})});
      try {
        const catalog = manager.catalog();
        for (const entry of Object.values(catalog.entries || {})) {
          if (!SECRET_KINDS.has(entry.kind)) continue;
          let value;
          try { value = manager.value(entry); } catch { continue; }
          for (const text of secretStrings(entry.kind, value)) found.push([entry.id, text]);
          if (entry.kind === 'secret') { const card = cardFields(value); if (card) cards.push([entry.id, card]); }
        }
      } finally { manager.lock?.(); }
    }
  } catch (e) { error = String(e?.message || e); }
  // legacy plaintext keyring files: the same secrets, still on disk
  try {
    for (const name of fs.readdirSync(keyringDirectory)) {
      const file = path.join(keyringDirectory, name);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 65536) continue;
      const text = fs.readFileSync(file, 'utf8').trim();
      for (const piece of secretStrings('secret', text)) found.push([`keyring:${name}`, piece]);
      const card = cardFields(text); if (card) cards.push([`keyring:${name}`, card]);
    }
  } catch { /* no keyring directory */ }
  return {found, cards, error};
}

// The worker side of gatherOffThread: this same module file, loaded in a thread that was asked for it.
if (!isMainThread && workerData?.tophatSecretGather && workerData.file === import.meta.url) {
  let result;
  try { result = gatherSecrets(workerData.options); } catch (e) { result = {found: [], cards: [], error: String(e?.message || e)}; }
  parentPort.postMessage(result);
}

/** gatherSecrets on a worker thread; rejects on any failure so the caller can fall back. */
function gatherOffThread(options) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(fileURLToPath(import.meta.url), {workerData: {tophatSecretGather: true, file: import.meta.url, options}, env: {...process.env, WEBCHAT_OFFLOAD_WORKER: '1'}}); }
    catch (e) { reject(e); return; }
    worker.unref();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('secret index rebuild timed out')); }, 120_000);
    timer.unref?.();
    worker.once('message', (result) => { clearTimeout(timer); resolve(result); worker.terminate(); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('secret index worker exited')); });
  });
}

export function createSecretIndex({
  directory = process.env.TOPHAT_VAULT_DIR || path.join(os.homedir(), '.config/tophat/vault'),
  keyFile = process.env.TOPHAT_VAULT_KEY_FILE,
  keyringDirectory = process.env.TOPHAT_SECRETS_DIR || '',
  minLength = 8, ttlMs = 60_000, now = () => Date.now(),
  extra = null,   // test hook: () => [[id, value], ...]
  background = true, // rebuild on a worker thread once built (false: always synchronous)
} = {}) {
  let entries = [];       // [{id, forms: [string...]}], longest value first
  let builtAt = -Infinity;
  let numeric = (text) => ({ text, hits: [] });
  let failure = null;

  // Reading the vault decrypts every entry with a synchronous file read each; on the webchat server
  // that ran on the HTTP thread every minute and, with the disk saturated, held it 10-12 s. The first
  // build is synchronous (nothing to redact with otherwise); every rebuild after it runs on a worker
  // thread while the previous index keeps serving, as it already did for up to ttlMs.
  function install({found, cards, error}) {
    if (error) failure = new Error(error);
    const byValue = new Map();
    for (const [id, text] of found) {
      const value = String(text ?? '');
      if (value.length < minLength || /^\s+$/.test(value) || looksLikeLocation(value.trim())) continue;
      if (!byValue.has(value)) byValue.set(value, id);
    }
    entries = [...byValue].sort((a, b) => b[0].length - a[0].length).map(([value, id]) => {
      const forms = new Set([value, JSON.stringify(value).slice(1, -1)]);
      return {id, forms: [...forms]};
    });
    numeric = compileNumeric([...byValue].map(([value, id]) => [id, value]), cards);
    builtAt = now();
  }
  function collect() {
    const extraRows = extra ? extra() : [];
    install(gatherSecrets({directory, keyFile, keyringDirectory, extraRows}));
  }
  let rebuilding = null;
  function rebuildInBackground() {
    if (rebuilding || extra || !background) { if (!rebuilding && (extra || !background)) collect(); return; }
    builtAt = now(); // one rebuild per ttl even if the worker is slow
    rebuilding = gatherOffThread({directory, keyFile, keyringDirectory})
      .then(install, () => collect())
      .finally(() => { rebuilding = null; });
  }

  function ensure() { if (builtAt === -Infinity) collect(); else if (now() - builtAt >= ttlMs) rebuildInBackground(); }

  return {
    /** Rebuild now (after a vault write, or in a test). */
    refresh() { collect(); return entries.length; },
    size() { ensure(); return entries.length; },
    /** The raw secret strings as a Set, for in-process token matching (src/vault/secret-file.mjs); never print it. */
    values() { ensure(); return new Set(entries.map((e) => e.forms[0])); },
    lastError() { return failure ? String(failure.message || failure) : null; },
    /** {text, hits}: `text` with every known secret replaced; `hits` the vault ids that matched. */
    redact(text) {
      if (typeof text !== 'string' || !text) return {text, hits: []};
      ensure();
      // formatted numbers first (card-redact.mjs): exact matching would erase the card-number context
      const pre = numeric(text);
      let out = pre.text; const hits = [...pre.hits];
      for (const {id, forms} of entries) {
        for (const form of forms) {
          if (out.includes(form)) { out = out.split(form).join(`[redacted:${id}]`); if (!hits.includes(id)) hits.push(id); }
        }
      }
      return {text: out, hits};
    },
  };
}

let shared = null;
/** The process-wide index over the default vault; off with TOPHAT_REDACT_SECRETS=0. */
export function sharedSecretIndex(env = process.env) {
  if (env.TOPHAT_REDACT_SECRETS === '0') return null;
  if (!shared) shared = createSecretIndex();
  return shared;
}
