// Content keys. A part is sealed under a fresh data key; the data key reaches a reader only
// through a group key, and a group key reaches a device only wrapped to that device's X25519
// public key. The hub stores parts and wrapped keys and can open neither.
import crypto from 'node:crypto';

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

export function deviceKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}
export const newGroupKey = () => crypto.randomBytes(32);

function gcm(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}
function ungcm(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv)); d.setAAD(Buffer.from(aad)); d.setAuthTag(unb64(box.tag));
  return Buffer.concat([d.update(unb64(box.ct)), d.final()]);
}

/** Wrap a group key to one device: ephemeral X25519, HKDF-SHA256, AES-256-GCM. */
export function wrapForDevice(devicePublicKey, groupKey, aad) {
  const eph = crypto.generateKeyPairSync('x25519');
  const pub = crypto.createPublicKey({ key: unb64(devicePublicKey), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const k = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('memcloud-wrap-v1|' + aad), 32));
  return { eph: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), ...gcm(k, groupKey, aad) };
}
export function unwrapForDevice(devicePrivateKey, wrapped, aad) {
  const priv = crypto.createPrivateKey({ key: unb64(devicePrivateKey), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: unb64(wrapped.eph), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const k = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('memcloud-wrap-v1|' + aad), 32));
  return ungcm(k, wrapped, aad);
}

/**
 * Seal `value` for a CNF of groups: `clauses` is a list of clauses, each a list of
 * `{ group, epoch, key }`. A reader must hold a key from every clause. One clause is the
 * ordinary ACL (any one group suffices). The data key is the XOR of one share per clause, and
 * each share is wrapped under every group key of its clause.
 */
export function seal(value, aad, clauses) {
  if (!clauses.length || clauses.some((c) => !c.length)) throw new Error('seal needs at least one non-empty clause');
  const shares = clauses.map(() => crypto.randomBytes(32));
  const dk = shares.reduce((a, s) => Buffer.from(a.map((x, i) => x ^ s[i])), Buffer.alloc(32));
  const body = gcm(dk, Buffer.from(JSON.stringify(value)), aad);
  const wraps = clauses.map((clause, i) => Object.fromEntries(clause.map(({ group, epoch, key }) => [group, { epoch, ...gcm(key, shares[i], `${aad}|share${i}|${group}|${epoch}`) }])));
  return { v: 1, wraps, ...body };
}

/** Open a sealed value with `keyFor(group, epoch)` (a Buffer or null). Null when any clause has no usable key. */
export function open(sealed, aad, keyFor) {
  const shares = [];
  for (const [i, clause] of sealed.wraps.entries()) {
    let share = null;
    for (const [group, w] of Object.entries(clause)) {
      const key = keyFor(group, w.epoch);
      if (!key) continue;
      share = ungcm(key, w, `${aad}|share${i}|${group}|${w.epoch}`);
      break;
    }
    if (!share) return null;
    shares.push(share);
  }
  const dk = shares.reduce((a, s) => Buffer.from(a.map((x, i) => x ^ s[i])), Buffer.alloc(32));
  return JSON.parse(ungcm(dk, sealed, aad).toString());
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
