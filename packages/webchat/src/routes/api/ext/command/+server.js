import { json } from '@sveltejs/kit';
import { runCommand } from '$lib/server/extensions.js';
import { extensions } from '$lib/server/extensions-boot.js';

// Run one extension command (a palette entry or a menu item): { command, args, id }. `id` is the intent id the client
// minted once for this press, so a retried POST runs nothing twice (A7). Behind the session.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.TOPHAT_EXTENSIONS_FILE) return json({ ok: false, error: 'no extensions' }, { status: 404 });
  const id = typeof body.id === 'string' && /^[A-Za-z0-9._:-]{8,120}$/u.test(body.id) ? body.id : null;
  const r = await runCommand(await extensions(), { command: String(body.command || ''), args: body.args && typeof body.args === 'object' ? body.args : {}, id });
  return json(r, { status: r.ok ? 200 : (r.status || 400), headers: { 'cache-control': 'no-store' } });
}
