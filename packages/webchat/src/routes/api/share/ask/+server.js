import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app.js';
import { shareStore } from '$lib/server/shares.js';

// The owner's side of askable chat links: mint one, revoke it, read what was asked. Session-gated
// like everything under /api except the public share pages (hooks.server.js). The askable link is a
// token of its own, never derived from or listed beside the clean and notes links of the same chat,
// so it can be revoked without touching them, and they can be revoked without touching it.

const NO_STORE = { 'cache-control': 'no-store' };

const targetOf = (url, body = {}) => String(body.target_id || url.searchParams.get('target_id') || '');

function summary(origin, targetId) {
  const live = shareStore().askLinkFor(targetId);
  const asks = shareStore().asksForTarget(targetId);
  return {
    asked: !!live,
    ...(live ? { url: `${origin}/s/${live.token}`, views: live.views, created_at: live.createdAt } : {}),
    count: asks.length,
    questions: asks.map((a) => ({
      id: a.id, asker: a.asker, question: a.question, answer: a.answer, status: a.status,
      asked_at: a.askedAt, cost_usd: a.costUsd, live: !!live && a.token === live.token
    }))
  };
}

export function GET({ url }) {
  const targetId = targetOf(url);
  if (!targetId) error(400, 'target_id is required');
  return json(summary(url.origin, targetId), { headers: NO_STORE });
}

export async function POST({ request, url }) {
  const body = await request.json().catch(() => ({}));
  const targetId = targetOf(url, body);
  if (!targetId) error(400, 'target_id is required');
  const conversation = app.store.conversation(targetId);
  if (!conversation) error(404, 'no such chat');
  const made = shareStore().askLink(targetId, conversation.title || '');
  return json({ minted: made.minted, ...summary(url.origin, targetId) },
    { status: made.minted ? 201 : 200, headers: NO_STORE });
}

export async function DELETE({ request, url }) {
  const body = await request.json().catch(() => ({}));
  const targetId = targetOf(url, body);
  if (!targetId) error(400, 'target_id is required');
  const revoked = shareStore().revokeAsk(targetId);
  return json({ revoked, ...summary(url.origin, targetId) }, { headers: NO_STORE });
}
