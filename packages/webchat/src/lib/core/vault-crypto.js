// The vault's crypto in the browser: the same sealed records this Mac writes, opened and written
// with WebCrypto so an enrolled device can read every credential with the server unreachable.
//
// The Mac is the server; a device holds the same ciphertext, re-sealed under a per-device key, and
// never holds plaintext at rest.
//
// The one easy bug this file exists to prevent: node's sealRecord (src/vault/manager.mjs) writes
//     AV01 | nonce(12) | tag(16) | ciphertext
// while WebCrypto's AES-GCM takes and returns ciphertext || tag. So opening splits the tag off the
// front and appends it, and sealing splits it off the back and moves it forward. Parity with node
// in both directions is pinned by vault-crypto.test.js.
//
// Nothing here touches storage or the network, and nothing here logs: a key or a value that
// reaches a console or a disk is the failure this whole feature is supposed to avoid.

export const RECORD_HEADER = 'AV01';
const HEADER_BYTES = new Uint8Array([0x41, 0x56, 0x30, 0x31]); // "AV01"
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const VALUE_NAME = /^value-[0-9a-f]{32}$/u;
/** PBKDF2 rounds for the passphrase branch. */
export const WRAP_ITERATIONS = 600_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const utf8 = (text) => textEncoder.encode(String(text));
export const fromUtf8 = (bytes) => textDecoder.decode(asBytes(bytes));

/** Anything byte-shaped (Uint8Array, ArrayBuffer, Buffer, number array) as a Uint8Array view. */
export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('Expected bytes');
}

export function toBase64(value) {
  const bytes = asBytes(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text ?? ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export const toHex = (value) => [...asBytes(value)].map((b) => b.toString(16).padStart(2, '0')).join('');

const cryptoOf = (override) => override || globalThis.crypto;
const subtleOf = (override) => {
  const c = cryptoOf(override);
  if (!c?.subtle) throw new Error('WebCrypto is not available here');
  return c.subtle;
};

export function randomBytes(length, crypto = globalThis.crypto) {
  const out = new Uint8Array(length);
  cryptoOf(crypto).getRandomValues(out);
  return out;
}

/** A fresh value record name, the same shape the Mac mints: value-<32 hex>. */
export const newValueName = (crypto = globalThis.crypto) => `value-${toHex(randomBytes(16, crypto))}`;

/** The additional data every record is bound to, so a record cannot be replayed under another name. */
export const recordAad = (name) => utf8(`tophat:${name}`);

/**
 * Import a 32-byte device key. Non-extractable by default and the caller's bytes are zeroed here,
 * so the raw key exists only for the moment between the network and the key store.
 */
export async function importDeviceKey(raw, { extractable = false, crypto } = {}) {
  const bytes = asBytes(raw);
  if (bytes.length !== 32) throw new Error('A vault device key is 32 bytes');
  try {
    return await subtleOf(crypto).importKey('raw', bytes, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

/** AV01 | nonce | tag | ciphertext, byte-identical in shape to node's sealRecord. */
export async function sealRecord(key, name, text, { crypto, nonce } = {}) {
  const iv = nonce ? asBytes(nonce) : randomBytes(NONCE_BYTES, crypto);
  const sealed = new Uint8Array(await subtleOf(crypto).encrypt(
    { name: 'AES-GCM', iv, additionalData: recordAad(name), tagLength: TAG_BYTES * 8 }, key, utf8(text)));
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const out = new Uint8Array(4 + NONCE_BYTES + TAG_BYTES + ciphertext.length);
  out.set(HEADER_BYTES, 0);
  out.set(iv, 4);
  out.set(tag, 4 + NONCE_BYTES);
  out.set(ciphertext, 4 + NONCE_BYTES + TAG_BYTES);
  return out;
}

/** The record's text. A wrong key, a wrong name or a flipped byte all fail the same way. */
export async function openRecord(key, name, record, { crypto } = {}) {
  const bytes = asBytes(record);
  if (bytes.length < 4 + NONCE_BYTES + TAG_BYTES || !HEADER_BYTES.every((b, i) => bytes[i] === b))
    throw new Error('Vault integrity check failed');
  const iv = bytes.subarray(4, 4 + NONCE_BYTES);
  const tag = bytes.subarray(4 + NONCE_BYTES, 4 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(4 + NONCE_BYTES + TAG_BYTES);
  const joined = new Uint8Array(ciphertext.length + TAG_BYTES);
  joined.set(ciphertext, 0);
  joined.set(tag, ciphertext.length);
  let plain;
  try {
    plain = new Uint8Array(await subtleOf(crypto).decrypt(
      { name: 'AES-GCM', iv, additionalData: recordAad(name), tagLength: TAG_BYTES * 8 }, key, joined));
  } catch {
    throw new Error('Vault integrity check failed');
  }
  const text = fromUtf8(plain);
  plain.fill(0);
  return text;
}

export const sealJson = (key, name, value, options) => sealRecord(key, name, JSON.stringify(value), options);
export async function openJson(key, name, record, options) {
  const text = await openRecord(key, name, record, options);
  try { return JSON.parse(text); } catch { throw new Error('Vault integrity check failed'); }
}

// --- the passphrase branch (dormant while the vault is owner-only-local-file) ---------------------

/** PBKDF2-SHA256 over his vault passphrase, for wrapping the device key at rest. */
export async function deriveWrapKey(passphrase, salt, { iterations = WRAP_ITERATIONS, crypto } = {}) {
  const subtle = subtleOf(crypto);
  const material = await subtle.importKey('raw', utf8(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt: asBytes(salt), iterations, hash: 'SHA-256' },
    material, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

/**
 * Wrap raw device-key bytes under the passphrase key. The raw bytes are zeroed on the way out and
 * the extractable import made to wrap them never leaves this function.
 */
export async function wrapDeviceKey(raw, wrapKey, { crypto } = {}) {
  const subtle = subtleOf(crypto);
  const bytes = asBytes(raw);
  let temporary;
  try {
    temporary = await subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    return new Uint8Array(await subtle.wrapKey('raw', temporary, wrapKey, 'AES-KW'));
  } finally {
    bytes.fill(0);
  }
}

/** Back to a non-extractable device key, without the raw bytes ever existing in page memory. */
export function unwrapDeviceKey(wrapped, wrapKey, { crypto } = {}) {
  return subtleOf(crypto).unwrapKey('raw', asBytes(wrapped), wrapKey, 'AES-KW',
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// --- TOTP, so a verification code works on a plane ------------------------------------------------
// A port of src/vault/values.mjs totp/parseTotp with WebCrypto HMAC in place of node's. Parity for
// SHA-1, SHA-256, SHA-512, 6 and 8 digits and otpauth:// URIs is pinned by the test beside this.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const need = (ok, message) => { if (!ok) throw new Error(message); };

export function decodeBase32(value) {
  need(typeof value === 'string', 'TOTP secret required');
  const normalized = value.toUpperCase().replace(/[\s-]/gu, '').replace(/=+$/u, '');
  need(/^[A-Z2-7]+$/u.test(normalized), 'Invalid base32 TOTP secret');
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const char of normalized) {
    accumulator = (accumulator << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  need(bytes.length >= 10 && (bits === 0 || (accumulator & ((1 << bits) - 1)) === 0), 'Invalid TOTP secret length or padding');
  return Uint8Array.from(bytes);
}

export function parseTotp(input) {
  let spec = input;
  if (typeof input === 'string' && input.startsWith('otpauth://')) {
    let url;
    try { url = new URL(input); } catch { throw new Error('Invalid OTP URI'); }
    need(url.hostname === 'totp', 'Only time-based OTP URIs supported');
    const parameter = (name) => url.searchParams.get(name);
    spec = { secret: parameter('secret'), algorithm: parameter('algorithm') || 'SHA1',
      digits: Number(parameter('digits') || 6), period: Number(parameter('period') || 30) };
  } else if (typeof input === 'string') spec = { secret: input };
  const normalized = { secret: spec?.secret, algorithm: String(spec?.algorithm || 'SHA1').toUpperCase(),
    digits: spec?.digits ?? 6, period: spec?.period ?? 30 };
  need(['SHA1', 'SHA256', 'SHA512'].includes(normalized.algorithm), 'Unsupported TOTP algorithm');
  need([6, 8].includes(normalized.digits) && Number.isInteger(normalized.period)
    && normalized.period >= 15 && normalized.period <= 120, 'Invalid TOTP digits or period');
  decodeBase32(normalized.secret).fill(0);
  normalized.secret = normalized.secret.toUpperCase().replace(/[\s-]/gu, '').replace(/=+$/u, '');
  return normalized;
}

const HASH = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** The code on the screen right now, and when it turns over. Same answer as the Mac's totp(). */
export async function totp(input, now = Date.now(), { crypto } = {}) {
  const spec = parseTotp(input);
  need(Number.isSafeInteger(now) && now >= 0, 'Invalid OTP timestamp');
  const step = Math.floor(now / 1000 / spec.period);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
  const secret = decodeBase32(spec.secret);
  let digest;
  try {
    const key = await subtleOf(crypto).importKey('raw', secret, { name: 'HMAC', hash: HASH[spec.algorithm] }, false, ['sign']);
    digest = new Uint8Array(await subtleOf(crypto).sign('HMAC', key, counter));
  } finally {
    secret.fill(0);
  }
  const offset = digest[digest.length - 1] & 15;
  const truncated = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(offset, false) & 0x7fffffff;
  const code = String(truncated % 10 ** spec.digits).padStart(spec.digits, '0');
  digest.fill(0);
  return { code, expiresAt: (step + 1) * spec.period * 1000 };
}
