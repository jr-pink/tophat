// The net under every tool that might print a secret: an in-memory index of
// every secret the vault and the legacy plaintext secret dirs hold, and redact()
// which replaces each exact occurrence (and its JSON-escaped form) with
// `[redacted:ID]`. Indexed: passwords, TOTP seeds, secret values (only the
// secret-named leaves when the value is JSON), ssh keys, recovery codes, oauth
// blobs. Not indexed: usernames, emails, phones, labels, URLs without
// credentials, paths: redacting those mangles ordinary output.
// Never: print, log or return a value; the index lives only in this process.
import fs from 'node:fs';
import path from 'node:path';
import { PasswordManager } from '../../src/vault/manager.mjs';
import { legacySecretDirs, vaultDir, vaultKeyFile } from './paths.mjs';
import { cardFields, compileNumeric } from '../../src/vault/card-redact.mjs';

const SECRET_KINDS = new Set(['login', 'secret', 'totp', 'ssh-key', 'recovery-codes', 'oauth']);
const SKIP_FIELDS = new Set(['usernames', 'emails', 'phones', 'provider', 'account', 'rpId', 'credentialId', 'algorithm', 'digits', 'period']);
const SECRET_KEY = /pass|secret|token|key|number|cvc|cvv|cvn|pin|code|credential|refresh|access|auth|seed|private|signature/i;

function leaves(value, out, key = '', keyed = false) {
  if (value === null || value === undefined || SKIP_FIELDS.has(key)) return;
  if (typeof value === 'string') { if (!keyed || SECRET_KEY.test(key)) out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) leaves(item, out, key, keyed); return; }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, out, k, true);
}

export const looksLikeLocation = (t) =>
  /^https?:\/\/[^\s@]+$/i.test(t) || /^(\/|~\/)[^\s]*$/.test(t) || /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(t);

/** The secret strings of one vault entry's value, by kind. */
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
    } else if (!looksLikeLocation(trimmed)) out.push(value);
  } else if (SECRET_KINDS.has(kind)) leaves(value, out);
  return out;
}

/** An index rebuilt at most every `ttlMs`. `keyringDirectories` defaults to every legacy secret
 * dir; `extra` is a test hook returning [[id, value],...].
 */
export function createSecretIndex({ env = process.env, directory = vaultDir(env), keyFile = env.TOPHAT_VAULT_KEY_FILE,
  keyringDirectories = legacySecretDirs(env), minLength = 8, ttlMs = 60_000, now = () => Date.now(), extra = null } = {}) {
  let entries = [];
  let builtAt = -Infinity;
  let numeric = (text) => ({ text, hits: [] });
  let failure = null;

  function collect() {
    const found = [];
    const cards = [];
    if (extra) for (const [id, t] of extra()) { found.push([id, t]); const card = cardFields(t); if (card) cards.push([id, card]); }
    try {
      if (fs.existsSync(directory)) {
        const manager = new PasswordManager({ directory, keyFile: keyFile || vaultKeyFile(env, directory) });
        try {
          for (const entry of Object.values(manager.catalog().entries || {})) {
            if (!SECRET_KINDS.has(entry.kind)) continue;
            let value;
            try { value = manager.value(entry); } catch { continue; }
            for (const t of secretStrings(entry.kind, value)) found.push([entry.id, t]);
            if (entry.kind === 'secret') { const card = cardFields(value); if (card) cards.push([entry.id, card]); }
          }
        } finally { manager.lock?.(); }
      }
    } catch (error) { failure = error; }
    for (const dir of [].concat(keyringDirectories || [])) {
      try {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 65536) continue;
          const text = fs.readFileSync(file, 'utf8').trim();
          for (const piece of secretStrings('secret', text)) found.push([`keyring:${name}`, piece]);
          const card = cardFields(text); if (card) cards.push([`keyring:${name}`, card]);
        }
      } catch { /* no such dir */ }
    }
    const byValue = new Map();
    for (const [id, t] of found) {
      const value = String(t ?? '');
      if (value.length < minLength || /^\s+$/.test(value) || looksLikeLocation(value.trim())) continue;
      if (!byValue.has(value)) byValue.set(value, id);
    }
    entries = [...byValue].sort((a, b) => b[0].length - a[0].length)
      .map(([value, id]) => ({ id, forms: [...new Set([value, JSON.stringify(value).slice(1, -1)])] }));
    numeric = compileNumeric([...byValue].map(([value, id]) => [id, value]), cards);
    builtAt = now();
  }
  const ensure = () => { if (now() - builtAt >= ttlMs) collect(); };

  const index = {
    refresh() { collect(); return entries.length; },
    size() { ensure(); return entries.length; },
    lastError() { return failure ? String(failure.message || failure) : null; },
    /** {text, hits}: every known secret replaced; hits are the ids that matched. */
    redact(text) {
      if (typeof text !== 'string' || !text) return { text, hits: [] };
      ensure();
      // formatted numbers first (card-redact.mjs): exact matching would erase the card-number context
      const pre = numeric(text);
      let out = pre.text;
      const hits = [...pre.hits];
      for (const { id, forms } of entries) {
        for (const form of forms) {
          if (out.includes(form)) { out = out.split(form).join(`[redacted:${id}]`); if (!hits.includes(id)) hits.push(id); }
        }
      }
      return { text: out, hits };
    },
    /** Every string in a structure redacted (keys included); {value, hits}. */
    redactValue(value) {
      const hits = new Set();
      const walk = (v) => {
        if (typeof v === 'string') { const r = index.redact(v); r.hits.forEach((h) => hits.add(h)); return r.text; }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
        return v;
      };
      return { value: walk(value), hits: [...hits] };
    },
  };
  return index;
}

let shared = null;
/** The process-wide index over the default vault; off with TOPHAT_REDACT_SECRETS=0. */
export function sharedSecretIndex(env = process.env) {
  if (env.TOPHAT_REDACT_SECRETS === '0') return null;
  if (!shared) shared = createSecretIndex({ env });
  return shared;
}
