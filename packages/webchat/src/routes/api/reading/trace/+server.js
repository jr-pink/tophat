// Reading trace intake and readout.
//
// POST  a batch of line rows from a surface he is reading.
// GET   ?summary=1          sessions, words per minute, and where he slowed down or went back
//       ?surface=&ref=      raw rows for one document or conversation

import { json } from '@sveltejs/kit';
import { readingTrace } from '$lib/server/reading-trace-store.js';
import { wordsPerMinute, snags } from '$lib/core/reading-trace.js';

export async function POST({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'expected json' }, { status: 400 }); }
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!body?.session || !body?.surface || !body?.ref) {
    return json({ error: 'session, surface and ref are required' }, { status: 400 });
  }
  const store = readingTrace();
  const n = store.record(rows, {
    session: body.session, surface: body.surface, ref: body.ref,
    device: body.device || '', width: body.width || 0, height: body.height || 0
  });
  return json({ ok: true, recorded: n });
}

export async function GET({ url }) {
  const store = readingTrace();
  const surface = url.searchParams.get('surface');
  const ref = url.searchParams.get('ref');
  const since = url.searchParams.get('since');

  if (url.searchParams.get('summary')) {
    const sessions = (await store.sessions({ limit: 60 })).map((s) => ({
      ...s,
      wpm: s.ms ? Math.round((s.words / s.ms) * 60000) : null,
      minutes: +(s.ms / 60000).toFixed(1)
    }));
    const recent = await store.rows({ surface, ref, since, limit: 8000 });
    return json({
      sessions,
      wpm: wordsPerMinute(recent),
      snags: snags(recent).slice(0, 40)
    });
  }

  return json({ rows: await store.rows({ surface, ref, since, limit: 2000 }) });
}
