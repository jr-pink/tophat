// Secrets for adapters: never in code, never in argv. A credential reference is resolved, in order, as
//   1. an absolute file path (read, trimmed),
//   2. the environment variable LINKNOTES_SECRET_<NAME> (name upper-cased, non-alphanumerics as _),
//   3. a file <LINKNOTES_SECRETS_DIR>/<name> (default ~/.config/linknotes/secrets/<name>).
// Returns null when none holds it; callers fail with a coded error naming the reference, never the value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const secretsDir = (env = process.env) => env.LINKNOTES_SECRETS_DIR || path.join(os.homedir(), '.config/linknotes/secrets');
export function readSecret(ref, { env = process.env } = {}) {
  if (typeof ref !== 'string' || !ref) return null;
  if (path.isAbsolute(ref)) { try { return fs.readFileSync(ref, 'utf8').trim() || null; } catch { return null; } }
  if (!VALID.test(ref)) return null;
  const v = env[`LINKNOTES_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (v) return v;
  try { return fs.readFileSync(path.join(secretsDir(env), ref), 'utf8').trim() || null; } catch { return null; }
}
