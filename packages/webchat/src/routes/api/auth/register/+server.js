import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';

export async function POST({ request, cookies, url }) {
  const body = await request.json().catch(() => ({}));
  const authenticated = app.auth.valid(cookies.get(SESSION_COOKIE));
  try {
    if (body.step === 'options') {
      return json(await app.auth.registrationOptions({ token: body.token, authenticated }));
    }
    await app.auth.verifyRegistration(body.response, body.label);
    
    
    const session = app.auth.issueSession();
    cookies.set(SESSION_COOKIE, session.value, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', expires: session.expires
    });
    return json({ ok: true });
  } catch (cause) {
    return json({ error: cause.message }, { status: 403 });
  }
}
