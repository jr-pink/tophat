// tophat-pass: read a tophat credential vault from the command line, with no passkey and no web session. A process
// running as the vault's owner can read the files directly (the records are encrypted at rest with an owner-only
// local key file, or a passphrase), so this CLI uses the vault's own PasswordManager rather than a second reader.
//
// Read verbs only: it never writes a record, a catalog or the key file. Values print only for `get` (and `lookup
// --reveal`); everything else is metadata. An argument echoed in an error is shaped like an id or hidden, so a
// password passed in the wrong slot cannot reach a transcript.
//
//   TOPHAT_VAULT_DIR, TOPHAT_VAULT_KEY_FILE   the vault (default ~/.config/tophat/vault and vault-master-key beside it)
//   TOPHAT_PASS_MANAGER                       path of the PasswordManager module (default: the runner package beside this one)
//   TOPHAT_PASS_PASSPHRASE | --passphrase-stdin   unlock a passphrase-protected vault; otherwise exit 4
//   TOPHAT_VAULT_LEGACY_AAD_PREFIX            read a vault sealed under an older record-binding prefix (read fallback only)
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { envGet, configDir } from '../lib/paths.mjs';

const EXIT = { ok: 0, error: 1, usage: 2, unknown: 3, locked: 4 };
class Fail extends Error { constructor(message, code = EXIT.error) { super(message); this.code = code; } }

const safeArg = (value) => {
  const text = String(value ?? '');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(text) ? text : `<arg of ${text.length} chars, not shown>`;
};

const BOOLEAN = ['json', 'archived', 'help', 'no-newline', 'passphrase-stdin', 'raw', 'reveal'];
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (BOOLEAN.includes(name)) flags[name] = true;
      else if (inline !== undefined) flags[name] = inline;
      else flags[name] = argv[++i];
    } else if (arg === '-h') flags.help = true;
    else if (arg === '-n') flags['no-newline'] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

const HELP = `tophat-pass: read a tophat credential vault from the command line, no passkey.

  tophat-pass list [--json] [--archived] [--group G]
        ids, names, kinds, origins, updatedAt. Never values.
  tophat-pass find QUERY [--json]
        substring match on id, name, websites, groups. Metadata, no values.
  tophat-pass lookup URL|QUERY [--json] [--reveal]
        entries for a website (or a query); values print redacted unless --reveal.
  tophat-pass fields ID
        which fields the entry has (username/password/secret/...), no values.
  tophat-pass get QUERY[:field] [--field F] [--raw] [-n]
        print every matching full record as JSON. --raw prints one value, needs a unique exact id or name,
        refuses ambiguity; -n drops the final newline. --raw defaults: login -> password, secret -> the secret,
        ssh-key -> privateKey, recovery-codes -> every code, one per line. On a totp entry --raw needs --field secret.
  tophat-pass totp ID [--json]
        current one-time code for a totp entry or a login that carries a seed.
  tophat-pass history [ID] [--limit N] [--json]
        recorded changes to credentials, newest first. Metadata only.
  tophat-pass status | stores [--json]
        where the vault is, whether it exists, how many entries, locked or not.

A passphrase-protected vault: TOPHAT_PASS_PASSPHRASE, or --passphrase-stdin. Otherwise exit 4.
Exit codes: 0 ok, 1 error, 2 usage, 3 unknown credential or field, 4 locked.`;

const FIELDS = { login: ['usernames', 'emails', 'phones', 'password', 'totp'], secret: ['secret'], totp: ['secret', 'algorithm', 'digits', 'period'],
  'ssh-key': ['privateKey', 'passphrase'], oauth: ['issuer', 'account', 'scopes', 'expiresAt'], 'passkey-reference': ['provider'] };
const FALLBACK = { login: 'password', secret: 'secret', 'ssh-key': 'privateKey', oauth: 'account', 'passkey-reference': 'provider' };

/** One value out of a decrypted record by field name; null when the field is absent. */
export function pick(kind, value, field) {
  if (kind === 'secret') {
    if (!field || field === 'secret' || field === 'value') return String(value);
    let o; try { o = JSON.parse(String(value)); } catch { return null; }
    const v = field.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
    return v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v);
  }
  if (kind === 'recovery-codes') return !field || field === 'all' ? value.join('\n') : value[Number(field) - 1] ?? null;
  if (kind === 'totp' && !field) return null;
  const chosen = kind === 'login' ? ({ username: 'usernames', email: 'emails', phone: 'phones' }[field] || field || FALLBACK.login) : (field || FALLBACK[kind]);
  if (!chosen || !(FIELDS[kind] || []).includes(chosen)) return null;
  let v = value?.[chosen];
  if (Array.isArray(v)) v = v.length ? v.join('\n') : null;
  else if (kind === 'login' && chosen === 'totp' && v) v = v.secret;
  return v === undefined || v === null || v === '' ? null : String(v);
}

export function vaultPaths(env = process.env) {
  const directory = path.resolve(envGet(env, 'TOPHAT_VAULT_DIR') || path.join(configDir(env), 'vault'));
  const keyFile = path.resolve(envGet(env, 'TOPHAT_VAULT_KEY_FILE') || path.join(path.dirname(directory), 'vault-master-key'));
  return { directory, keyFile };
}

async function openVault(env = process.env) {
  const { directory, keyFile } = vaultPaths(env);
  const where = envGet(env, 'TOPHAT_PASS_MANAGER') || new URL('../../runner/src/vault/manager.mjs', import.meta.url).href;
  let module;
  try { module = await import(/^[a-z]+:/.test(where) ? where : pathToFileURL(path.resolve(where)).href); } catch (e) {
    throw new Fail(`cannot load the vault manager (${e.code || e.name}); set TOPHAT_PASS_MANAGER to its module path`, EXIT.error);
  }
  return { directory, keyFile, module, manager: new module.PasswordManager({ directory, keyFile }) };
}

async function readPassphrase(flags, env) {
  const named = envGet(env, 'TOPHAT_PASS_PASSPHRASE');
  if (named) return named;
  if (!flags['passphrase-stdin']) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function ready(store, flags, env) {
  const status = store.manager.status();
  if (!status.initialized) throw new Fail(`No credential vault at ${store.directory}`, EXIT.error);
  if (!status.locked) return store;
  const passphrase = await readPassphrase(flags, env);
  if (!passphrase) throw new Fail('The vault is passphrase-protected and locked. Supply TOPHAT_PASS_PASSPHRASE or --passphrase-stdin.', EXIT.locked);
  store.manager.unlock(passphrase, { ttlMs: 60 * 1000 });
  return store;
}

/** Metadata shaped for printing: no keyring file names, no clocks, never a value. */
const shape = (entry) => ({ id: entry.id, name: entry.name, kind: entry.kind, origins: entry.origins || [], groups: entry.groups || [], archived: Boolean(entry.archived), updatedAt: entry.updatedAt ?? null });
const matches = (entry, q) => [entry.id, entry.name, ...(entry.origins || []), ...(entry.groups || [])].some((s) => String(s || '').toLowerCase().includes(q.toLowerCase()));
const table = (rows) => rows.map((r) => `${r.id}  ${r.kind}  ${r.name}${r.origins?.length ? `  ${r.origins.join(',')}` : ''}${r.archived ? '  (archived)' : ''}`).join('\n');
const out = (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

export async function main(argv, env = process.env) {
  const { flags, positional } = parseArgs(argv);
  const [verb, ...rest] = positional;
  if (flags.help || !verb || verb === 'help') { out(HELP); return verb || flags.help ? EXIT.ok : EXIT.usage; }
  const store = await openVault(env);
  try {
    if (verb === 'status' || verb === 'stores') {
      const present = fs.existsSync(store.directory);
      const row = { store: 'vault', directory: store.directory, present };
      if (present) {
        try {
          const status = store.manager.status();
          row.locked = Boolean(status.locked);
          if (!status.locked) row.entries = Object.keys(store.manager.catalog().entries).length;
        } catch (e) { row.error = e.message; }
      }
      out(flags.json || verb === 'status' ? JSON.stringify(row, null, 2) : `${row.store}  ${row.directory}  ${row.present ? `${row.entries ?? '?'} entries` : 'absent'}${row.locked ? '  LOCKED' : ''}${row.error ? `  error: ${row.error}` : ''}`);
      return EXIT.ok;
    }
    await ready(store, flags, env);
    const catalog = () => store.manager.catalog();
    const entries = (all = false) => Object.values(catalog().entries).filter((e) => all || !e.archived);
    const resolve = (id, exact = true) => {
      const list = entries(true);
      const hit = list.filter((e) => e.id === id).concat(list.filter((e) => e.name === id && e.id !== id));
      if (exact ? hit.length === 1 : hit.length) return hit[0];
      if (hit.length > 1) throw new Fail(`Ambiguous credential: ${hit.length} matches. Use the exact id.`, EXIT.usage);
      throw new Fail(`Unknown credential "${safeArg(id)}". Try: tophat-pass find <query>`, EXIT.unknown);
    };

    if (verb === 'list') {
      const rows = entries(Boolean(flags.archived)).filter((e) => !flags.group || (e.groups || []).includes(flags.group)).map(shape);
      out(flags.json ? JSON.stringify(rows, null, 2) : table(rows));
      return EXIT.ok;
    }
    if (verb === 'find' || verb === 'lookup') {
      const query = rest.join(' ');
      if (!query) throw new Fail(`${verb} needs a query${verb === 'lookup' ? ' or https URL' : ''}`, EXIT.usage);
      const origin = verb === 'lookup' && /^https?:\/\//i.test(query) ? store.module.originOf(query) : null;
      const found = entries(Boolean(flags.archived)).filter((e) => (origin ? (e.origins || []).includes(origin) : matches(e, query)));
      const rows = found.map((e) => {
        const row = shape(e);
        if (verb === 'lookup') { try { row.value = flags.reveal ? store.manager.value(e) : '[redacted; pass --reveal]'; } catch { row.value = '[unreadable]'; } }
        return row;
      });
      out(flags.json || verb === 'lookup' ? JSON.stringify(rows, null, 2) : table(rows));
      return rows.length ? EXIT.ok : EXIT.unknown;
    }
    if (verb === 'fields') {
      if (!rest[0]) throw new Fail('fields needs a credential id', EXIT.usage);
      const entry = resolve(rest[0]);
      const value = store.manager.value(entry);
      const present = (FIELDS[entry.kind] || []).filter((f) => entry.kind === 'secret' || (value?.[f] !== undefined && value?.[f] !== null && value?.[f] !== ''));
      out(JSON.stringify({ id: entry.id, name: entry.name, kind: entry.kind, fields: present, default: FALLBACK[entry.kind] ?? null }, null, 2));
      return EXIT.ok;
    }
    if (verb === 'get') {
      let query = rest.join(' ');
      if (!query) throw new Fail('get needs a query or credential id', EXIT.usage);
      let field = flags.field;
      let found = flags.raw ? entries(true).filter((e) => e.id === query || e.name === query) : entries(Boolean(flags.archived)).filter((e) => e.id === query || e.name === query || matches(e, query));
      if (!found.length && !field && query.lastIndexOf(':') > 0) {
        const colon = query.lastIndexOf(':');
        field = query.slice(colon + 1); query = query.slice(0, colon);
        found = entries(true).filter((e) => e.id === query || e.name === query || (!flags.raw && matches(e, query)));
      }
      if (!found.length) throw new Fail(`Unknown credential "${safeArg(query)}". Try: tophat-pass find <query>`, EXIT.unknown);
      if (flags.raw) {
        if (found.length !== 1) throw new Fail(`Ambiguous credential: ${found.length} matches. Use get without --raw to inspect all records, then select an exact id.`, EXIT.usage);
        const value = pick(found[0].kind, store.manager.value(found[0]), field);
        if (value === null) throw new Fail(`Credential "${safeArg(query)}" has no field "${safeArg(field || '(default)')}"`, EXIT.unknown);
        process.stdout.write(flags['no-newline'] ? value : `${value}\n`);
        return EXIT.ok;
      }
      const rows = found.map((e) => {
        const row = { ...shape(e), value: store.manager.value(e) };
        if (field) { row.selectedField = field; row.selectedValue = pick(e.kind, row.value, field); }
        return row;
      });
      out(JSON.stringify(rows, null, 2));
      return EXIT.ok;
    }
    if (verb === 'totp') {
      if (!rest[0]) throw new Fail('totp needs a credential id', EXIT.usage);
      const entry = resolve(rest[0]);
      if (!['totp', 'login'].includes(entry.kind)) throw new Fail(`A ${entry.kind} entry carries no one-time code`, EXIT.unknown);
      const value = store.manager.value(entry);
      const seed = entry.kind === 'totp' ? value : value.totp;
      if (!seed) throw new Fail(`Credential "${safeArg(rest[0])}" has no TOTP secret`, EXIT.unknown);
      const { code, expiresAt } = store.module.totp(seed);
      out(flags.json ? JSON.stringify({ id: entry.id, code, expiresAt }) : code);
      return EXIT.ok;
    }
    if (verb === 'history') {
      const limit = flags.limit === undefined ? 50 : Number(flags.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Fail('--limit needs a positive integer', EXIT.usage);
      const rows = store.manager.history({ id: rest[0] || null, limit });
      out(flags.json ? JSON.stringify(rows, null, 2) : rows.map((r) => `${r.at || r.when || ''}  ${r.action || ''}  ${r.id || ''}  ${r.name || ''}`).join('\n'));
      return EXIT.ok;
    }
    throw new Fail(`Unknown command "${safeArg(verb)}". Run tophat-pass --help.`, EXIT.usage);
  } finally { store.manager.lock?.(); }
}

