import { json } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { app } from '$lib/server/app.js';
import { chunkStatus, markFailed, safeName, transportRejection, writeChunk } from '$lib/server/uploads.js';

// The chunked upload path. One reserved path per file, from /api/upload/reserve:
//   GET    ?path=P                       how many bytes the server holds, for a resuming client
//   PUT    ?path=P&offset=O&total=T      raw bytes of one chunk (at most 32 MB), streamed to disk
//   POST   ?path=P  {reason, name, conversation_id}
//                                        the client gave up; leaves P.failed saying why, and if
//                                        the chat that was told "still uploading" is mid-turn,
//                                        steers the model with the failure so it stops waiting
// The PUT that brings the file to T bytes renames it onto P and answers with its sha256.

const noStore = { 'cache-control': 'no-store' };

function failure(cause) {
  const refused = transportRejection(cause);
  if (refused) return json({ error: `Too large for the server to accept: ${refused}`, kind: 'too-large' }, { status: 413, headers: noStore });
  if (!cause.status || cause.status >= 500) console.error('[webchat] chunked upload failed:', cause);
  const body = { error: cause.message, kind: cause.kind || 'error' };
  if (Number.isSafeInteger(cause.received)) body.received = cause.received;
  return json(body, { status: cause.status || 500, headers: noStore });
}

const integer = (value) => (value === null || value === '' ? NaN : Number(value));

export async function GET({ url }) {
  try {
    return json(await chunkStatus({ path: url.searchParams.get('path') }), { headers: noStore });
  } catch (cause) { return failure(cause); }
}

export async function PUT({ url, request }) {
  try {
    const result = await writeChunk({
      path: url.searchParams.get('path'),
      offset: integer(url.searchParams.get('offset')),
      total: integer(url.searchParams.get('total')),
      name: url.searchParams.get('name'),
      body: request.body ? Readable.fromWeb(request.body) : []
    });
    return json(result, { headers: noStore });
  } catch (cause) { return failure(cause); }
}

export async function POST({ url, request }) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await markFailed({ path: url.searchParams.get('path'), reason: body?.reason });
    result.told = result.failed ? tellRunningTurn(body, result.path) : false;
    return json(result, { headers: noStore });
  } catch (cause) { return failure(cause); }
}

// Only a turn already running is steered: an idle chat is not woken to say so (the failure is on
// the attachment chip in front of him, and in P.failed for the next turn that looks).
function tellRunningTurn(body, path) {
  const id = String(body?.conversation_id || '');
  if (!id) return false;
  try {
    if (!app.store.conversation(id) || app.runner.phase(id) !== 'running') return false;
    const name = safeName(body?.name || path);
    const text = `[tophat] Upload failed: ${name} did not upload (${String(body?.reason || 'unknown reason').slice(0, 500)}). `
      + `${path} will not appear; stop waiting for it and tell him.`;
    app.runner.send(id, text, { display: `[upload failed] ${name}: ${String(body?.reason || 'unknown reason').slice(0, 300)}` });
    return true;
  } catch (cause) {
    console.error('[webchat] could not tell the running turn about a failed upload:', cause);
    return false;
  }
}
