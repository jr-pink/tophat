// @tophat-md/linknotes public entry. open(config) returns a MemoryStore (see ./interface.mjs for the method contract).
//   { backend: 'sqlite', file, user, device, writeScopes, keyFile?, hub?: { url, tokenFile }, screens?, people?|peopleFile? }
// sqlite is the one backend: a local replica, end-to-end encrypted; the optional hub it syncs through holds ciphertext only.
import { readFileSync } from 'node:fs';
import { SqliteBackend } from './sqlite.mjs';
import { StoreError } from './replica.mjs';

export { SqliteBackend, StoreError };
export { METHODS, KINDS } from './interface.mjs';
export { Hub, issueToken, verifyToken } from '../core/src/hub.mjs';
export { localTransport, httpTransport } from '../core/src/sync.mjs';
export { createStoreFile, ensureDeviceKey } from './replica.mjs';

/** Backends by name: a plugin registry, so another package can add one (registerBackend('postgres', cfg => ...)). */
const BACKENDS = new Map([['sqlite', (c, deps) => new SqliteBackend(c, deps)]]);
export function registerBackend(name, factory) { BACKENDS.set(name, factory); }

/** @returns {Promise<import('./interface.mjs').MemoryStore>} */
export async function open(config, deps = {}) {
  if (typeof config === 'string') config = JSON.parse(readFileSync(config, 'utf8'));
  const make = BACKENDS.get(config?.backend);
  if (!make) throw new StoreError(`config.backend must be one of ${[...BACKENDS.keys()].join(', ')}`);
  return make(config, deps);
}
