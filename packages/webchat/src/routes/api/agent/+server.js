

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { DEFAULT_CWD, app, pinnedDefaults, applyAction } from '$lib/server/app.js';
import { newId, normalizeSettings } from '$lib/core/contract.js';
import { PROVIDERS } from '$lib/core/providers.js';
import { spawnDurableWork, agentTranscript, deliverWorkResult } from '$lib/server/work-service.js';
import { secretsDir } from '../../../lib/server/secrets.js';
import { cleanTitle } from '$lib/core/arrival-title.js';
import { canonicalWorkspace } from '$lib/core/workspaces.js';
import { conversationEventStream, SSE_HEADERS } from '$lib/server/conversation-stream.js';

const SECRETS = secretsDir();

// A conversation id, or a runner session id (what an agent's own env and the goal ledger carry); the
// same resolution as ff.js resolveConversation, kept here so this route does not load the router.
function resolveConversation(store, id) {
  if (!id) return null;
  return store.conversation(id)?.id || store.conversationBySession?.(id)?.id || null;
}

function serviceToken() {
  try { return readFileSync(join(SECRETS, 'webchat-service-token'), 'utf8').trim(); }
  catch { return ''; }
}

function authorized(request) {
  const expected = serviceToken();
  if (!expected) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /iu, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}


export async function POST({ request, getClientAddress }) {
  let address = '';
  try { address = getClientAddress(); } catch { address = ''; }
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const forwarded = request.headers.has('x-forwarded-for') || request.headers.has('cf-connecting-ip');
  if (!local || forwarded || !authorized(request)) return json({ error: 'not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const op = String(body.op || '');

  if (op === 'deliver-work') {
    try { return json(deliverWorkResult({ store: app.store, body }), { headers: { 'cache-control': 'no-store' } }); }
    catch (cause) { return json({ error: cause.message }, { status: 409 }); }
  }

  if (op === 'probe-cleanup') {
    const id = String(body.conversationId || '');
    if (app.store.conversation(id)?.source !== 'deployment-probe') return json({ error: 'not a deployment probe' }, { status: 409 });
    if (app.runner.isBusy(id)) applyAction({ op: 'run.interrupt', conversation_id: id, payload: {} });
    applyAction({ op: 'conversation.set_archived', conversation_id: id, payload: { archived: true } });
    app.runner.retire(id);
    return json({ ok: true });
  }

  if (op === 'archive') {
    // Archiving hides a chat and keeps every event; it is how an agent tidies a stray chat it opened
    // without a browser session, and how an arrival chat's own agent clears it from his inbox once
    // resolved. Never deletes. A runner session id resolves like a conversation id.
    const id = resolveConversation(app.store, String(body.conversationId || ''));
    if (!id) return json({ error: `no conversation ${body.conversationId}` }, { status: 404 });
    applyAction({ op: 'conversation.set_archived', conversation_id: id, payload: { archived: body.archived !== false } });
    return json({ ok: true, id, archived: Boolean(app.store.conversation(id)?.archived) }, { headers: { 'cache-control': 'no-store' } });
  }

  if (op === 'route-sweep') {
    // Runs the folder router over every unfiled chat now (autoroute.js sweep): the boot and
    // ten-minute sweep skip archived chats, so a backfill of recent archived ones names `since`
    // and sets archived. Writes the same auto conversation.workspace events a live route does.
    const since = typeof body.since === 'string' && body.since ? body.since : null;
    // refile: after he edits descriptions, ask again for the chats the router filed (never one he
    // filed by hand) and move or unfile them; dryRun writes nothing. unfileFolder: empty a folder
    // the router made, by auto events; force names chat ids an agent (not he) put there.
    if (body.refile === true) {
      const moved = await app.folderRouter.refile({ archived: body.archived === true, since, dryRun: body.dryRun === true, ids: Array.isArray(body.ids) ? body.ids.map(String) : null, limit: Math.min(Number(body.limit) || 100, 2000), all: body.all === true });
      return json({ ok: true, dryRun: body.dryRun === true, moved }, { headers: { 'cache-control': 'no-store' } });
    }
    if (typeof body.unfileFolder === 'string' && body.unfileFolder) {
      const moved = app.folderRouter.unfileFolder(body.unfileFolder, { force: Array.isArray(body.force) ? body.force.map(String) : [], dryRun: body.dryRun === true });
      return json({ ok: true, dryRun: body.dryRun === true, moved }, { headers: { 'cache-control': 'no-store' } });
    }
    const filed = await app.folderRouter.sweep({ archived: body.archived === true, since, limit: Math.min(Number(body.limit) || 50, 500) });
    return json({ ok: true, filed }, { headers: { 'cache-control': 'no-store' } });
  }
  if (op === 'workspace' || op === 'aside') {
    // Filing a chat under a workspace, or setting it aside, from the chat's own agent: the same
    // actions the sidebar's folder menu and set-aside button send. A runner session id resolves
    // too.
    const id = resolveConversation(app.store, String(body.conversationId || ''));
    if (!id) return json({ error: `no conversation ${body.conversationId}` }, { status: 404 });
    if (op === 'workspace') applyAction({ op: 'conversation.set_workspace', conversation_id: id, payload: { workspace: canonicalWorkspace(body.workspace) } });
    else applyAction({ op: 'conversation.set_aside', conversation_id: id, payload: { aside: body.aside !== false } });
    const c = app.store.conversation(id);
    return json({ ok: true, id, workspace: c?.workspace || null, aside: Boolean(c?.aside) }, { headers: { 'cache-control': 'no-store' } });
  }

  if (op === 'rename') {
    // The chat's own agent names it (chat_rename, rev6/pull/chat.mjs): the same conversation.rename
    // action the sidebar sends, so every open tab updates live and the title becomes 'manual', which
    // the titler never overwrites.
    const id = resolveConversation(app.store, String(body.conversationId || ''));
    if (!id) return json({ error: `no conversation ${body.conversationId}` }, { status: 404 });
    const title = cleanTitle(body.title);
    if (!title) return json({ error: 'a title is required' }, { status: 400 });
    applyAction({ op: 'conversation.rename', conversation_id: id, payload: { title } });
    return json({ ok: true, id, title: app.store.conversation(id)?.title }, { headers: { 'cache-control': 'no-store' } });
  }

  if (op === 'handoff') {
    // One chat wakes another (chat_handoff, rev6/pull/chat.mjs): the settle path push wakes and /api/inbound use, so the receiving
    // chat gets the automated-event framing and the inbox rule, and an archived chat stays archived. Answers delivered only when
    // the target exists and the message reached it.
    const from = resolveConversation(app.store, String(body.conversationId || ''));
    const target = resolveConversation(app.store, String(body.target || ''));
    if (!target) return json({ error: `no conversation ${body.target}` }, { status: 404 });
    if (target === from) return json({ error: 'a chat cannot hand off to itself' }, { status: 409 });
    const said = String(body.text || '').trim();
    if (!said) return json({ error: 'Nothing to send' }, { status: 400 });
    const label = from ? `chat ${from}${app.store.conversation(from)?.title ? ` "${app.store.conversation(from).title}"` : ''}` : 'another chat';
    const wire = `[Handed off from ${label}; an automated event, not a message from the owner.]\n${said}`;
    // What the transcript stores and shows opens with an automated-event label (src/lib/core/automated-event.js), so the client
    // collapses it like every other automated event; the sender's title rides in the label's parentheses, never in the body.
    const sender = from ? String(app.store.conversation(from)?.title || '').replace(/[()\[\]\s]+/gu, ' ').trim().slice(0, 60) : '';
    const text = `[Automated event from chat handoff${sender ? ` (${sender})` : ''}; not a message from the owner.]\n${said}`;
    const { settle } = await import('$lib/server/ff.js');
    const ffId = app.store.ffAccept(text);
    try {
      const sent = await settle(ffId, { text, wire, context: { kind: 'chat-handoff', from }, conversationId: target });
      return json({ ok: true, delivered: true, conversationId: sent.conversationId, injected: sent.injected }, { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
      try { app.store.ffSettle(ffId, { state: 'failed', error: String(cause?.message ?? cause).slice(0, 300) }); } catch {}
      return json({ error: String(cause?.message ?? cause) }, { status: 500 });
    }
  }

  if (op === 'send') {
    const id = String(body.conversationId || '');
    if (!app.store.conversation(id)) return json({ error: `no conversation ${id}` }, { status: 404 });
    const text = String(body.text || '').trim();
    if (!text) return json({ error: 'Nothing to send' }, { status: 400 });
    
    
    const cursor = app.store.cursor();
    const { injected } = app.runner.send(id, text, { display: text });
    return json({ id, injected, cursor }, { headers: { 'cache-control': 'no-store' } });
  }

  if (op === 'spawn') {
    // A chat /api/agent opens is a new chat like any other, so an unnamed provider or model
    // takes the deployment's pinned default rather than one invented here. Name only what
    // the caller asked for: a key present but undefined spreads over the pin, and a
    // hardcoded provider rejects both a pinned model and a named one owned by another.
    const asked = {
      ...(PROVIDERS.includes(body.provider) ? { provider: body.provider } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      ...(body.permissionMode ? { permissionMode: body.permissionMode } : {})
    };
    const settings = normalizeSettings(pinnedDefaults(asked));
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json({ error: 'Nothing to ask' }, { status: 400 });
    if (body.requestId) {
      try {
        const result = spawnDurableWork({ store: app.store, runner: app.runner, body, settings, defaultCwd: DEFAULT_CWD });
        return json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (cause) { return json({ error: cause.message }, { status: 409 }); }
    }
    const probe = body.deploymentProbe === true;
    if (probe && !/^[0-9a-f-]{36}$/u.test(body.probeId || '')) return json({ error: 'invalid probe id' }, { status: 400 });
    const id = probe ? body.probeId : newId();
    if (probe && app.store.conversation(id)) {
      if (app.store.conversation(id).source !== 'deployment-probe') return json({ error: 'probe id collision' }, { status: 409 });
      return json({ id, provider: settings.provider, model: settings.model, cursor: 0 });
    }
    const at = new Date().toISOString();
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : DEFAULT_CWD;
    const title = String(body.title || prompt).replace(/\s+/gu, ' ').trim().slice(0, 72);
    
    
    
    
    const parentId = body.parentId && app.store.conversation(body.parentId) ? body.parentId : null;
    app.store.ensureConversation(id, { at, cwd, settings, title, parentId, source: probe ? 'deployment-probe' : 'agent' });
    app.store.append(id, 'conversation.created', { title, settings, cwd }, { at });
    const cursor = app.store.cursor();
    app.runner.send(id, prompt, { display: prompt });
    return json({ id, provider: settings.provider, model: settings.model, cursor }, { headers: { 'cache-control': 'no-store' } });
  }

  // Stop a chat, the same as his stop button (run.interrupt): the live turn is aborted, its calls killed and every
  // background turn and subagent cancelled (rev6/pull/pull.mjs control interrupt). Typing is not this: a message typed
  // mid turn moves the turn to the background. Lets an agent verify the stop gesture live.
  if (op === 'interrupt') {
    const id = String(body.conversationId || '');
    if (!app.store.conversation(id)) return json({ error: `no conversation ${id}` }, { status: 404 });
    const interrupted = app.runner.interrupt(id, { cancelQueued: false });
    return json({ id, interrupted, phase: app.runner.phase(id) }, { headers: { 'cache-control': 'no-store' } });
  }

  // A peer attaching a chat that lives here: the chat's live events as the same frames a browser tab reads on /api/events
  // (conversation-stream.js). Resumes from the store cursor `after`; the answer stays open until the caller disconnects.
  if (op === 'events') {
    const id = String(body.conversationId || '');
    if (!app.store.conversation(id)) return json({ error: `no conversation ${id}` }, { status: 404 });
    const { stream } = conversationEventStream({ store: app.store, id, after: body.after });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  if (op === 'read') {
    const id = String(body.conversationId || '');
    const conversation = app.store.conversation(id);
    if (!conversation) return json({ error: `no conversation ${id}` }, { status: 404 });
    const { rows, cursor } = agentTranscript(app.store, id, Number(body.after) || 0);
    return json({
      id,
      provider: conversation.settings?.provider || null,
      model: conversation.settings?.model || null,
      phase: app.runner.phase(id),
      busy: app.runner.isBusy(id),
      owed: app.runner.owed(id).length,
      rows,
      cursor
    }, { headers: { 'cache-control': 'no-store' } });
  }

  return json({ error: `unknown op ${op}` }, { status: 400 });
}
