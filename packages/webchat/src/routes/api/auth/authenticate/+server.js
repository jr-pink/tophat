import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';

export async function POST({ request, cookies, url }) {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.step === 'options') return json(await app.auth.authenticationOptions());
    const session = await app.auth.verifyAuthentication(body.response);
    cookies.set(SESSION_COOKIE, session.value, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', expires: session.expires
    });
    return json({ ok: true });
  } catch (cause) {
    return json({ error: cause.message }, { status: 401 });
  }
}
