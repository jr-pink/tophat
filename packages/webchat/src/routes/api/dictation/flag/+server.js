import { json } from '@sveltejs/kit';
import { engineStatus, flagPath, manifestPath, readFlag, writeFlag } from '$lib/server/dictation.js';

export function GET() {
  const flag = readFlag();
  return json({
    ...flag,
    engines: engineStatus(),
    flag_path: flagPath(),
    manifest_path: manifestPath()
  }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Unreadable body.' }, { status: 400 }); }
  const next = writeFlag({
    enabled: body?.enabled,
    engine: body?.engine,
    condition: body?.condition
  });
  return json({ ...next, engines: engineStatus() }, { headers: { 'cache-control': 'no-store' } });
}
