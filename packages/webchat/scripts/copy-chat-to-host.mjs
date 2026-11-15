#!/usr/bin/env node
// Copy a chat (or chosen turns of one) from this instance into a group scope on another host, through the two machine doors:
// GET /api/sync?conversation=ID (peer read, service token) here, POST /api/agent op import-conversation (server/chat-import.js) there.
// The source chat is never touched. Both hosts are reached on loopback, the remote one usually through `ssh -N -L PORT:127.0.0.1:WEBCHAT_PORT host`.
//
//   node copy-chat-to-host.mjs --from-url URL --from-token-file F --to-url URL --to-token-file F --chat ID --scope team-a
//        [--title TEXT] [--new-id UUID] [--turns 1-7,9] [--drop-turns 3,5] [--drop-text REGEX] [--rewrite FROM=TO ...]
//        [--sub 'REGEX=>TEXT' ...] [--origin NAME] [--cwd PATH] [--full] [--out FILE] [--dry-run]
//
// A turn is one owner message and everything after it up to the next owner message; events before the first owner message are turn 0.
// Default is a clean transcript for a wider audience: owner messages and the assistant's own replies, with the run markers the page
// needs to draw turns. Tool calls and results, thinking, subagent traffic and attribution (device ids) are left out, because they carry
// whatever the run happened to read (memory hits, files, other chats). `--full` keeps every event of the kept turns instead.
// `--drop-text` removes any kept message whose text matches; `--rewrite FROM=TO` rewrites a path prefix inside message text;
// `--sub 'REGEX=>TEXT'` substitutes inside message text (a JS regex, flags gu; use it to cut a tail or a phrase out of a message that is otherwise kept).
import { readFileSync, writeFileSync } from 'node:fs';
import { digestOf } from '../src/lib/server/chat-import.js';

const args = process.argv.slice(2);
const opt = (name, many = false) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === `--${name}`) out.push(args[i + 1]);
  return many ? out : out[0];
};
const flag = (name) => args.includes(`--${name}`);
const need = (name) => { const v = opt(name); if (!v) { console.error(`missing --${name}`); process.exit(2); } return v; };

const fromUrl = need('from-url').replace(/\/+$/u, ''), toUrl = need('to-url').replace(/\/+$/u, '');
const fromToken = readFileSync(need('from-token-file'), 'utf8').trim(), toToken = readFileSync(need('to-token-file'), 'utf8').trim();
const chat = need('chat'), scope = need('scope');
const ranges = (text) => new Set(String(text || '').split(',').filter(Boolean).flatMap((part) => {
  const [a, b] = part.split('-').map(Number); return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
}));
const keepTurns = opt('turns') ? ranges(opt('turns')) : null;
const dropTurns = ranges(opt('drop-turns'));
const dropText = opt('drop-text') ? new RegExp(opt('drop-text'), 'iu') : null;
const rewrites = opt('rewrite', true).map((r) => r.split('=')).map(([from, to]) => ({ from, to }));
const subs = opt('sub', true).map((r) => { const at = r.indexOf('=>'); return { re: new RegExp(r.slice(0, at), 'gu'), to: r.slice(at + 2) }; });
const rewrite = (text) => subs.reduce((t, { re, to }) => t.replace(re, to), rewrites.reduce((t, { from, to }) => t.split(from).join(to), text)).trim();

async function readAll() {
  const events = [];
  for (let after = 0; ;) {
    const res = await fetch(`${fromUrl}/api/sync?conversation=${encodeURIComponent(chat)}&after=${after}`, { headers: { authorization: `Bearer ${fromToken}` } });
    if (!res.ok) throw new Error(`read ${chat}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    events.push(...page.events);
    if (!page.truncated || !page.events.length) return events;
    after = page.events[page.events.length - 1].cursor;
  }
}

const KEEP_CLEAN = new Set(['conversation.created', 'message.user', 'assistant.message', 'run.status', 'run.completed']);
const all = (await readAll()).sort((a, b) => a.cursor - b.cursor);
if (!all.length) throw new Error('no events');
const created = all.find((e) => e.kind === 'conversation.created');
let turn = 0;
const kept = [];
const dropped = { turns: new Set(), text: 0, kinds: 0 };
for (const e of all) {
  if (e.kind === 'message.user') turn += 1;
  if ((keepTurns && !keepTurns.has(turn)) || dropTurns.has(turn)) { dropped.turns.add(turn); continue; }
  if (!flag('full') && !KEEP_CLEAN.has(e.kind)) { dropped.kinds += 1; continue; }
  let content = e.content;
  if (!flag('full')) {
    if (e.kind === 'message.user') content = { itemId: content.itemId, text: rewrite(String(content.text || '')) };
    else if (e.kind === 'assistant.message') {
      if (content.agentId) { dropped.kinds += 1; continue; }
      content = { itemId: content.itemId, text: rewrite(String(content.text || '')), agentId: null };
    } else if (e.kind === 'conversation.created') content = { title: opt('title') || content.title, settings: content.settings, cwd: opt('cwd') || null };
    else if (e.kind === 'run.completed') content = { durationMs: content.durationMs };
  }
  if (dropText && (e.kind === 'message.user' || e.kind === 'assistant.message') && dropText.test(String(content.text || ''))) { dropped.text += 1; continue; }
  kept.push({ kind: e.kind, content, at: e.at, run_id: e.run_id ?? null });
}
// An owner message with no assistant answer left after filtering is kept; a run marker whose run lost every other event is dropped.
const runs = new Map();
for (const e of kept) if (e.run_id) runs.set(e.run_id, (runs.get(e.run_id) || 0) + (e.kind === 'run.status' || e.kind === 'run.completed' ? 0 : 1));
const events = kept.filter((e) => !(e.run_id && (e.kind === 'run.status' || e.kind === 'run.completed') && runs.get(e.run_id) === 0));

const id = opt('new-id') || chat;
const bundle = {
  conversation: { id, title: opt('title') || created?.content?.title || 'Imported chat', settings: created?.content?.settings || {}, created_at: events[0].at, updated_at: events[events.length - 1].at, title_source: 'manual', turns: events.filter((e) => e.kind === 'message.user').length },
  events, scope, origin: opt('origin') || 'another host', digest: digestOf(events), ...(opt('cwd') ? { cwd: opt('cwd') } : {})
};
const summary = { chat, as: id, scope, events: events.length, owner: events.filter((e) => e.kind === 'message.user').length, assistant: events.filter((e) => e.kind === 'assistant.message').length,
  bytes: JSON.stringify(bundle).length, droppedTurns: [...dropped.turns].sort((a, b) => a - b), droppedMessagesByText: dropped.text, droppedEventsByKind: dropped.kinds, digest: bundle.digest };
if (opt('out')) writeFileSync(opt('out'), JSON.stringify(bundle));
if (flag('dry-run')) { console.log(JSON.stringify({ dryRun: true, ...summary }, null, 1)); process.exit(0); }
const res = await fetch(`${toUrl}/api/agent`, { method: 'POST', headers: { authorization: `Bearer ${toToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'import-conversation', ...bundle }) });
const answer = await res.json().catch(() => ({}));
console.log(JSON.stringify({ http: res.status, answer, ...summary }, null, 1));
if (!res.ok || answer.hash !== bundle.digest.hash) process.exit(1);
