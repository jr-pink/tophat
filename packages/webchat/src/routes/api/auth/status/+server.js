import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';

export function GET({ cookies }) {
  return json({
    enrolled: app.auth.enrolled(),
    authenticated: app.auth.valid(cookies.get(SESSION_COOKIE)),
    disabled: app.auth.disabled
  }, { headers: { 'cache-control': 'no-store' } });
}
