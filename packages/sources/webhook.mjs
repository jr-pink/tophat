// The webhook receiver: other machines POST records here and they land in a spool directory the jsonl adapter reads.
//   POST /v1/records/<sourceId>   Authorization: Bearer <token>   body {"records": [<jsonl record>...]}
// Tokens are configured as sha256 digests bound to one source id (config.tokens: [{sha256, source}]), never stored in
// plaintext. Each accepted batch is written to <spool>/<sourceId>/<time>-<random>.jsonl by temp+rename, so the reader
// never sees a partial file and two receivers never contend (lockless). Validation is the jsonl adapter's own.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lineRecord } from './adapters/jsonl.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export class WebhookError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

export function authorize(tokens, authorization, sourceId) {
  const m = /^Bearer (\S{16,})$/.exec(String(authorization || ''));
  if (!m) throw new WebhookError(401, 'unauthenticated');
  const want = Buffer.from(sha(m[1]));
  const hit = (tokens || []).find((t) => { const got = Buffer.from(String(t.sha256)); return got.length === want.length && timingSafeEqual(got, want); });
  if (!hit) throw new WebhookError(401, 'unauthenticated');
  if (hit.source !== sourceId) throw new WebhookError(403, 'token_not_for_this_source');
}

/** Validate and spool one batch; returns {accepted, file}. */
export function accept({ spool, tokens }, sourceId, authorization, raw) {
  if (!SOURCE.test(sourceId || '')) throw new WebhookError(404, 'not_found');
  authorize(tokens, authorization, sourceId);
  if (Buffer.byteLength(raw) > MAX_BATCH_BYTES) throw new WebhookError(413, 'batch_too_large');
  let body; try { body = JSON.parse(raw); } catch { throw new WebhookError(400, 'invalid_json'); }
  if (!body || !Array.isArray(body.records) || !body.records.length || body.records.length > 10000) throw new WebhookError(400, 'invalid_records');
  body.records.forEach((r, i) => { try { lineRecord(r, { file: 'webhook', offset: i }); } catch { throw new WebhookError(422, `invalid_record_${i}`); } });
  const dir = path.join(spool, sourceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}.jsonl`;
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, body.records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
  return { accepted: body.records.length, file: path.join(sourceId, name) };
}

export function listen({ spool, tokens, port, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BATCH_BYTES) { req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      let status = 200, out;
      try {
        const m = /^\/v1\/records\/([^/?]+)$/.exec(new URL(req.url, 'http://x').pathname);
        if (req.method === 'GET' && req.url === '/healthz') out = { ok: true, service: 'tophat-webhook' };
        else if (!m) throw new WebhookError(404, 'not_found');
        else if (req.method !== 'POST') throw new WebhookError(405, 'method_not_allowed');
        else out = { ok: true, ...accept({ spool, tokens }, m[1], req.headers.authorization, Buffer.concat(chunks).toString('utf8')) };
      } catch (e) { status = e.status || 500; out = { error: e.code || 'internal_error' }; }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(port, host, () => r(server)));
}
export const tokenDigest = sha;
