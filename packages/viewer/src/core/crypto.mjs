// The linknotes cipher, in WebCrypto: runs unchanged in a browser and in Node (globalThis.crypto.subtle). Same formats as
// packages/linknotes/core/src/crypto.mjs, byte for byte (test/crypto.test.mjs feeds both one random stream and compares):
//   a box     { iv, ct, tag } base64, AES-256-GCM with a 12-byte IV and a 16-byte tag, the aad as UTF-8;
//   a sealed  { v: 1, wraps: [ { <group>: { epoch, iv, ct, tag } } per clause ], iv, ct, tag }: the data key is the XOR of one
//             32-byte share per clause, each share boxed under every group key of its clause with aad `${aad}|share${i}|${group}|${epoch}`;
//   a wrap    { eph, iv, ct, tag }: an ephemeral X25519 public key (spki DER base64), HKDF-SHA256 over the shared secret with an
//             empty salt and info `memcloud-wrap-v1|${aad}`, then a box of the group key.
// Plus what only the viewer needs: a passphrase-sealed key file and an at-rest cache box, both PBKDF2-SHA256 then AES-256-GCM.
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('WebCrypto is not available (needs a secure context: https or localhost)');
  return s;
};
const te = new TextEncoder(), td = new TextDecoder();

export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const utf8 = (s) => te.encode(String(s));
export const fromUtf8 = (b) => td.decode(b);
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const xor = (shares) => { const out = new Uint8Array(32); for (const s of shares) for (let i = 0; i < 32; i++) out[i] ^= s[i]; return out; };

export async function sha256Hex(s) {
  const d = new Uint8Array(await subtle().digest('SHA-256', typeof s === 'string' ? utf8(s) : s));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** An AES-GCM CryptoKey from raw bytes (or the key itself). Keys are cached by the caller (KeyRing). */
export const aesKey = (raw, usages = ['encrypt', 'decrypt']) => (raw instanceof Uint8Array || raw instanceof ArrayBuffer ? subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages) : raw);

export async function gcm(key, plain, aad, iv = randomBytes(12)) {
  const k = await aesKey(key);
  const out = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, k, plain));
  return { iv: b64(iv), ct: b64(out.subarray(0, out.length - 16)), tag: b64(out.subarray(out.length - 16)) };
}
export async function ungcm(key, box, aad) {
  const k = await aesKey(key);
  const ct = unb64(box.ct), tag = unb64(box.tag), both = new Uint8Array(ct.length + tag.length);
  both.set(ct); both.set(tag, ct.length);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: utf8(aad), tagLength: 128 }, k, both));
}

/**
 * Open a sealed value. keyFor(group, epoch) -> raw key bytes, a CryptoKey, a Promise of either, or null. Resolves to the
 * value, or null when some clause has no usable key. A wrong key or tampered box rejects (as the Node version throws).
 */
export async function open(sealed, aad, keyFor) {
  if (!sealed || !Array.isArray(sealed.wraps)) return null;
  const shares = [];
  for (const [i, clause] of sealed.wraps.entries()) {
    let share = null;
    for (const [group, w] of Object.entries(clause)) {
      const key = await keyFor(group, w.epoch);
      if (!key) continue;
      share = await ungcm(key, w, `${aad}|share${i}|${group}|${w.epoch}`);
      break;
    }
    if (!share) return null;
    shares.push(share);
  }
  return JSON.parse(fromUtf8(await ungcm(xor(shares), sealed, aad)));
}

/** Seal, as the Node version does. random(n) supplies every random byte (tests pass a deterministic stream). */
export async function seal(value, aad, clauses, random = randomBytes) {
  if (!clauses.length || clauses.some((c) => !c.length)) throw new Error('seal needs at least one non-empty clause');
  const shares = clauses.map(() => random(32));
  const dk = xor(shares);
  const body = await gcm(dk, utf8(JSON.stringify(value)), aad, random(12));
  const wraps = [];
  for (const [i, clause] of clauses.entries()) {
    const w = {};
    for (const { group, epoch, key } of clause) w[group] = { epoch, ...(await gcm(key, shares[i], `${aad}|share${i}|${group}|${epoch}`, random(12))) };
    wraps.push(w);
  }
  return { v: 1, wraps, ...body };
}

const WRAP_INFO = 'memcloud-wrap-v1|';
async function wrapKey(privateKey, publicKey, aad) {
  const shared = await subtle().deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(WRAP_INFO + aad) }, ikm, 256));
}
/** A group key wrapped to one device (ephemeral X25519, HKDF-SHA256, AES-256-GCM). */
export async function wrapForDevice(devicePublicKey, groupKey, aad) {
  const eph = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pub = await subtle().importKey('spki', unb64(devicePublicKey), { name: 'X25519' }, false, []);
  const k = await wrapKey(eph.privateKey, pub, aad);
  return { eph: b64(new Uint8Array(await subtle().exportKey('spki', eph.publicKey))), ...(await gcm(k, groupKey, aad)) };
}
export async function unwrapForDevice(devicePrivateKey, wrapped, aad) {
  const priv = await subtle().importKey('pkcs8', unb64(devicePrivateKey), { name: 'X25519' }, false, ['deriveBits']);
  const pub = await subtle().importKey('spki', unb64(wrapped.eph), { name: 'X25519' }, false, []);
  return ungcm(await wrapKey(priv, pub, aad), wrapped, aad);
}

// ---- passphrase boxes: the key file and the at-rest cache ----
export const KDF_ITERATIONS = 600000;
export async function passphraseKey(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle().importKey('raw', utf8(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** { v, kind, kdf: { name, hash, iterations, salt }, iv, ct, tag } around JSON `value`; aad binds the kind. */
export async function sealWithPassphrase(value, passphrase, kind, { iterations = KDF_ITERATIONS, key = null, salt = null } = {}) {
  salt = salt || randomBytes(16);
  const k = key || (await passphraseKey(passphrase, salt, iterations));
  return { v: 1, kind, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) }, ...(await gcm(k, utf8(JSON.stringify(value)), kind)) };
}
export class PassphraseError extends Error {}
export async function openWithPassphrase(box, passphrase, kind, { key = null } = {}) {
  if (!box || box.v !== 1 || box.kind !== kind || !box.kdf || box.kdf.name !== 'PBKDF2') throw new PassphraseError(`not a ${kind} file`);
  const k = key || (await passphraseKey(passphrase, unb64(box.kdf.salt), box.kdf.iterations));
  try { return JSON.parse(fromUtf8(await ungcm(k, box, kind))); } catch { throw new PassphraseError('wrong passphrase, or the file was changed'); }
}
