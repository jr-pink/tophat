import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';

// POST { ids?: [chat id], folders?: [folder name], dryRun?: bool, archived?: bool }: re-sort those chats with the folder
// descriptions now (every chat when neither is given), including chats he filed by hand, since this is his explicit ask. A
// folder names every chat in it and in its subfolders. Each move is an auto event. Behind the page's sign-in, like
// /api/folder-descriptions.
export async function POST({ request }) {
  const body = await request.json().catch(() => ({}));
  const keys = new Set((Array.isArray(body.folders) ? body.folders : []).map((f) => String(f).toLowerCase()));
  let ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
  if (keys.size) {
    const { readAll } = await import('$lib/server/folder-descriptions.js');
    const meta = readAll();
    const within = (k) => { for (let cur = k, n = 0; cur && n < 32; cur = meta[cur]?.parent || '', n += 1) if (keys.has(cur)) return true; return false; };
    const inFolders = app.store.conversations().filter((c) => c.workspace && within(String(c.workspace).toLowerCase())).map((c) => c.id);
    ids = [...new Set([...(ids || []), ...inFolders])];
  }
  const moved = await app.folderRouter.refile({ ids, all: true, dryRun: body.dryRun === true, archived: body.archived === true, limit: 2000 });
  return json({ ok: true, dryRun: body.dryRun === true, asked: moved.length, moved: moved.filter((m) => (m.from || '').toLowerCase() !== (m.to || '').toLowerCase()) }, { headers: { 'cache-control': 'no-store' } });
}
