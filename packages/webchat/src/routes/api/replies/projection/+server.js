import { json } from '@sveltejs/kit';
import { notesStore } from '$lib/server/notes-store.js';
import { syncReplyProjection } from '$lib/server/replies.js';
import { localRefusal } from '$lib/server/local-gate.js';

// What the Beeper badge follows. GET reconciles the conversation lines with the monitor's latest
// assessment (idempotent) and answers which chats have an open reply line, which have only closed
// ones, and which carry an explicit override of his. Loopback and the service token only, like
// /api/inbound: it is a machine surface, and it reveals nothing the Notes page does not. That gate
// is one rule with one owner, src/lib/server/local-gate.js, rather than three address literals and
// a timing-safe compare copied into each machine route.
export async function GET(event) {
  if (localRefusal(event, { token: true })) return json({ error: 'not found' }, { status: 404 });
  const answer = await syncReplyProjection(notesStore());
  return json(answer, { status: answer.available ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
