// Beeper Desktop Client API: the one helper that asks Beeper to fetch an attachment it has not
// downloaded yet. Beeper's local media cache (BeeperTexts/media/<host>/<id>) only holds what the app
// happened to load; POST /v1/assets/download {url: "mxc://..."} makes Beeper fetch and decrypt the
// asset on demand and answers {srcURL: "file:///.../BeeperTexts/media/..."}, after which the bytes are
// on disk. Shared by read_document (rev5/attachments.mjs, rev6/tools/runner/attachments.mjs) and `tophat-msg attachment` (tools/msg-tool.mjs).
//
// The bearer token never leaves this module: it is not returned, logged or put into an error message.
//
//   TOPHAT_BEEPER_API          Client API base; default http://localhost:23373 (loopback only)
//   TOPHAT_BEEPER_TOKEN_FILE   explicit token file; otherwise the tophat vault name `beeper-token`, or the
//                             than the vault copy or the vault does not hold it.
//
// That last sentence is a RULE, not this module's code: src/vault/named-secret.mjs owns it as `namedSecretValue`, and rev6/base/secrets.mjs
// resolves every other name through the same function.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedSecretValue } from '../vault/named-secret.mjs';

export const BEEPER_API_DEFAULT = '';
export const ASSET_DOWNLOAD_MS = 15_000;

export function beeperApiBase(env = process.env) {
  const base = String(env.TOPHAT_BEEPER_API || BEEPER_API_DEFAULT).replace(/\/+$/, '');
  const host = (() => { try { return new URL(base).hostname; } catch { return ''; } })();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) throw new Error(`Beeper API base ${base} is not loopback`);
  return base;
}

const readTrim = (path) => { try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; } };

/** The Client API bearer token, or null. Never printed by anything in this module. */
export function beeperApiToken(env = process.env) {
  if (env.TOPHAT_BEEPER_TOKEN_FILE) return readTrim(env.TOPHAT_BEEPER_TOKEN_FILE);
  const home = env.HOME || homedir();
  const directory = env.TOPHAT_VAULT_DIR || join(home, '.config', 'tophat', 'vault');
  const { value } = namedSecretValue('beeper-token', {
    dirs: [],
    directory,
    keyFile: env.TOPHAT_VAULT_KEY_FILE || join(dirname(directory), 'vault-master-key'),
  });
  return String(value ?? '').trim() || null;
}

const scrub = (text, token) => (token ? String(text).split(token).join('[token]') : String(text));

/**
 * Ask Beeper to download one asset and return the local file it wrote. `url` is the attachment's
 * srcURL (it may carry Beeper's decryption info in its query, which the API needs) or bare mxc id.
 * With `mediaDir`, the returned file must resolve inside it. Throws an Error whose message is safe to
 * show (no token, no decryption material).
 */
export async function beeperDownloadAsset(url, { env = process.env, fetchImpl = fetch, timeoutMs = ASSET_DOWNLOAD_MS, mediaDir = null, token = beeperApiToken(env) } = {}) {
  if (!/^mxc:\/\//.test(String(url || ''))) throw new Error('not an mxc:// url');
  if (!token) throw new Error('no Beeper API token (vault/keyring name beeper-token)');
  const base = beeperApiBase(env);
  let res, text;
  try {
    res = await fetchImpl(`${base}/v1/assets/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await res.text();
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : (error?.cause?.code || error?.message || String(error));
    throw new Error(`Beeper API ${base} unreachable: ${scrub(reason, token).slice(0, 160)}`);
  }
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = scrub(body?.message || body?.error || text || '', token).replace(/encryptedFileInfoJSON=[^\s"&]*/g, 'encryptedFileInfoJSON=[redacted]');
    throw new Error(`Beeper API assets/download HTTP ${res.status}: ${detail.slice(0, 160)}`);
  }
  const src = body?.srcURL;
  if (typeof src !== 'string' || !src.startsWith('file://')) throw new Error(`Beeper API assets/download returned no file srcURL${body?.error ? `: ${scrub(body.error, token).slice(0, 120)}` : ''}`);
  let path;
  try { path = realpathSync(fileURLToPath(src)); } catch { throw new Error('Beeper API reported a downloaded file that is not on disk'); }
  if (mediaDir) {
    let root;
    try { root = realpathSync(mediaDir); } catch { root = mediaDir; }
    if (path !== root && !path.startsWith(root + sep)) throw new Error('Beeper API returned a file outside the Beeper media cache; refused');
  }
  return { path };
}
