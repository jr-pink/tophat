// One identity per intent (DOCSTORE3-DESIGN.md axiom A7): a ULID minted once, written to the durable outbox
// before any network attempt, and reused as both the log identity (`action_id`) and the idempotency key on
// every retry, restart and replay. A server that keeps an applied-action receipt (webchat's /api/actions does)
// answers a repeated id with what it already produced, so a retry can never double-apply.
//
// Monotonic within one engine: two ids minted in the same millisecond sort in mint order, so ordering an
// outbox by id is ordering it by intent.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n) {
  const out = new Uint8Array(n);
  try { globalThis.crypto.getRandomValues(out); } catch { for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256); }
  return out;
}

function encodeTime(ms) {
  let out = '';
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) { out = ALPHABET[t % 32] + out; t = Math.floor(t / 32); }
  return out;
}

/** A ULID factory; `now` and `random` are injectable so tests are deterministic. */
export function ulidFactory({ now = () => Date.now(), random = randomBytes } = {}) {
  let lastTime = -1;
  let lastRandom = null; // 16 base-32 digits as numbers
  return function ulid() {
    const t = now();
    if (t <= lastTime && lastRandom) {
      // Same (or a backwards) millisecond: increment the random part, keep the time, stay monotonic.
      for (let i = lastRandom.length - 1; i >= 0; i--) {
        if (lastRandom[i] < 31) { lastRandom[i] += 1; break; }
        lastRandom[i] = 0;
      }
    } else {
      lastTime = t;
      const bytes = random(16);
      lastRandom = Array.from(bytes, (b) => b % 32);
    }
    return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join('');
  };
}

export const ulid = ulidFactory();

export const isUlid = (value) => typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value);
