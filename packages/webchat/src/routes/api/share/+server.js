import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { readerStore } from '$lib/server/reader-store.js';
import { shareStore } from '$lib/server/shares.js';
import { requireChat, scopeContext } from '$lib/server/scope-guard.js';

// A chat's share links are its owner's to mint, and only for a chat in a scope the caller may open.
function guardChat(event, kind, targetId) {
  if (kind !== 'chat') return;
  const ctx = scopeContext(event, app.store, app.runner);
  if (ctx.enabled) requireChat(ctx, app.store.conversation(targetId));
}

// Minting and revoking share links. Session-gated like everything else here; only the /s/<token>
// pages themselves are public. A share is always a pair, and the pair is returned to him in one
// answer, because the choice he makes when sharing is which of the two URLs to paste.

const KINDS = new Set(['doc', 'chat']);

function titleFor(kind, targetId) {
  if (kind === 'doc') return readerStore().doc(targetId)?.title || '';
  return app.store.conversation(targetId)?.title || '';
}

function exists(kind, targetId) {
  if (kind === 'doc') return !!readerStore().doc(targetId);
  return !!app.store.conversation(targetId);
}

const urls = (origin, pair) => ({
  url: `${origin}/s/${pair.plain}`,
  notes_url: `${origin}/s/${pair.notes}`,
});

export function GET(event) {
  const { url } = event;
  const kind = url.searchParams.get('kind') || '';
  const targetId = url.searchParams.get('target_id') || '';
  if (!KINDS.has(kind) || !targetId) error(400, 'kind (doc|chat) and target_id are required');
  guardChat(event, kind, targetId);
  const live = shareStore().forTarget(kind, targetId);
  if (live.length < 2) return json({ shared: false }, { headers: { 'cache-control': 'no-store' } });
  const plain = live.find((s) => !s.withNotes);
  const notes = live.find((s) => s.withNotes);
  return json({
    shared: true,
    ...urls(url.origin, { plain: plain.token, notes: notes.token }),
    views: { plain: plain.views, notes: notes.views },
    created_at: plain.createdAt,
  }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(event) {
  const { request, url } = event;
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || '');
  const targetId = String(body.target_id || '');
  if (!KINDS.has(kind) || !targetId) error(400, 'kind (doc|chat) and target_id are required');
  if (!exists(kind, targetId)) error(404, `no such ${kind}`);
  guardChat(event, kind, targetId);
  // A shared chat gets its document row, so notes taken on the transcript have somewhere to live
  // and the notes link has something to show.
  if (kind === 'chat') readerStore().ensureChatDoc(targetId, titleFor(kind, targetId));
  const pair = shareStore().pair(kind, targetId, titleFor(kind, targetId));
  return json({ shared: true, minted: pair.minted, ...urls(url.origin, pair) },
    { status: pair.minted ? 201 : 200, headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(event) {
  const { request, url } = event;
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || url.searchParams.get('kind') || '');
  const targetId = String(body.target_id || url.searchParams.get('target_id') || '');
  if (!KINDS.has(kind) || !targetId) error(400, 'kind (doc|chat) and target_id are required');
  guardChat(event, kind, targetId);
  const revoked = shareStore().revoke(kind, targetId);
  // Unsharing a chat withdraws every link to it, the askable one included (it has its own revoke,
  // DELETE /api/share/ask, for taking back only the questions).
  const askRevoked = kind === 'chat' ? shareStore().revokeAsk(targetId) : 0;
  return json({ shared: false, revoked, ask_revoked: askRevoked }, { headers: { 'cache-control': 'no-store' } });
}
