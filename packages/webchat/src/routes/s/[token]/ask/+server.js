import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { shareStore } from '$lib/server/shares.js';
import { askShare, cleanVisit } from '$lib/server/share-ask.js';

// The visitor side of an askable chat link (src/lib/server/share-ask.js). Public like the page it
// belongs to, and checked the same way: the token in the path is the credential, and only a token
// minted with ask = 1 may post. The clean and notes tokens of the same chat answer 403 here.

const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const MAX_BODY = 8 * 1024;

function askable(token) {
  const share = shareStore().resolve(token);
  if (!share) return { status: 404, error: 'This link is not live.' };
  if (share.kind !== 'chat' || !share.ask) return { status: 403, error: 'This link is read-only.' };
  return { share };
}

/** This visit's earlier questions and answers, so a reload shows the thread again. */
export function GET({ params, url }) {
  const gate = askable(params.token);
  if (!gate.share) return json({ error: gate.error }, { status: gate.status, headers: NO_STORE });
  const visit = cleanVisit(url.searchParams.get('visit'));
  const asks = shareStore().asksOfVisit(params.token, visit).map((a) => ({
    id: a.id, asker: a.asker, question: a.question, answer: a.answer, status: a.status, askedAt: a.askedAt
  }));
  return json({ asks }, { headers: NO_STORE });
}

const sse = (event) => `${JSON.stringify(event)}\n`;

/**
 * One question. Refusals (read-only token, rate limit, bad input) come back as plain JSON with their
 * status; an accepted question comes back as newline-delimited JSON events that stream the answer:
 * {type:'start',id} {type:'reset'} {type:'delta',text} then {type:'done',answer} or {type:'error',error}.
 */
export async function POST({ params, request }) {
  const gate = askable(params.token);
  if (!gate.share) return json({ error: gate.error }, { status: gate.status, headers: NO_STORE });

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return json({ error: 'That is too long.' }, { status: 413, headers: NO_STORE });
  const raw = await request.text().catch(() => '');
  if (raw.length > MAX_BODY) return json({ error: 'That is too long.' }, { status: 413, headers: NO_STORE });
  let body = {};
  try { body = JSON.parse(raw); } catch { /* an empty question is refused below */ }

  const buffered = [];
  let sink = null;
  let begin;
  const begun = new Promise((resolve) => { begin = resolve; });
  const send = (event) => {
    if (sink) { try { sink(event); } catch { /* the visitor left; the answer is still saved */ } } else buffered.push(event);
  };
  const result = askShare(
    { token: params.token, question: body.question, name: body.name, visit: body.visit },
    { store: app.store, emit: (event) => { if (event.type === 'start') begin(); send(event); } }
  );
  const first = await Promise.race([begun.then(() => 'started'), result.then(() => 'finished')]);
  if (first === 'finished') {
    const r = await result;
    if (!r.ok) {
      const headers = { ...NO_STORE, ...(r.retryAfterSec ? { 'retry-after': String(r.retryAfterSec) } : {}) };
      return json({ error: r.error, retryAfterSec: r.retryAfterSec }, { status: r.status, headers });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const write = (event) => controller.enqueue(encoder.encode(sse(event)));
      for (const event of buffered.splice(0)) write(event);
      sink = write;
      result.then((r) => {
        sink = null;
        try {
          write(r.ok ? { type: 'done', id: r.id, answer: r.answer, status: r.status } : { type: 'error', id: r.id, error: r.error });
          controller.close();
        } catch { /* closed by the visitor */ }
      });
    },
    cancel() { sink = null; }
  });
  return new Response(stream, {
    headers: { ...NO_STORE, 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' }
  });
}
