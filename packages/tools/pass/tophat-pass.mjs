// tophat-pass: read and manage a tophat credential vault from the command line, with no passkey and no web session. A process
// running as the vault's owner can read the files directly (the records are encrypted at rest with an owner-only
// local key file, or a passphrase), so this CLI uses the vault's own PasswordManager rather than a second reader.
//
// Read verbs never write a record, a catalog or the key file. Write verbs (init, protect, set, setpass, settotp, import,
// archive, groups, recovery --spend, forget) go through the vault's own PasswordManager and take every secret from
// --file or stdin, never argv. Values print only for `get`, `totp`, `recovery --spend`, `generate` and `lookup --reveal`;
// everything else is metadata. An argument echoed in an error is shaped like an id or hidden, so a password passed in
// the wrong slot cannot reach a transcript.
//
//   TOPHAT_VAULT_DIR, TOPHAT_VAULT_KEY_FILE   the vault (default ~/.config/tophat/vault and vault-master-key beside it)
//   TOPHAT_PASS_MANAGER                       path of the PasswordManager module (default: the runner package beside this one)
//   TOPHAT_PASS_PASSPHRASE | --passphrase-stdin   unlock a passphrase-protected vault; otherwise exit 4
//   vault.json beside config.json            {"aadPrefixes": [...]}: read a vault sealed under an older record-binding prefix (read fallback only)
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

const BOOLEAN = ['json', 'archived', 'help', 'no-newline', 'passphrase-stdin', 'raw', 'reveal', 'overwrite', 'keep', 'restore', 'spend', 'yes'];
const REPEAT = ['site', 'username', 'email', 'phone', 'group'];
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      const given = BOOLEAN.includes(name) ? true : inline !== undefined ? inline : argv[++i];
      if (REPEAT.includes(name)) (flags[name] ||= []).push(given);
      else flags[name] = given;
    } else if (arg === '-h') flags.help = true;
    else if (arg === '-n') flags['no-newline'] = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

const HELP = `tophat-pass: read and manage a tophat credential vault from the command line, no passkey.

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
  tophat-pass recovery ID [--spend]
        how many recovery codes are left; --spend prints one unused code and marks it used.
  tophat-pass generate
        a new random password, always Apple Passwords style: three six-character alphanumeric groups joined by
        dashes (abc4ef-ghijKm-npqrst). Stores nothing. --length alone is refused: a site that rejects that shape
        is the only reason for --dense N (N random characters with symbols); say which site needed it.

Write verbs. A secret comes from --file PATH or stdin, never argv. Nothing here prints a stored value.
  tophat-pass init
        create the vault directory and its owner-only key file.
  tophat-pass protect
        wrap the key in a passphrase read from TOPHAT_PASS_NEW_PASSPHRASE or stdin (12 to 4096 characters).
  tophat-pass set ID [--kind K] [--name N] [--site URL]... [--username U]... [--email E]... [--phone P]...
                  [--group G]... [--notes TEXT] [--file PATH] [--overwrite]
        store one credential. K is login (value = the password), secret (default), totp (base32 or otpauth:// URI),
        recovery-codes (one per line), ssh-key (PEM), oauth (JSON) or passkey-reference (--rp-id HOST --provider NAME
        [--credential-id ID], no value read). Websites must be HTTPS. An existing id needs --overwrite.
  tophat-pass setpass ID | settotp ID
        replace only the password, or attach or replace the TOTP seed, of an existing login (value from --file or stdin).
  tophat-pass import FILE --format chrome|apple|bitwarden|1password|1pux|keepass|csv [--overwrite] [--keep]
        import a password-manager export, then DELETE the export (it holds every password in cleartext) unless --keep
        or the import failed. Existing ids are skipped unless --overwrite. Prints counts and warnings, never values.
  tophat-pass archive ID [--restore] | groups ID --set a,b | forget ID --yes
        archive or restore an entry (kept, hidden from autofill), replace its groups, or delete it for good.

A passphrase-protected vault: TOPHAT_PASS_PASSPHRASE, or --passphrase-stdin. Otherwise exit 4.
Exit codes: 0 ok, 1 error, 2 usage, 3 unknown credential or field, 4 locked.`;

const KINDS = ['login', 'secret', 'totp', 'recovery-codes', 'ssh-key', 'oauth', 'passkey-reference'];
const IMPORT_FORMATS = ['chrome', 'apple', 'safari', 'bitwarden', '1password', '1pux', 'keepass', 'csv', 'bitwarden-csv', '1password-csv'];
const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x) => typeof x === 'string' && x.trim());
const guard = (fn) => { try { return fn(); } catch (e) { throw e instanceof Fail ? e : new Fail(e.expose ? e.message : 'The vault refused that operation', EXIT.error); } };

/** A secret never comes from argv: --file PATH or stdin, one trailing newline dropped. */
async function incomingValue(flags) {
  let text;
  if (flags.file) {
    try { text = fs.readFileSync(path.resolve(String(flags.file)), 'utf8'); } catch (e) { throw new Fail(`cannot read --file (${e.code || e.name})`, EXIT.error); }
  } else {
    if (process.stdin.isTTY) throw new Fail('Give the value on stdin or with --file PATH; it is never taken from arguments.', EXIT.usage);
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  }
  text = text.replace(/\r?\n$/, '');
  if (!text) throw new Fail('The value is empty.', EXIT.usage);
  return text;
}

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
    if (verb === 'generate') {
      // One shape for every password an agent makes (the owner, 2026-11-17: "use the apple passwords style 6 x 3
      // alpha-numeric with dash separated"). --length used to switch silently to a dense symbol password.
      if (flags.length !== undefined) throw new Fail('generate makes Apple-style passwords (xxxxxx-xxxxxx-xxxxxx) only; --length is not accepted. For a site that rejects that shape use --dense N.', EXIT.usage);
      out(guard(() => store.module.generatePassword(flags.dense === undefined ? undefined : { dense: Number(flags.dense) })));
      return EXIT.ok;
    }
    if (verb === 'init') {
      const status = guard(() => store.manager.initialize());
      out(JSON.stringify({ directory: store.directory, initialized: status.initialized, keyStorage: status.keyStorage }, null, 2));
      return EXIT.ok;
    }
    if (verb === 'protect') {
      const passphrase = envGet(env, 'TOPHAT_PASS_NEW_PASSPHRASE') || (await incomingValue({}));
      const status = guard(() => store.manager.protect(passphrase));
      out(JSON.stringify({ directory: store.directory, keyStorage: status.keyStorage, locked: status.locked }, null, 2));
      return EXIT.ok;
    }
    // set and import create the vault on first use; every other verb needs one that exists.
    if (['set', 'import'].includes(verb) && !store.manager.status().initialized) guard(() => store.manager.initialize());
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
      const rows = entries(Boolean(flags.archived)).filter((e) => list(flags.group).every((g) => (e.groups || []).includes(g))).map(shape);
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
    if (verb === 'set') {
      const id = rest[0];
      if (!id) throw new Fail('set needs a credential id', EXIT.usage);
      const kind = flags.kind || 'secret';
      if (!KINDS.includes(kind)) throw new Fail(`--kind must be one of ${KINDS.join(', ')}`, EXIT.usage);
      let value;
      if (kind === 'passkey-reference') value = { rpId: flags['rp-id'], provider: flags.provider, credentialId: flags['credential-id'] || null };
      else {
        const text = await incomingValue(flags);
        if (kind === 'login') value = { password: text, usernames: list(flags.username), emails: list(flags.email), phones: list(flags.phone) };
        else if (kind === 'recovery-codes') value = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        else if (kind === 'ssh-key') value = { privateKey: text, passphrase: '' };
        else if (kind === 'oauth') { try { value = JSON.parse(text); } catch { throw new Fail('An oauth value must be JSON.', EXIT.usage); } }
        else value = text;
      }
      const saved = guard(() => store.manager.save({ id, name: flags.name || id, kind, origins: list(flags.site), value,
        groups: list(flags.group), notes: flags.notes || '' }, { overwrite: Boolean(flags.overwrite) }));
      out(JSON.stringify(shape(saved), null, 2));
      return EXIT.ok;
    }
    if (verb === 'setpass' || verb === 'settotp') {
      if (!rest[0]) throw new Fail(`${verb} needs a credential id`, EXIT.usage);
      const entry = resolve(rest[0]);
      if (entry.kind !== 'login') throw new Fail(`A ${entry.kind} entry is not a login`, EXIT.usage);
      const text = await incomingValue(flags);
      const value = { ...store.manager.value(entry), [verb === 'setpass' ? 'password' : 'totp']: text };
      const saved = guard(() => store.manager.save({ id: entry.id, name: entry.name, kind: 'login', origins: entry.origins,
        value, groups: entry.groups, archived: entry.archived, notes: entry.notes || '' }, { overwrite: true }));
      out(JSON.stringify(shape(saved), null, 2));
      return EXIT.ok;
    }
    if (verb === 'import') {
      const file = rest[0];
      if (!file) throw new Fail('import needs the export file', EXIT.usage);
      if (!IMPORT_FORMATS.includes(flags.format)) throw new Fail(`--format must be one of ${IMPORT_FORMATS.join(', ')}`, EXIT.usage);
      let bytes;
      try { bytes = fs.readFileSync(path.resolve(file)); } catch (e) { throw new Fail(`cannot read the export (${e.code || e.name})`, EXIT.error); }
      const options = { overwrite: Boolean(flags.overwrite) };
      const zipped = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      // Bitwarden and 1Password export either JSON or CSV under the same name; the first character says which.
      const format = ['bitwarden', '1password'].includes(flags.format) && !/^\s*[{[]/.test(text) ? `${flags.format}-csv` : flags.format;
      const result = guard(() => (['1pux', '1password'].includes(flags.format) && zipped ? store.manager.importArchive(bytes, options) : store.manager.import(format, text, options)));
      let deleted = false;
      if (!flags.keep) { fs.unlinkSync(path.resolve(file)); deleted = true; }
      out(JSON.stringify({ ...result, exportDeleted: deleted }, null, 2));
      return EXIT.ok;
    }
    if (verb === 'archive') {
      if (!rest[0]) throw new Fail('archive needs a credential id', EXIT.usage);
      const entry = resolve(rest[0]);
      out(JSON.stringify(shape(guard(() => store.manager.archive(entry.id, !flags.restore))), null, 2));
      return EXIT.ok;
    }
    if (verb === 'groups') {
      if (!rest[0] || typeof flags.set !== 'string') throw new Fail('groups needs a credential id and --set a,b (empty for none)', EXIT.usage);
      const entry = resolve(rest[0]);
      out(JSON.stringify(shape(guard(() => store.manager.groups(entry.id, flags.set.split(',').map((g) => g.trim()).filter(Boolean)))), null, 2));
      return EXIT.ok;
    }
    if (verb === 'recovery') {
      if (!rest[0]) throw new Fail('recovery needs a credential id', EXIT.usage);
      const entry = resolve(rest[0]);
      if (entry.kind !== 'recovery-codes') throw new Fail(`A ${entry.kind} entry holds no recovery codes`, EXIT.unknown);
      if (flags.spend) { out(guard(() => store.manager.takeRecoveryCode(entry.id))); return EXIT.ok; }
      out(JSON.stringify({ id: entry.id, name: entry.name, remaining: entry.remaining ?? store.manager.value(entry).length }, null, 2));
      return EXIT.ok;
    }
    if (verb === 'forget') {
      if (!rest[0]) throw new Fail('forget needs a credential id', EXIT.usage);
      if (!flags.yes) throw new Fail('forget deletes the credential for good; add --yes', EXIT.usage);
      const entry = resolve(rest[0]);
      out(JSON.stringify(guard(() => store.manager.forget(entry.id)), null, 2));
      return EXIT.ok;
    }
    throw new Fail(`Unknown command "${safeArg(verb)}". Run tophat-pass --help.`, EXIT.usage);
  } finally { store.manager.lock?.(); }
}

