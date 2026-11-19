import { json } from '@sveltejs/kit';
import { passwordManager, TYPES, totp } from '$lib/server/password-manager.js';
import { unavailable } from '$lib/server/vault-unavailable.js';
const options = { headers: { 'cache-control': 'private, no-store', 'pragma': 'no-cache' } };
const LIMIT = 16 * 1024 * 1024;
const IMPORTS = new Set(['chrome', 'apple', 'bitwarden', 'bitwarden-csv', '1password', '1password-csv', '1pux']);
// Everything here is safe to render: an OAuth grant's issuer, account, scopes and
// expiry are catalog metadata, and `remaining` is a count. No value passes through.
const metadata = ({id,name,kind,origins,groups,archived,updatedAt,
  issuer,account,scopes,expiresAt,hasRefreshToken,remaining}) =>
  ({id,name,kind,origins,groups,archived,updatedAt,
    issuer,account,scopes,expiresAt,hasRefreshToken,remaining});
// App authentication is enforced by hooks.server.js before this route.
export function GET({ url } = {}) {
  try {
    const manager = passwordManager();
    const status = manager.status();
    const archived = url?.searchParams.get('archived') === '1';
    return json({ entries: status.locked ? [] : manager.list({ archived }).map(metadata),
      history: status.locked ? [] : manager.history({ limit: 200 }), types: TYPES, status }, options);
  } catch (cause) { return json(unavailable(cause), { ...options, status: 503 }); }
}
async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}
function imported(result) {
  // Counts only: malformed import warnings can contain source text or passwords.
  return { imported: Number(result.imported) || 0, skipped: Number(result.skipped) || 0,
    warnings: Array.isArray(result.warnings) ? result.warnings.length : 0 };
}
export async function POST({ request }) {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required' }, { ...options, status: 403 });
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['application/json', 'application/octet-stream'].includes(contentType))
    return json({ error: 'JSON or archive upload required' }, { ...options, status: 403 });
  try {
    const bytes = await boundedBody(request);
    if (!bytes) return json({ error: 'Credential request too large' }, { ...options, status: 413 });
    const manager = passwordManager();
    if (contentType === 'application/octet-stream') {
      if (new URL(request.url).searchParams.get('format') !== '1pux') return json({ error: 'Unsupported archive format' }, { ...options, status: 400 });
      const result = await manager.importArchive(bytes);
      return json({ result: imported(result), status: manager.status() }, options);
    }
    let body;
    try { body = JSON.parse(bytes.toString('utf8')); } catch {
      if (bytes.length > 128 * 1024) return json({ error: 'Credential request too large' }, { ...options, status: 413 });
      throw new Error('Invalid request');
    }
    // Non-import requests retain a small budget; import exports have a separate bounded allowance.
    if (body.action !== 'import' && bytes.length > 128 * 1024) return json({ error: 'Credential request too large' }, { ...options, status: 413 });
    switch (body.action) {
      case 'save': return json({ entry: metadata(manager.save(body.entry, { overwrite: body.overwrite === true })) }, options);
      case 'protect': return json({ status: manager.protect(body.passphrase) }, options);
      case 'unlock': return json({ status: manager.unlock(body.passphrase, { ttlMs: body.ttlMs ?? 15 * 60 * 1000 }) }, options);
      case 'lock': manager.lock(); return json({ status: manager.status() }, options);
      case 'archive': return json({ entry: metadata(manager.archive(body.id, body.archived !== false)) }, options);
      case 'groups': return json({ entry: metadata(manager.groups(body.id, body.groups)) }, options);
      case 'forget': return json({ forgotten: manager.forget(body.id) }, options);
      // The log is metadata by construction, so it is the one read here that
      // carries no risk of returning a secret.
      case 'history': return json({ history: manager.history({ id: body.id || null, limit: 200 }) }, options);
      // A password manager that cannot show a password is a filing cabinet. This
      // is the only route that returns a stored value, and it does so for one
      // entry at a time, on an explicit click, behind the same passkey gate as
      // the rest of the page, with no-store set on the response.
      case 'reveal': {
        const entry = manager.entry(manager.catalog(), body.id);
        const value = manager.value(entry);
        if (entry.kind === 'totp') {
          const code = totp(value);
          return json({ id: entry.id, kind: entry.kind,
            value: { code: code.code, expiresAt: new Date(code.expiresAt).toISOString() } }, options);
        }
        // notes ride with the value: they are free text he may have put a secret in, so they come back only here, behind the click
        return json({ id: entry.id, kind: entry.kind, value, notes: entry.notes || '' }, options);
      }
      case 'import': {
        if (!IMPORTS.has(body.format) || body.format === '1pux' || typeof body.text !== 'string') return json({ error: 'Unsupported import format' }, { ...options, status: 400 });
        return json({ result: imported(manager.import(body.format, body.text)), status: manager.status() }, options);
      }
      default: return json({ error: 'Unknown action' }, { ...options, status: 400 });
    }
  } catch (cause) {
    // A validation failure says which field is wrong (fixed strings, never a
    // value); anything else stays generic because it may quote input.
    const error = cause?.expose === true && typeof cause.message === 'string' ? cause.message
      : 'Vault operation failed. Check the fields, unlock state and replacement setting.';
    return json({ error }, { ...options, status: 400 });
  }
}
