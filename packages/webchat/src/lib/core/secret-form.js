// The credential form on /secrets as data, with no DOM and no framework: which kinds there are, which fields each kind
// shows, how a draft (a flat map of strings, what the form edits) becomes the vault entry the manager saves, and how a
// revealed entry becomes a draft again for editing. The page and its tests read this one file.
//
// A "card" is not a vault type. The vault (packages/runner/src/vault/values.mjs TYPES) has login, totp, recovery-codes, ssh-key,
// passkey-reference, oauth and secret, and the cards the owner already keeps (card-mastercard-1234 ...) are `secret` entries
// whose value is one JSON string { label, name_on_card, number, exp, cvc, billing_address: { line1, city, state,
// postal_code, country }, authorization, added } that `tophat-pass get ID --raw` prints as is. A new card is saved in exactly
// that shape. The UI tells a card (and a secure note) from a plain secret by the id prefix `card-` or a `kind:` group tag the
// page adds; the tag is hidden from the group list.

export const TYPE_TAG = { card: 'kind:card', note: 'kind:note' };

/** `plural` is the sidebar name; `vault` the type the manager stores it as. */
export const KINDS = [
  { id: 'login', label: 'Login', plural: 'Logins', vault: 'login' },
  { id: 'card', label: 'Payment card', plural: 'Cards', vault: 'secret' },
  { id: 'secret', label: 'Secret or API key', plural: 'Secrets', vault: 'secret' },
  { id: 'note', label: 'Secure note', plural: 'Notes', vault: 'secret' },
  { id: 'totp', label: 'Verification code', plural: 'Verification codes', vault: 'totp' },
  { id: 'ssh-key', label: 'SSH key', plural: 'Keys', vault: 'ssh-key' },
  { id: 'oauth', label: 'OAuth grant', plural: 'OAuth grants', vault: 'oauth' },
  { id: 'recovery-codes', label: 'Recovery codes', plural: 'Recovery codes', vault: 'recovery-codes' },
  { id: 'passkey-reference', label: 'Passkey', plural: 'Passkeys', vault: 'passkey-reference' }
];
export const KIND_BY_ID = Object.fromEntries(KINDS.map((kind) => [kind.id, kind]));

/** The kind the page shows for a catalog entry (metadata only; never reads a value). */
export function uiKind(entry) {
  if (!entry) return 'secret';
  if (entry.kind !== 'secret') return entry.kind;
  const groups = entry.groups || [];
  if (groups.includes(TYPE_TAG.card) || /^card-/.test(entry.id || '')) return 'card';
  if (groups.includes(TYPE_TAG.note)) return 'note';
  return 'secret';
}
/** Groups he sees and edits: the type tags are the page's own bookkeeping. */
export const visibleGroups = (groups) => (groups || []).filter((group) => !group.startsWith('kind:'));

// key -> how the form draws it. `secret` is masked until he asks (a Show toggle on the field); `multiline` a textarea.
export const FIELDS = {
  name: { label: 'Label', placeholder: 'what you would call it', autocomplete: 'off' },
  website: { label: 'Website', placeholder: 'example.com', autocomplete: 'off', inputmode: 'url' },
  username: { label: 'Username or email', autocomplete: 'off' },
  password: { label: 'Password', secret: true, autocomplete: 'new-password' },
  holder: { label: 'Name on card', autocomplete: 'off' },
  number: { label: 'Card number', secret: true, inputmode: 'numeric', placeholder: '1234 5678 9012 3456', autocomplete: 'off' },
  exp: { label: 'Expiry', placeholder: 'MM/YY', inputmode: 'numeric', maxlength: 7, autocomplete: 'off' },
  cvc: { label: 'CVC', secret: true, inputmode: 'numeric', maxlength: 4, autocomplete: 'off' },
  line1: { label: 'Billing address', placeholder: 'Street address', autocomplete: 'off' },
  city: { label: 'City', autocomplete: 'off' },
  state: { label: 'State', autocomplete: 'off', maxlength: 40 },
  postal_code: { label: 'ZIP or postal code', autocomplete: 'off', maxlength: 20 },
  country: { label: 'Country', placeholder: 'US', autocomplete: 'off', maxlength: 60 },
  authorization: { label: 'Authorization', multiline: true, rows: 2, placeholder: 'Who may use this card, and for what (optional)' },
  secretValue: { label: 'Value', secret: true, autocomplete: 'off' },
  noteText: { label: 'Note', multiline: true, rows: 6, secret: true },
  totpSecret: { label: 'Secret or otpauth:// URI', secret: true, autocomplete: 'off' },
  recoveryCodes: { label: 'Codes, one per line', multiline: true, rows: 6, secret: true },
  privateKey: { label: 'Private key', multiline: true, rows: 6, secret: true, mono: true },
  passphrase: { label: 'Key passphrase', secret: true, autocomplete: 'off' },
  provider: { label: 'Authenticator provider', placeholder: 'iCloud Keychain', autocomplete: 'off' },
  issuer: { label: 'Issuer', placeholder: 'mercury.com', autocomplete: 'off' },
  account: { label: 'Account', autocomplete: 'off' },
  scopes: { label: 'Scopes', placeholder: 'space or comma separated', autocomplete: 'off' },
  expiresAt: { label: 'Expires', placeholder: '2026-12-01T00:00:00Z', autocomplete: 'off' },
  accessToken: { label: 'Access token', secret: true, autocomplete: 'off' },
  refreshToken: { label: 'Refresh token', secret: true, autocomplete: 'off' },
  groups: { label: 'Groups', placeholder: 'comma separated', autocomplete: 'off' },
  notes: { label: 'Notes', multiline: true, rows: 3, placeholder: 'Anything else worth keeping' },
  id: { label: 'Identifier', autocomplete: 'off' }
};

/** Which fields a kind shows, in order; a `{ title }` item is a small heading above the next fields. */
export const FORMS = {
  login: ['name', 'website', 'username', 'password', 'notes', 'groups'],
  card: ['name', 'holder', 'number', 'exp', 'cvc', { title: 'Billing address' }, 'line1', 'city', 'state', 'postal_code', 'country', 'authorization', 'notes', 'groups'],
  secret: ['name', 'secretValue', 'website', 'notes', 'groups'],
  note: ['name', 'noteText', 'groups'],
  totp: ['name', 'totpSecret', 'website', 'notes', 'groups'],
  'ssh-key': ['name', 'privateKey', 'passphrase', 'notes', 'groups'],
  oauth: ['name', 'issuer', 'account', 'accessToken', 'refreshToken', 'scopes', 'expiresAt', 'notes', 'groups'],
  'recovery-codes': ['name', 'recoveryCodes', 'notes', 'groups'],
  'passkey-reference': ['name', 'website', 'provider', 'notes', 'groups']
};
export const fieldKeys = (kind) => (FORMS[kind] || FORMS.secret).filter((item) => typeof item === 'string');

// ---- drafts ----------------------------------------------------------------------------------------------------------

export const blankDraft = (kind = 'login') => ({ kind });

/** Keys that are bookkeeping, not something he typed. */
const QUIET = new Set(['kind', 'replace', '_extra']);
/** Has he put anything in it? An untouched draft is not worth keeping or confirming over. */
export const draftHasContent = (data) =>
  Object.entries(data || {}).some(([key, value]) => !QUIET.has(key) && typeof value === 'string' && value.trim() !== '');

const norm = (data) => JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([, v]) => v !== '' && v != null).sort(([a], [b]) => (a < b ? -1 : 1))));
/** Unsaved changes: for a new credential, any content; for an edit, anything different from what was loaded. */
export const draftIsDirty = (data, base) => (base && Object.keys(base).length ? norm(data) !== norm(base) : draftHasContent(data));

// ---- card helpers ----------------------------------------------------------------------------------------------------

export const digitsOf = (text) => String(text || '').replace(/\D+/g, '');
export function cardBrand(number) {
  const n = digitsOf(number);
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  return 'card';
}
export function luhnOk(number) {
  const n = digitsOf(number);
  if (n.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i += 1) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
/** "07/29", "7/2029", "0729" and "07 29" all become 07/29; anything else is null. */
export function normalizeExpiry(text) {
  const raw = String(text || '').trim();
  const m = /^(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})$/.exec(raw);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return `${String(month).padStart(2, '0')}/${m[2].slice(-2)}`;
}
/** "•••• 2460": what a card shows before it is revealed. */
export const maskedNumber = (number) => { const n = digitsOf(number); return n.length >= 4 ? `•••• ${n.slice(-4)}` : '••••'; };

// ---- helpers shared with the page ------------------------------------------------------------------------------------

export const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export function host(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); }
  catch { return raw.replace(/^https?:\/\//, '').split('/')[0]; }
}
const originFor = (site) => { const raw = String(site || '').trim(); return raw ? (raw.includes('://') ? raw : `https://${raw}`) : ''; };
const splitList = (text, pattern) => String(text || '').split(pattern).map((v) => v.trim()).filter(Boolean);
const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const parseExtra = (data) => { try { const out = JSON.parse(data?._extra || '{}'); return out && typeof out === 'object' ? out : {}; } catch { return {}; } };

/** The name shown for a credential when he typed none. */
export function derivedName(data) {
  const typed = text(data.name).trim();
  if (typed) return typed;
  if (data.kind === 'card') {
    const n = digitsOf(data.number);
    return n.length >= 4 ? `${cardBrand(n)} ending ${n.slice(-4)}` : '';
  }
  const site = host(data.website) || text(data.issuer).trim();
  const who = text(data.username).trim() || text(data.account).trim();
  if (site && who) return `${site} (${who})`;
  return site || who || '';
}

/** The vault id for a new credential: typed, else derived from the card, the name or the site, never one already taken. */
export function deriveId(data, taken, now = Date.now()) {
  const typed = slug(data.id);
  if (typed.length >= 2) return typed;
  let base;
  if (data.kind === 'card') {
    const n = digitsOf(data.number);
    base = n.length >= 4 ? `card-${cardBrand(n)}-${n.slice(-4)}` : '';
  } else base = slug(derivedName(data));
  if (base.length < 2) base = `${data.kind}-${now.toString(36)}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * The entry for the vault from a draft, or the reasons it cannot be saved yet.
 * `{ ok, entry, id, errors: { field: message }, warnings: [message] }`. `editId` saves over that id; otherwise the id is new.
 */
export function buildEntry(data, { taken = new Set(), editId = null, today = new Date().toISOString().slice(0, 10), now = Date.now() } = {}) {
  const kind = KIND_BY_ID[data.kind] ? data.kind : 'login';
  const d = { ...data, kind };
  const errors = {}, warnings = [];
  const need = (field, message) => { if (!text(d[field]).trim()) errors[field] = message; };
  const extra = parseExtra(d);
  const name = derivedName(d);
  if (!name) errors.name = 'Give it a label, or fill in enough to name it.';
  let value;
  let origins = d.website ? [originFor(d.website)] : [];
  if (Array.isArray(extra.origins)) origins = [...new Set([...origins, ...extra.origins])];

  if (kind === 'login') {
    need('password', 'A password is required.');
    const usernames = [text(d.username).trim(), ...(extra.usernames || [])].filter(Boolean);
    value = { password: d.password, ...(usernames.length ? { usernames: [...new Set(usernames)] } : {}),
      ...(extra.emails ? { emails: extra.emails } : {}), ...(extra.phones ? { phones: extra.phones } : {}), ...(extra.totp ? { totp: extra.totp } : {}) };
  } else if (kind === 'card') {
    const digits = digitsOf(d.number);
    if (!digits) errors.number = 'A card number is required.';
    else if (digits.length < 12 || digits.length > 19) errors.number = 'A card number is 12 to 19 digits.';
    else if (!luhnOk(digits)) warnings.push('That card number does not pass the checksum. Saved as typed.');
    const exp = text(d.exp).trim() ? normalizeExpiry(d.exp) : '';
    if (exp === null) errors.exp = 'Use MM/YY.';
    const cvc = text(d.cvc).trim();
    if (cvc && !/^\d{3,4}$/.test(cvc)) errors.cvc = 'The CVC is 3 or 4 digits.';
    const billing = { line1: text(d.line1).trim(), city: text(d.city).trim(), state: text(d.state).trim(), postal_code: text(d.postal_code).trim(), country: text(d.country).trim() };
    const previous = extra.card || {};
    value = JSON.stringify({ ...previous, label: name, name_on_card: text(d.holder).trim(), number: digits, exp: exp || '', cvc,
      billing_address: { ...(previous.billing_address || {}), ...billing }, authorization: text(d.authorization).trim(), added: previous.added || today });
    origins = [];
  } else if (kind === 'secret') {
    need('secretValue', 'A value is required.');
    value = d.secretValue;
  } else if (kind === 'note') {
    need('noteText', 'The note is empty.');
    value = d.noteText;
    origins = [];
  } else if (kind === 'totp') {
    need('totpSecret', 'A secret or otpauth:// URI is required.');
    value = d.totpSecret;
  } else if (kind === 'ssh-key') {
    need('privateKey', 'A private key is required.');
    value = { privateKey: d.privateKey, passphrase: d.passphrase || '' };
    origins = [];
  } else if (kind === 'oauth') {
    need('account', 'An account is required.');
    if (!text(d.accessToken).trim() && !text(d.refreshToken).trim()) errors.accessToken = 'An access or refresh token is required.';
    value = { ...(extra.tokenType ? { tokenType: extra.tokenType } : {}), ...(extra.clientId ? { clientId: extra.clientId } : {}),
      issuer: d.issuer || null, account: d.account, scopes: splitList(d.scopes, /[\s,]+/),
      accessToken: d.accessToken || null, refreshToken: d.refreshToken || null, expiresAt: d.expiresAt || null };
    origins = [];
  } else if (kind === 'recovery-codes') {
    const codes = [...new Set(splitList(d.recoveryCodes, /\r?\n/))];
    if (!codes.length) errors.recoveryCodes = 'Enter at least one code.';
    value = codes;
    origins = [];
  } else if (kind === 'passkey-reference') {
    need('website', 'A website is required.');
    need('provider', 'An authenticator provider is required.');
    value = { rpId: host(d.website), provider: d.provider, ...(extra.credentialId ? { credentialId: extra.credentialId } : {}) };
  }

  const tag = TYPE_TAG[kind];
  const groups = [...new Set([...splitList(d.groups, /,/), ...(tag ? [tag] : []), ...(extra.hiddenGroups || [])])];
  const id = editId || deriveId(d, taken, now);
  const ok = Object.keys(errors).length === 0;
  return { ok, id, errors, warnings, entry: ok ? { id, name, kind: KIND_BY_ID[kind].vault, origins, groups, notes: text(d.notes), value } : null };
}

/**
 * The draft for editing a credential: its catalog metadata and its revealed value (from the vault's reveal answer). What the
 * form does not edit (a login's other emails and phones, an OAuth client id) rides along in `_extra` and is written back.
 */
export function draftFromEntry(meta, revealed) {
  const kind = uiKind(meta);
  const value = revealed?.value;
  const data = { kind, name: meta.name || '', notes: text(revealed?.notes ?? meta.notes), groups: visibleGroups(meta.groups).join(', ') };
  const extra = {};
  const [first, ...more] = meta.origins || [];
  if (first && !['card', 'note', 'ssh-key', 'oauth', 'recovery-codes'].includes(kind)) data.website = first.replace(/^https:\/\//, '');
  if (more.length) extra.origins = more;
  const hiddenGroups = (meta.groups || []).filter((g) => g.startsWith('kind:') && g !== TYPE_TAG[kind]);
  if (hiddenGroups.length) extra.hiddenGroups = hiddenGroups;
  if (kind === 'login') {
    const names = value?.usernames || [];
    data.username = names[0] || '';
    data.password = text(value?.password);
    if (names.length > 1) extra.usernames = names.slice(1);
    if (value?.emails?.length) extra.emails = value.emails;
    if (value?.phones?.length) extra.phones = value.phones;
    if (value?.totp) extra.totp = value.totp;
  } else if (kind === 'card') {
    let card = {};
    try { card = typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { card = {}; }
    data.holder = text(card.name_on_card); data.number = text(card.number); data.exp = text(card.exp); data.cvc = text(card.cvc);
    const b = card.billing_address || {};
    data.line1 = text(b.line1); data.city = text(b.city); data.state = text(b.state); data.postal_code = text(b.postal_code); data.country = text(b.country);
    data.authorization = text(card.authorization);
    data.name = text(card.label) || meta.name || '';
    extra.card = { ...card };
    delete extra.card.number; delete extra.card.cvc;
    if (extra.card.billing_address) extra.card.billing_address = Object.fromEntries(Object.entries(extra.card.billing_address).filter(([k]) => !['line1', 'city', 'state', 'postal_code', 'country'].includes(k)));
  } else if (kind === 'secret') data.secretValue = text(value);
  else if (kind === 'note') data.noteText = text(value);
  // a verification code's secret is never handed back (reveal answers with the current code), so it cannot be edited, only replaced
  else if (kind === 'totp') data.totpSecret = '';
  else if (kind === 'ssh-key') { data.privateKey = text(value?.privateKey); data.passphrase = text(value?.passphrase); }
  else if (kind === 'oauth') {
    data.issuer = text(value?.issuer); data.account = text(value?.account); data.scopes = (value?.scopes || []).join(' ');
    data.accessToken = text(value?.accessToken); data.refreshToken = text(value?.refreshToken); data.expiresAt = text(value?.expiresAt);
    if (value?.tokenType) extra.tokenType = value.tokenType;
    if (value?.clientId) extra.clientId = value.clientId;
  } else if (kind === 'recovery-codes') data.recoveryCodes = (Array.isArray(value) ? value : []).join('\n');
  else if (kind === 'passkey-reference') { data.provider = text(value?.provider); data.website = text(value?.rpId); if (value?.credentialId) extra.credentialId = value.credentialId; }
  // an entry whose first origin is edited through `website`: keep it there, not twice
  if (Object.keys(extra).length) data._extra = JSON.stringify(extra);
  for (const key of Object.keys(data)) if (data[key] === '' && key !== 'kind') delete data[key];
  return data;
}

/** Whether the form can edit it: a verification code's secret cannot be read back, so that kind is replaced, not edited. */
export const canEdit = (meta) => uiKind(meta) !== 'totp';

/** Rows to show for a revealed value: `{ label, value, copy, secret }`. Nothing here runs until he has pressed Show. */
export function describeRevealed(meta, revealed) {
  const kind = uiKind(meta);
  const value = revealed?.value;
  const rows = [];
  const row = (label, v, opts = {}) => { if (v !== undefined && v !== null && String(v) !== '') rows.push({ label, value: String(v), copy: true, secret: false, ...opts }); };
  if (kind === 'login') {
    for (const item of value?.usernames || []) row('Username', item);
    for (const item of value?.emails || []) row('Email', item);
    for (const item of value?.phones || []) row('Phone', item);
    row('Password', value?.password, { secret: true });
  } else if (kind === 'card') {
    let card = {};
    try { card = typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { card = { raw: String(value ?? '') }; }
    row('Name on card', card.name_on_card);
    row('Number', card.number, { secret: true });
    row('Expiry', card.exp);
    row('CVC', card.cvc, { secret: true });
    const b = card.billing_address;
    const address = typeof b === 'string' ? b : [b?.line1, [b?.city, b?.state, b?.postal_code].filter(Boolean).join(' '), b?.country].filter(Boolean).join(', ');
    row('Billing', address);
    row('Authorization', card.authorization);
    row('Added', card.added);
    if (card.raw) row('Value', card.raw, { secret: true });
  } else if (kind === 'totp') row('Code', value?.code, { secret: true, big: true });
  else if (kind === 'recovery-codes') row('Codes', (value || []).join('\n'), { secret: true, block: true });
  else if (kind === 'oauth') { row('Access', value?.accessToken, { secret: true }); row('Refresh', value?.refreshToken, { secret: true }); }
  else if (kind === 'ssh-key') { row('Private key', value?.privateKey, { secret: true, block: true }); row('Passphrase', value?.passphrase, { secret: true }); }
  else if (kind === 'passkey-reference') { row('Provider', value?.provider); row('Relying party', value?.rpId); }
  else if (typeof value === 'string') row(kind === 'note' ? 'Note' : 'Value', value, { secret: true, block: true });
  else row('Value', JSON.stringify(value, null, 2), { secret: true, block: true });
  if (revealed?.notes) row('Notes', revealed.notes, { block: true });
  return rows;
}

export const subtitle = (entry) => {
  const kind = uiKind(entry);
  if (kind === 'oauth') return entry.account || entry.issuer || '';
  if (kind === 'recovery-codes') return `${entry.remaining ?? 0} unused`;
  if (kind === 'card' || kind === 'note') return KIND_BY_ID[kind].label;
  return (entry.origins || [])[0]?.replace(/^https:\/\//, '') || entry.id;
};
