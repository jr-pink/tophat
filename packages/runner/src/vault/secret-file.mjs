// Is this file a password export, or a file full of the owner's secrets? One
// answer for every reader that walks his disk (the documents index, any future
// corpus), so none of them flattens a cleartext export into a searchable row.
//
// The vault-value scrub on tool results caught the passwords but not the notes,
// because notes are not vault secret values.
//
// Three tests, cheapest first, each enough on its own:
//   name     a password-manager export by its file name or extension
//   header   a CSV whose header row has a password column beside a URL/site
//            column and a username column (Apple, Chrome, Firefox, Bitwarden,
//            1Password, LastPass, Dashlane exports), or a Bitwarden/1Password
//            JSON export's shape
//   vault    the text carries at least VAULT_HITS distinct exact vault values
//            (src/vault/secret-index.mjs), whatever the file is called
// Never returns or logs a value: only a reason string.

/** Extensions that are a password manager's archive or keychain whatever the name. */
const ARCHIVE_EXT = /\.(1pux|1pif|kdbx|kdb|keychain|keychain-db|agilekeychain|opvault|bwx)$/i;
/** Text-ish formats a manager exports to. */
const EXPORT_EXT = /\.(csv|tsv|json|txt|xml|html?|zip)$/i;
/** Words in a file name that mean "this is credentials". */
const SECRET_WORD = /pass(?:word|words|wd)|keychain|backup[ _.-]*codes?|recovery[ _.-]*codes?|bitwarden|1password|lastpass|dashlane|keepass|credentials?/i;

export const VAULT_HITS = 3;

const base = (p) => String(p ?? '').split('/').pop() || '';

/** The file name alone says this is a password export. */
export function secretExportName(path) {
  const name = base(path);
  if (!name) return null;
  if (ARCHIVE_EXT.test(name)) return 'name:manager-archive';
  if (EXPORT_EXT.test(name) && SECRET_WORD.test(name)) return 'name:export';
  return null;
}

const cell = (s) => s.trim().replace(/^"|"$/g, '').trim().toLowerCase();

/** The first line of a CSV/TSV is a password-manager header. */
export function secretExportHeader(text) {
  if (typeof text !== 'string' || !text) return null;
  const head = text.replace(/^\uFEFF/, '').slice(0, 4096);
  const first = head.split(/\r?\n/, 1)[0] || '';
  const cols = first.split(/[,\t;]/).map(cell);
  if (cols.length >= 3) {
    const has = (re) => cols.some((c) => re.test(c));
    const password = has(/^(login_)?password$|^pass$|^passwd$/);
    const user = has(/^(login_)?user(name| name)?$|^login$|^email$|^login_username$/);
    const site = has(/^(url|uri|website|web site|login_uri|origin|origin_url|hostname|site|title|name)$/);
    if (password && user && site) return 'header:password-csv';
  }
  // Bitwarden / 1Password / generic JSON exports: an items array whose entries carry a login password.
  if (/^\s*[[{]/.test(head) && /"(encrypted|items|accounts|vaults)"\s*:/.test(head) && /"password"\s*:/.test(text.slice(0, 65536))) {
    return 'header:password-json';
  }
  return null;
}

/**
 * Distinct vault secrets in `text`, by exact token. A token set rather than a
 * substring scan per secret, because the documents index can see thousands of
 * new files and the vault holds hundreds of values.
 */
export function vaultHits(text, values) {
  if (typeof text !== 'string' || !text || !values || !values.size) return 0;
  const seen = new Set();
  for (const token of text.split(/[\s,;"'\t|<>()[\]{}]+/)) {
    if (token.length >= 8 && values.has(token)) seen.add(token);
  }
  return seen.size;
}

/**
 * The verdict for one file: a reason string when it must not be indexed, else
 * null. `text` may be null (no extractor ran); `values` is a Set of vault
 * secret strings, or null when the vault is unreadable here.
 */
export function secretFileReason(path, text = null, values = null) {
  return secretExportName(path)
    ?? secretExportHeader(text)
    ?? (vaultHits(text, values) >= VAULT_HITS ? 'vault:values' : null);
}
