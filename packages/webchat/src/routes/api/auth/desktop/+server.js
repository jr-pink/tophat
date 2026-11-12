// Desktop app sign-in through the system browser (src/lib/server/desktop-signin.js explains the handoff).
import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';
import { grantDesktop, redeemDesktop } from '$lib/server/desktop-signin.js';

const noStore = { headers: { 'cache-control': 'no-store' } };

export async function POST({ request, cookies }) {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.step === 'grant') {
      if (!app.auth.valid(cookies.get(SESSION_COOKIE))) return json({ error: 'Sign in first' }, { status: 401, ...noStore });
      grantDesktop(body.challenge, app.auth.issueSession());
      return json({ ok: true }, noStore);
    }
    if (body.step === 'redeem') {
      const session = redeemDesktop(body.verifier);
      if (!session) return json({ pending: true }, noStore);
      return json({ cookie: SESSION_COOKIE, value: session.value, expires: session.expires.toISOString() }, noStore);
    }
    return json({ error: 'Unknown step' }, { status: 400, ...noStore });
  } catch (cause) {
    return json({ error: cause.message }, { status: 400, ...noStore });
  }
}
