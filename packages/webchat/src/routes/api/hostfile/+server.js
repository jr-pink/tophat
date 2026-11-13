// The home host's door for a team host's runner (host-grant.js): GET /api/hostfile?grant=<id>&path=<path under the granted folder>, with the
// grant token as the bearer. Loopback only and never through the tunnel proxy (the reverse ssh path arrives as a loopback connection); every
// refusal is a plain 404, so a stranger learns nothing. Read-only.
import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { localRefusal } from '$lib/server/local-gate.js';
import { GrantError, readUnderGrant } from '$lib/server/host-grant.js';

export async function GET(event) {
  if (localRefusal(event)) return json({ error: 'not found' }, { status: 404 });
  const bearer = (event.request.headers.get('authorization') || '').replace(/^Bearer /iu, '');
  const grant = app.hostGrants.authorize(event.url.searchParams.get('grant'), bearer);
  if (!grant) return json({ error: 'not found' }, { status: 404 });
  try { return json(await readUnderGrant(grant, event.url.searchParams.get('path')), { headers: { 'cache-control': 'no-store' } }); }
  catch (cause) {
    if (cause instanceof GrantError) return json({ error: cause.message }, { status: cause.status });
    return json({ error: 'could not read' }, { status: 500 });
  }
}
