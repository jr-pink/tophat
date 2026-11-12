import { json } from '@sveltejs/kit';
import { localRefusalAsync } from '$lib/server/local-gate.js';
import { contextFor } from '$lib/server/extensions.js';
import { extensions } from '$lib/server/extensions-boot.js';

// One dispatch from an extension's job process (deploy `tophat ext run-job`): { ext, type, payload, id }. Loopback and
// the service token only; the capability check and the one dispatch path are the server's, the same as an in-process
// extension's (lib/server/extensions.js contextFor). `id` is the intent id the job minted once.
export async function POST(event) {
  if (await localRefusalAsync(event, { token: true })) return json({ error: 'not found' }, { status: 404 });
  const body = await event.request.json().catch(() => ({}));
  const host = process.env.TOPHAT_EXTENSIONS_FILE ? await extensions() : null;
  const reg = host?.regs.find((r) => r.manifest.id === body.ext);
  if (!reg) return json({ ok: false, error: `extension ${body.ext} is not loaded` }, { status: 404 });
  if (typeof body.id !== 'string' || !body.id) return json({ ok: false, error: 'an intent id is required' }, { status: 400 });
  try {
    const r = await contextFor(host, reg).dispatch(String(body.type || ''), body.payload || {}, { id: body.id });
    return json(r ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    return json({ ok: false, code: cause?.code ?? 'error', error: String(cause?.message ?? cause) }, { status: cause?.status ?? 500 });
  }
}
