import { json } from '@sveltejs/kit';
import { notesStore } from '$lib/server/notes-store.js';
import { stateReportResponse } from '$lib/server/state-report.js';

// The page's door to the same owner report /api/state's `report` op writes: when the owner ticks a
// box or stops typing on a line in the state area, the span goes into the rev5 raw data plane and
// the next push cycle interprets it against evidence. The agent door is gated on the service
// token; this one is a browser call, so it is gated by the session the way every other page route
// is (src/hooks.server.js refuses anything without a valid session cookie before it gets here).
//
// It answers 200 even when the plane could not be written, with the reason in the body. The line
// itself is already saved in the notes store, and a person typing should not be shown an error
// about a memory plane he did not ask about.
export async function POST({ request }) {
  const store = notesStore();
  const body = await request.json().catch(() => ({}));
  const { status, payload } = await stateReportResponse({ store, body });
  return json(payload, { status, headers: { 'cache-control': 'no-store' } });
}
