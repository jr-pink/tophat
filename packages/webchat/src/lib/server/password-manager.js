import { PasswordManager, TYPES, totp, generatePassword } from '../../../../runner/src/vault/manager.mjs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
export { PasswordManager, TYPES, totp, generatePassword };
const key = Symbol.for('tophat.webchat.password-managers');
const managers = globalThis[key] ||= new Map();
export function passwordManager() {
  const directory = resolve(process.env.TOPHAT_VAULT_DIR || join(homedir(), '.config/tophat/vault'));
  const keyFile = resolve(process.env.TOPHAT_VAULT_KEY_FILE || join(dirname(directory), 'vault-master-key'));
  const id = JSON.stringify([directory, keyFile]);
  if (!managers.has(id)) managers.set(id, new PasswordManager({ directory, keyFile }));
  return managers.get(id);
}
export function clearPasswordManagers() {
  for (const manager of managers.values()) manager.lock();
  managers.clear();
}
