import { createHmac, randomInt } from 'node:crypto';
export const TYPES = ['login', 'totp', 'recovery-codes', 'ssh-key', 'passkey-reference', 'oauth', 'secret'];
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CATALOG = 'password-manager-catalog';
// Validation failures are fixed strings (at most a field name), never a value,
// so they are marked safe to show the person who submitted the form.
export const invalid = (message) => Object.assign(new Error(message), { expose: true });
const required = (ok, message) => { if (!ok) throw invalid(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, names) => record(value) && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const validId = value => typeof value === 'string' && ID.test(value);
export function originOf(value) {
  required(typeof value === 'string' && value.length <= 4096 && !/[\x00-\x20\x7f]/u.test(value), 'Invalid website URL');
  let url; try { url = new URL(value); } catch { throw new Error('Invalid website URL'); }
  required(url.protocol === 'https:' && !url.username && !url.password, 'Website must use HTTPS without embedded credentials');
  return url.origin;
}
function decodeBase32(value) {
  required(typeof value === 'string', 'TOTP secret required');
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  required(/^[A-Z2-7]+$/.test(normalized), 'Invalid base32 TOTP secret');
  let bits = 0, accumulator = 0; const bytes = [];
  for (const char of normalized) {
    accumulator = (accumulator << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  required(bytes.length >= 10 && (bits === 0 || (accumulator & ((1 << bits) - 1)) === 0), 'Invalid TOTP secret length or padding');
  return Buffer.from(bytes);
}
export function parseTotp(input) {
  let spec = input;
  if (typeof input === 'string' && input.startsWith('otpauth://')) {
    let url; try { url = new URL(input); } catch { throw new Error('Invalid OTP URI'); }
    required(url.hostname === 'totp', 'Only time-based OTP URIs supported');
    const parameter = (name) => url.searchParams.get(name);
    spec = { secret: parameter('secret'), algorithm: parameter('algorithm') || 'SHA1',
      digits: Number(parameter('digits') || 6), period: Number(parameter('period') || 30) };
  } else if (typeof input === 'string') spec = { secret: input };
  const normalized = { secret: spec?.secret, algorithm: String(spec?.algorithm || 'SHA1').toUpperCase(), digits: spec?.digits ?? 6, period: spec?.period ?? 30 };
  required(['SHA1', 'SHA256', 'SHA512'].includes(normalized.algorithm), 'Unsupported TOTP algorithm');
  required([6, 8].includes(normalized.digits) && Number.isInteger(normalized.period) && normalized.period >= 15 && normalized.period <= 120, 'Invalid TOTP digits or period');
  decodeBase32(normalized.secret).fill(0);
  normalized.secret = normalized.secret.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  return normalized;
}
export function totp(input, now = Date.now()) {
  const spec = parseTotp(input);
  required(Number.isSafeInteger(now) && now >= 0, 'Invalid OTP timestamp');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / spec.period)));
  const key = decodeBase32(spec.secret);
  try {
    const hash = createHmac(spec.algorithm.toLowerCase(), key).update(counter).digest();
    const offset = hash.at(-1) & 15;
    const code = String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** spec.digits).padStart(spec.digits, '0');
    return { code, expiresAt: (Math.floor(now / 1000 / spec.period) + 1) * spec.period * 1000 };
  } finally { key.fill(0); }
}
// A manager that cannot make a password sends people back to reusing one. Uniform
// over an unambiguous alphabet: no character-class rules, which shrink the search
// space more than they add at these lengths. Easy to read aloud and type by hand;
// about 87 bits. An explicit length keeps the old dense form.
export function generatePassword(length) {
  if (length === undefined) {
    const lower = 'abcdefghijkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit = '23456789';
    const chars = Array.from({ length: 18 }, () => lower[randomInt(lower.length)]);
    const capital = randomInt(18);
    let number = randomInt(18);
    while (number === capital) number = randomInt(18);
    chars[capital] = upper[randomInt(upper.length)];
    chars[number] = digit[randomInt(digit.length)];
    return [0, 6, 12].map((i) => chars.slice(i, i + 6).join('')).join('-');
  }
  required(Number.isInteger(length) && length >= 12 && length <= 128, 'Password length must be 12 to 128 characters');
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}
export function normalizeValue(kind, value) {
  required(TYPES.includes(kind), 'Unsupported credential type');
  if (kind === 'login') {
    // One account, many ways to sign in: handles, emails and phone numbers all
    // belong to one record. A legacy single `username` is accepted as input and
    // folded into `usernames`; it is never stored.
    required(record(value) && typeof value.password === 'string' && value.password.length > 0, 'Login password required');
    const list = (name, fix = (x) => x) => {
      const raw = value[name] === undefined ? [] : value[name];
      required(Array.isArray(raw) && raw.length <= 50 && raw.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 320), `Invalid ${name}`);
      return [...new Set(raw.map((item) => fix(item.trim())))];
    };
    required(value.username === undefined || typeof value.username === 'string', 'Invalid username');
    const usernames = [...new Set([...(value.username?.trim() ? [value.username.trim()] : []), ...list('usernames')])];
    const out = { usernames, emails: list('emails', (item) => item.toLowerCase()),
      phones: list('phones', (item) => item.replace(/[\s().-]/g, '')), password: value.password };
    if (value.totp !== undefined && value.totp !== null && value.totp !== '') out.totp = parseTotp(value.totp);
    return out;
  }
  if (kind === 'totp') return parseTotp(value);
  if (kind === 'recovery-codes') {
    required(Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim()) && new Set(value).size === value.length, 'Unique nonempty recovery codes required');
    return value;
  }
  if (kind === 'ssh-key') {
    required(typeof value?.privateKey === 'string' && /^-----BEGIN (?:OPENSSH|RSA|EC|PRIVATE|ENCRYPTED PRIVATE).*KEY-----/m.test(value.privateKey), 'SSH private key required');
    required(value.passphrase === undefined || typeof value.passphrase === 'string', 'Invalid key passphrase');
    return { privateKey: value.privateKey, passphrase: value.passphrase || '' };
  }
  if (kind === 'passkey-reference') {
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    const host = typeof value?.rpId === 'string' && value.rpId.length <= 253
      && value.rpId.split('.').every((part) => label.test(part));
    const provider = typeof value?.provider === 'string'
      && value.provider.trim().length > 0 && value.provider.length <= 120;
    required(host && provider, 'Passkey relying party and authenticator provider required');
    required(!Object.hasOwn(value, 'privateKey'), 'This manager stores platform passkey references, not exportable authenticator keys');
    required(value.credentialId == null || (typeof value.credentialId === 'string' && value.credentialId.length <= 4096), 'Invalid passkey credential reference');
    return { rpId: value.rpId, provider: value.provider, credentialId: value.credentialId || null };
  }
  if (kind === 'oauth') {
    // An OAuth grant is not a password: what goes wrong with it is an expiry, a
    // missing scope or the wrong account, and none of that is answerable while the
    // grant is an opaque JSON blob. The issuer, account, scopes and expiry are
    // structured so they can be read and compared without decrypting a token.
    required(record(value), 'OAuth credential requires issuer, account and a token');
    required(typeof value.issuer === 'string' && value.issuer.trim().length > 0 && value.issuer.length <= 200, 'OAuth issuer required');
    required(typeof value.account === 'string' && value.account.trim().length > 0 && value.account.length <= 320, 'OAuth account required');
    const scopes = value.scopes === undefined ? [] : value.scopes;
    required(Array.isArray(scopes) && scopes.length <= 200
      && scopes.every((scope) => typeof scope === 'string' && scope.trim().length > 0 && scope.length <= 300), 'Invalid OAuth scopes');
    const token = (name) => {
      if (value[name] === undefined || value[name] === null) return null;
      required(typeof value[name] === 'string' && value[name].length > 0 && value[name].length <= 65536, `Invalid OAuth ${name}`);
      return value[name];
    };
    const accessToken = token('accessToken'), refreshToken = token('refreshToken');
    required(accessToken || refreshToken, 'OAuth access or refresh token required');
    const text = (name, limit) => {
      if (value[name] === undefined || value[name] === null || value[name] === '') return null;
      required(typeof value[name] === 'string' && value[name].length <= limit, `Invalid OAuth ${name}`);
      return value[name];
    };
    let expiresAt = null;
    if (value.expiresAt !== undefined && value.expiresAt !== null && value.expiresAt !== '') {
      const at = typeof value.expiresAt === 'number' ? new Date(value.expiresAt) : new Date(String(value.expiresAt));
      required(!Number.isNaN(at.getTime()), 'Invalid OAuth expiry');
      expiresAt = at.toISOString();
    }
    return {issuer: value.issuer.trim(), account: value.account.trim(),
      scopes: [...new Set(scopes.map((scope) => scope.trim()))].sort(),
      accessToken, refreshToken, tokenType: text('tokenType', 40) || 'Bearer',
      clientId: text('clientId', 400), expiresAt};
  }
  required(typeof value === 'string' && value.length > 0, 'Secret value required');
  return value;
}
