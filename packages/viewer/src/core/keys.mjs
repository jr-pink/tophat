// The viewer's key file and its at-rest cache, both sealed under a passphrase (PBKDF2-SHA256, AES-256-GCM; ./crypto.mjs).
// Key file payload: { v: 1, user, scopes: { <scope>: { <epoch>: base64 key } }, keyDevice?, devicePrivateKey?, exported_at }.
//   scopes            the scope keys a replica of `user` holds (exported with `tophat-viewer export-keys`);
//   keyDevice + devicePrivateKey   optional: a device of `user` the scope admins wrap keys to; with it the viewer also
//                     unwraps keys published after the export (a rotation, a new scope) from the log's mc_keys rows.
// The hub never sees this file, the passphrase, or anything derived from them.
import { openWithPassphrase, sealWithPassphrase, passphraseKey, unb64, randomBytes, b64, KDF_ITERATIONS } from './crypto.mjs';

export const KEYFILE_KIND = 'tophat-viewer-keyfile';
export const CACHE_KIND = 'tophat-viewer-cache';

export async function writeKeyFile(payload, passphrase, opts = {}) {
  if (!payload || typeof payload.user !== 'string' || !payload.scopes) throw new Error('key file needs user and scopes');
  if (!passphrase || String(passphrase).length < 8) throw new Error('passphrase must be at least 8 characters');
  return sealWithPassphrase({ v: 1, ...payload }, passphrase, KEYFILE_KIND, opts);
}
/** text: the key file's JSON. Returns the payload; throws PassphraseError on a wrong passphrase. */
export async function readKeyFile(text, passphrase) {
  let box; try { box = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('the key file is not JSON'); }
  const p = await openWithPassphrase(box, passphrase, KEYFILE_KIND);
  if (!p || p.v !== 1 || typeof p.user !== 'string' || typeof p.scopes !== 'object') throw new Error('the key file holds no keys');
  return p;
}

/** A cache key from the passphrase: { key, salt } (a fresh salt unless one is given). */
export async function cacheKey(passphrase, salt = null, iterations = KDF_ITERATIONS) {
  salt = salt ? (typeof salt === 'string' ? unb64(salt) : salt) : randomBytes(16);
  return { key: await passphraseKey(passphrase, salt, iterations), salt: b64(salt), iterations };
}
export const sealCache = (value, ck) => sealWithPassphrase(value, null, CACHE_KIND, { key: ck.key, salt: unb64(ck.salt), iterations: ck.iterations });
export const openCache = (box, ck) => openWithPassphrase(box, null, CACHE_KIND, { key: ck.key });
