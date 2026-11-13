import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { listHosts, selfDevice, setNote } from '$lib/server/hosts.js';

// GET: the hosts a chat can live on ({ hosts: [{ id, label, local, configured, description, auto, online?, chats? }] }): this host
// first, then every peer on the hub, with whether this server can reach it. POST { id, description?, auto?, at }: his edit from the host
// menu (the newest `at` per host wins, so an offline replay changes nothing newer). Behind the same sign-in as the page.
async function view() {
  const reach = await app.remoteRuntimes.status();
  return { hosts: listHosts().map((h) => (h.local ? h : { ...h, online: reach[h.id]?.online ?? null, error: reach[h.id]?.error ?? null, chats: reach[h.id]?.chats ?? 0 })) };
}

export async function GET() {
  return json(await view(), { headers: { 'cache-control': 'no-store' } });
}

export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id : null;
  if (id === null || !listHosts().some((h) => h.id === id)) return json({ error: 'unknown host' }, { status: 400 });
  setNote(id === '' ? selfDevice() : id, {
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(typeof body.auto === 'boolean' ? { auto: body.auto } : {}),
    at: typeof body.at === 'string' ? body.at : null
  });
  return json(await view(), { headers: { 'cache-control': 'no-store' } });
}
