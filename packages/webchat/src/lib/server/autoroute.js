// Auto-routing: an unfiled chat is filed into the folder (workspace) it belongs in, after its first turns.
//
// Scope: a chat with no workspace and no workspace decision of his. A chat he created inside a folder is already filed; a chat
// he moved or unfiled by hand (a conversation.workspace event without `auto`) is his call and is never touched again. Routing
// tries on each of the first MAX_TURNS turn ends (a wake chat often says what it is only after its first answer) and stops once
// it files. The turn gate counts completed runs, not user messages: a chat where he sent four quick messages during its first
// turn was skipped at that turn's end. The folders are the workspace names on chats plus any folder he described by hand; a
// description is the folder's definition, titles are examples. The model may answer none, which leaves the chat in Everything
// else. Every outcome is logged.
//
// Every link of the chain that left a chat unfiled, and what closed it:
//   1. Only the first MAX_TURNS completed runs and 20 user messages were tried; a chat that said
//      nothing useful early, or whose calls failed, was abandoned. Both gates are gone: a chat
//      stays a candidate until it has a folder.
//   2. The only triggers were two in-memory timers per message; a restart in those five seconds,
//      or any failure, left the chat with nothing retrying it. sweep() runs at boot and every
//      SWEEP_MS over every unfiled chat.
//   3. A chat opened while the sidebar sat in a folder was filed into it by default and then
//      skipped for good (a notes-app chat in "upkeep"). The page marks the default
//      (workspaceDefault) and defaultPlaced() lets the router move it.
//
// So the router never creates a folder and never files into the catch-all: it picks one of his existing folders or leaves the
// chat unfiled, which the sidebar shows in Inbox. His descriptions are his definitions and beat title similarity: a manual
// description is shown to the model as his definition, a generated one only as a weak summary of what happens to be filed
// there.
//
// Hosts (hosts.js): the same router also picks the host a chat runs on, from the descriptions its owner wrote for the hosts
// he opted into auto-routing. Only a host with a written description is ever offered, a pick is confirmed by a second call that
// says yes only for work clearly covered by the description and free of anything personal, a host he chose by hand is never
// overridden, and every decision is logged (onDecision, remote-routing.jsonl).
//
// refile() is the owner-triggered second pass after he edits descriptions: it asks again for the
// chats the router filed (never one he filed or moved by hand) and files them where the current
// descriptions say, or unfiles them.

import { readAll } from './folder-descriptions.js';
import { autoCandidates, listHosts } from './hosts.js';
import { readSecret } from './auth.js';
import { transcriptFor } from './autotitle.js';
import { canonicalWorkspace } from '../core/workspaces.js';

export const DELAY_MS = 5 * 1000;
export const SWEEP_MS = 10 * 60 * 1000;
export const SWEEP_BOOT_MS = 30 * 1000;
const TITLES_PER_FOLDER = 12;
export const STAY_LIMIT = 3;

const ENDPOINT = process.env.WEBCHAT_TITLE_ENDPOINT || '' + (process.env.TOPHAT_FAST_MODEL_ENDPOINT || '');
const MODEL = process.env.WEBCHAT_ROUTE_MODEL || process.env.WEBCHAT_TITLE_MODEL || 'gpt-oss-120b';

const PROMPT = `You file a chat into one of the user's folders; never invent one. His definitions are authoritative.
Reply with ONLY the exact name of the one folder whose definition covers the chat, or none.
Folders nest: "A > B" is B inside A. Pick the most specific folder that fits; a chat that fits folder A but none of A's
subfolders goes to A itself (it shows under A's Misc). Answer none (his Inbox) only
when no top-level folder fits. Answer with the folder's own name, never the path.`;

/**
 * Folder descriptions keyed by lowercase name: { name, text, source } (folder-descriptions.js).
 * A string value is accepted as the text alone.
 */
export const readDescriptions = () => readAll();

const descriptionOf = (value) => (typeof value === 'string' ? { text: value } : (value || {}));

/**
 * Folders as the model sees them: every workspace on a chat (never the catch-all, which is no
 * folder), with its most recent titles, plus every folder he described by hand that has no chats
 * yet. `source` says whose words the description is: "manual" is his.
 */
export function foldersOf(conversations, descriptions = readDescriptions()) {
  const folders = new Map();
  for (const c of conversations) {
    const name = canonicalWorkspace(c?.workspace);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!folders.has(key)) {
      const d = descriptionOf(descriptions[key] ?? descriptions[name]);
      folders.set(key, { name, titles: [], description: String(d.text || ''), source: d.source || (d.text ? 'auto' : '') });
    }
    const f = folders.get(key);
    if (c.title && c.title !== 'New chat' && f.titles.length < TITLES_PER_FOLDER) f.titles.push(c.title);
  }
  for (const [key, value] of Object.entries(descriptions || {})) {
    const d = descriptionOf(value);
    const name = canonicalWorkspace(d.name || key);
    // A folder he described, or placed in the tree (a subfolder he made before any chat landed in it), is a folder.
    if (!name || folders.has(name.toLowerCase())) continue;
    const placed = typeof d.parentAt === 'string';
    if (d.removed === true && typeof d.removedAt === 'string' && !(placed && d.parentAt > d.removedAt)) continue;
    if (!placed && !(d.text && d.source === 'manual')) continue;
    folders.set(name.toLowerCase(), { name, titles: [], description: String(d.text || ''), source: d.text ? d.source || 'auto' : '' });
  }
  // The tree: each folder's parent from the shared folder metadata, its path from the top, listed depth first.
  const parentOf = (k) => { const d = descriptionOf(descriptions?.[k]); const p = typeof d.parentAt === 'string' ? d.parent || '' : ''; return p && folders.has(p) ? p : ''; };
  for (const [k, f] of folders) {
    const chain = [];
    for (let cur = k, n = 0; cur && n < 32; cur = parentOf(cur), n += 1) { if (chain.includes(cur)) break; chain.unshift(cur); }
    f.parent = parentOf(k) || null;
    f.path = chain.map((c) => folders.get(c).name);
  }
  // Depth first, siblings in the order they were found, so a subfolder is listed right under its parent.
  const out = [];
  const walk = (p) => { for (const [k, f] of folders) if ((f.parent || '') === p && !out.includes(f)) { out.push(f); walk(k); } };
  walk('');
  for (const f of folders.values()) if (!out.includes(f)) out.push(f); // a cycle in hand-edited metadata: listed anyway
  // An archived folder and everything inside it is not offered: the router never files into it. Nothing moves; unarchiving
  // offers it again.
  const isArchived = (k) => { const d = descriptionOf(descriptions?.[k]); return d.archived === true && typeof d.archivedAt === 'string'; };
  return out.filter((f) => !f.path.some((n) => isArchived(n.toLowerCase())));
}

/** The folder name the reply names, matched against the real folders; anything else (none, prose, a new name) is null. */
export function matchFolder(reply, folders) {
  const text = String(reply || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  let cleaned = text.replace(/^(?:folder|answer)\s*[:-]\s*/iu, '').replace(/^["'`*]+|["'`.*]+$/gu, '').trim().toLowerCase();
  if (!cleaned || cleaned === 'none') return null;
  // A path answer ("a > b") names its last folder.
  if (!folders.some((f) => f.name.toLowerCase() === cleaned) && cleaned.includes(' > ')) cleaned = cleaned.split(' > ').pop().replace(/^["'`*]+|["'`.*]+$/gu, '').trim();
  return folders.find((f) => f.name.toLowerCase() === cleaned)?.name || null;
}

const describe = (f) => (f.description ? ` (${f.source === 'manual' ? 'his definition' : 'auto summary'}: ${f.description})` : '');

export async function askForFolder({ title, transcript, folders }, { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  if (!transcript.trim()) return null;
  if (!folders.length) return null;
  // A missing key or a failed call is an error the router logs, never a silent "none".
  if (!apiKey) throw new Error('no fast-model-api-key in the vault or TOPHAT_FAST_MODEL_API_KEY');
  const listing = folders.map((f) => `Folder "${(f.path || [f.name]).join(' > ')}"${describe(f)}:\n${f.titles.map((t) => `  - ${t}`).join('\n') || '  (no titled chats yet)'}`).join('\n\n');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      max_completion_tokens: 1500,
      temperature: 0,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `${listing}\n\nNew chat, titled "${title || '(untitled)'}":\n${transcript}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`router model answered HTTP ${response.status}: ${String(await response.text().catch(() => '')).slice(0, 200)}`);
  const body = await response.json();
  const reply = body.choices?.[0]?.message?.content;
  const name = matchFolder(reply, folders);
  if (!name && !/^\W*none\W*$/iu.test(String(reply || '').trim())) console.error(`[autoroute] unusable reply ${JSON.stringify(String(reply || '').slice(0, 120))}`);
  return name;
}

const HOST_PROMPT = `You choose which host should run a new chat thread. The user lists his hosts, each with a description he wrote of which chats belong there.
Reply with ONLY one of:
  - the exact id of the one host whose description clearly covers the chat, or
  - none
none is the normal answer: the chat then runs on his own host, which costs nothing. Pick a host only when what the chat is actually about is what its description says goes there.
A chat that builds on, edits or reads files, projects, repositories or notes that live on his own host (a path, a project name, "my kit", "my design docs", memory he has there) stays on his own host: answer none, because the other host does not have those files.`;

const HOST_CONFIRM_PROMPT = `A chat may be sent to a separate host that other people can read. You are given the description its owner wrote of what belongs there, and the chat.
Answer with exactly one word: yes or no.
Answer yes only when the chat is clearly the work the description covers and contains nothing personal (private life, health, family, personal finances, friends). Anything else, or any doubt, is no.`;

async function complete({ system, user, maxTokens, fetchImpl, apiKey }) {
  if (!apiKey) throw new Error('no fast-model-api-key in the vault or TOPHAT_FAST_MODEL_API_KEY');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, max_completion_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  if (!response.ok) throw new Error(`router model answered HTTP ${response.status}: ${String(await response.text().catch(() => '')).slice(0, 200)}`);
  return String((await response.json()).choices?.[0]?.message?.content || '').trim();
}

/** The id of the host whose description covers the chat, or null. Candidates are hosts.js autoCandidates: described, opted in, reachable. */
export async function askForHost({ title, transcript, hosts }, { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  if (!transcript.trim() || !hosts.length) return null;
  const listing = hosts.map((h) => `Host "${h.id}" (${h.label}): ${h.description}`).join('\n');
  const reply = await complete({ system: HOST_PROMPT, user: `${listing}\n\nNew chat, titled "${title || '(untitled)'}":\n${transcript}`, maxTokens: 1500, fetchImpl, apiKey });
  const cleaned = reply.replace(/^["'`\s]+|["'`\s.]+$/gu, '').toLowerCase();
  console.log(`[autoroute] ${JSON.stringify({ event: 'host-pick-reply', title: title || null, reply: reply.slice(0, 200), transcript: transcript.slice(0, 600) })}`);
  return hosts.find((h) => h.id.toLowerCase() === cleaned)?.id || null;
}

/** The second call: does the description clearly cover this chat, with nothing personal in it. Any doubt is no. */
export async function confirmHost({ title, transcript, host }, { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  const reply = await complete({ system: HOST_CONFIRM_PROMPT, user: `Host description (written by its owner): ${host.description}\n\nChat titled "${title || '(untitled)'}":\n${transcript}`, maxTokens: 600, fetchImpl, apiKey });
  return /^\W*yes\b/iu.test(reply);
}

/** Whether he chose this chat's host himself (a conversation.host event that is not the router's). */
export function hostDecidedByOwner(store, id) {
  for (const event of store.allConversationEvents(id)) if (event.kind === 'conversation.host' && !event.content?.auto) return true;
  return false;
}

const sameFolder = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Whether the chat's folder is only provisional: the one the sidebar defaulted a new chat into, and
 * nobody has filed it since. That is no decision about this chat: a notes-app chat opened while the
 * device sat in "upkeep" stayed there because the router skipped every chat that had a workspace.
 */
export function defaultPlaced(store, id) {
  let placed = false;
  for (const event of store.allConversationEvents(id)) {
    if (event.kind === 'conversation.created' && event.content?.workspaceDefault && event.content?.workspace) placed = true;
    else if (event.kind === 'conversation.workspace') placed = false;
  }
  return placed;
}

/** Whether he has made a workspace decision on this chat himself (filed, moved or unfiled). */
function ownerDecided(store, id) {
  for (const event of store.allConversationEvents(id)) {
    if (event.kind === 'conversation.workspace' && !event.content?.auto) return true;
  }
  return false;
}

/**
 * Whether the router, not he, put this chat where it is: it has workspace events, every one of
 * them the router's (auto), and the last one filed it somewhere.
 */
export function routerFiled(store, id) {
  let last = null;
  for (const event of store.allConversationEvents(id)) {
    if (event.kind !== 'conversation.workspace') continue;
    if (!event.content?.auto) return false;
    last = event;
  }
  return Boolean(last);
}

export function createRouter({ store, file, ask = askForFolder, hosts = () => listHosts(), fileHost = (id, host) => store.append(id, 'conversation.host', { host, auto: true }, { at: new Date().toISOString() }), askHost = askForHost, confirm = confirmHost, onDecision = () => {}, delayMs = DELAY_MS, setTimeoutImpl = setTimeout, setIntervalImpl = setInterval, descriptions = readDescriptions }) {
  const timers = new Map();
  const running = new Set();
  // Chats seen to hold a real folder: a filed chat costs one lookup per process, not a history scan per message.
  const settled = new Set();
  // A provisional chat that the model keeps leaving where it is stops being asked after STAY_LIMIT answers.
  const stays = new Map();
  // A chat the model answered "none" for is not asked again by the sweep until it has another turn.
  const declined = new Map();

  /** The first events of a chat are enough to see whether its folder was a default. */
  function createdAsDefault(id) {
    try { return store.conversationEvents(id, { after: 0, limit: 4 }).some((e) => e.kind === 'conversation.created' && e.content?.workspaceDefault); } catch { return true; }
  }

  // Chats whose host the router already decided for this many turns: a "none" is not asked again until the chat has another turn.
  const hostDeclined = new Map();
  const hostRunning = new Set();

  /**
   * Picks a host for a chat from the descriptions of the hosts he opted into auto-routing, and files it as an auto conversation.host
   * event. Never for a chat whose host he chose, never without a candidate, never without the second call's yes. A chat that already
   * has a host is left alone. Every decision that reached a model is logged.
   */
  // A chat whose host was settled before its first message ran (routeHostFirst): the later turn-end and sweep passes leave it where it runs,
  // so a pick that arrived after the local run began never moves the chat mid-conversation.
  const hostGated = new Set();

  async function routeHost(id, { text = '', gate = false, signal = null } = {}) {
    if (gate) hostGated.add(id);
    else if (hostGated.has(id)) return null;
    const conversation = store.conversation(id);
    if (!conversation || conversation.sidechat || conversation.host || hostRunning.has(id)) return null;
    // A host is picked for a brand-new chat only, on its first message; a chat past its first turn stays where it runs, whatever the
    // sweep or a later message would say.
    if ((conversation.turns || 0) > 1) return null;
    if (hostDeclined.get(id) === (conversation.turns || 0)) return null;
    const candidates = autoCandidates(hosts());
    if (!candidates.length) return null;
    if (hostDecidedByOwner(store, id)) return null;
    // On the gate (the first message has not run yet, so the log does not hold it) the message in hand is the whole chat.
    let transcript = transcriptFor(store.conversationProse(id));
    if (!transcript.trim() && text) transcript = transcriptFor([{ kind: 'message.user', content: { text } }]);
    if (!transcript.trim()) return null;
    hostRunning.add(id);
    try {
      const picked = await askHost({ title: conversation.title, transcript, hosts: candidates });
      const host = picked ? candidates.find((h) => h.id === picked) : null;
      let confirmed = false;
      if (host?.local) {
        // This host is a candidate like any host; picking it is the default placement, so there is nothing to file or confirm.
        console.log(`[autoroute] ${JSON.stringify({ event: 'router-host', chat: id, candidates: candidates.map((h) => h.id), picked: host.id, local: true })}`);
        hostDeclined.set(id, conversation.turns || 0);
        return null;
      }
      if (host) {
        try { confirmed = await confirm({ title: conversation.title, transcript, host }); } catch (cause) { console.error(`[autoroute] ${id}: host confirmation failed:`, cause?.message || cause); }
      }
      const entry = { event: 'router-host', chat: id, candidates: candidates.map((h) => h.id), picked: picked || null, confirmed };
      console.log(`[autoroute] ${JSON.stringify(entry)}`);
      try { onDecision(entry); } catch { /* logging never blocks routing */ }
      // He may have chosen a host while the model answered; a gated pick that came after the caller gave up waiting is not used (the chat already runs here).
      if (signal?.aborted) { console.log(`[autoroute] ${JSON.stringify({ event: 'router-host-late', chat: id, picked: picked || null, confirmed })}`); return null; }
      const now = store.conversation(id);
      if (!now || now.host || hostDecidedByOwner(store, id)) return null;
      if (!host || !confirmed) { hostDeclined.set(id, now.turns || 0); return null; }
      fileHost(id, host.id);
      return host.id;
    } catch (cause) {
      console.error(`[autoroute] ${id}: host routing failed:`, cause?.message || cause);
      return null;
    } finally { hostRunning.delete(id); }
  }

  async function route(id) {
    const conversation = store.conversation(id);
    if (!conversation || running.has(id) || settled.has(id)) return null;
    if (conversation.sidechat) return null;
    // The catch-all's name is no folder: a chat stored under it is unfiled. A chat in a real folder
    // is routed again only when that folder was provisional (a default); one he filed himself, or
    // one an earlier route filed for a reason, stays.
    const current = canonicalWorkspace(conversation.workspace);
    let provisional = false;
    if (current) {
      provisional = createdAsDefault(id) && defaultPlaced(store, id);
      if (!provisional) { settled.add(id); return null; }
    }
    if (ownerDecided(store, id)) { settled.add(id); return null; }
    const folders = foldersOf(store.conversations().filter((c) => c.id !== id), descriptions());
    running.add(id);
    try {
      const transcript = transcriptFor(store.conversationProse(id));
      if (!transcript.trim()) { console.error(`[autoroute] ${id}: empty transcript at route time`); return null; }
      const name = await ask({ title: conversation.title, transcript, folders });
      // Re-read: he may have filed it himself while the model was answering.
      const now = store.conversation(id);
      if (!now || ownerDecided(store, id)) return null;
      if (provisional) {
        if (!defaultPlaced(store, id)) return null;
        // A provisional chat stays when the model has no answer or names its own folder; it moves only to a different one.
        if (!name || sameFolder(name, now.workspace)) {
          const count = (stays.get(id) || 0) + 1;
          stays.set(id, count);
          if (count >= STAY_LIMIT) settled.add(id);
          console.log(`[autoroute] ${id}: stays in ${now.workspace}`);
          return null;
        }
      } else if (canonicalWorkspace(now.workspace)) {
        return null;
      }
      if (!name) {
        // No folder fits: the chat stays unfiled, which is Inbox. Never a new folder.
        declined.set(id, now.turns || 0);
        console.log(`[autoroute] ${id}: no folder fits, left unfiled`);
        return null;
      }
      file(id, name);
      settled.add(id);
      console.log(`[autoroute] ${id}: filed into ${name}${provisional ? ` (was ${conversation.workspace})` : ''}`);
      return name;
    } catch (cause) {
      console.error(`[autoroute] ${id}: failed:`, cause?.message || cause);
      return null;
    } finally {
      running.delete(id);
    }
  }

  let sweeping = false;
  /**
   * Routes every chat that has a message and no folder (archived ones only with {archived: true}),
   * oldest unfiled first, one at a time: the safety net under the per-message and per-turn
   * triggers, which are timers in memory and are lost by a restart or a failed call.
   */
  async function sweep({ archived = false, since = null, limit = 50 } = {}) {
    if (sweeping) return [];
    sweeping = true;
    const filed = [];
    try {
      const candidates = store.conversations()
        .filter((c) => !c.sidechat && (c.turns || 0) > 0 && (archived || !c.archived) && (!since || (c.createdAt || '') >= since)
          && !canonicalWorkspace(c.workspace) && !settled.has(c.id) && declined.get(c.id) !== (c.turns || 0))
        .slice(0, limit);
      for (const c of candidates) {
        const result = await route(c.id);
        if (result) filed.push({ id: c.id, folder: result });
      }
      // The host pass: chats active in the last day that have no host yet (routeHost asks nothing when no host is a candidate).
      if (autoCandidates(hosts()).length) {
        const recent = Date.now() - 24 * 60 * 60 * 1000;
        const pending = store.conversations().filter((c) => !c.sidechat && !c.archived && !c.host && (c.turns || 0) === 1 && Date.parse(c.updatedAt || 0) > recent).slice(0, limit);
        for (const c of pending) await routeHost(c.id);
      }
    } catch (cause) {
      console.error('[autoroute] sweep failed:', cause?.message || cause);
    } finally {
      sweeping = false;
    }
    return filed;
  }

  let refiling = false;
  /**
   * Owner-triggered second pass, after he edits descriptions: asks again for every chat the router
   * filed (routerFiled: never one he filed, moved or unfiled by hand) whose last router move is at
   * or after `since`, against the folders and descriptions as they are now, and moves it to the
   * answer, or unfiles it on "none". Returns [{ id, title, from, to }] for every chat asked, and
   * writes nothing with {dryRun: true}.
   */
  // `all`: his explicit ask covers chats he filed by hand and unfiled ones too, not only the router's; each move is still
  // an auto event, so a later hand move of his wins again.
  async function refile({ since = null, archived = false, dryRun = false, ids = null, limit = 100, all: everyChat = false } = {}) {
    if (refiling) return [];
    refiling = true;
    const out = [];
    try {
      const all = store.conversations();
      const candidates = all.filter((c) => !c.sidechat && (archived || !c.archived) && (!ids || ids.includes(c.id)) && (everyChat || routerFiled(store, c.id))
        && (!since || lastRouterMove(c.id) >= since)).slice(0, limit);
      for (const c of candidates) {
        const folders = foldersOf(all.filter((x) => x.id !== c.id), descriptions());
        const transcript = transcriptFor(store.conversationProse(c.id));
        if (!transcript.trim()) continue;
        let to;
        try { to = await ask({ title: c.title, transcript, folders }); } catch (cause) { console.error(`[autoroute] refile ${c.id}: failed:`, cause?.message || cause); continue; }
        // He may have touched it while the model answered.
        if (!everyChat && (ownerDecided(store, c.id) || !routerFiled(store, c.id))) continue;
        const from = canonicalWorkspace(store.conversation(c.id)?.workspace);
        const entry = { id: c.id, title: c.title, from, to: to || null };
        out.push(entry);
        if (!sameFolder(entry.from, entry.to)) {
          if (!dryRun) file(c.id, entry.to);
          console.log(`[autoroute] refile ${c.id}: ${entry.from ?? 'unfiled'} -> ${entry.to ?? 'unfiled'}${dryRun ? ' (dry run)' : ''}`);
        }
        settled.add(c.id);
      }
    } finally {
      refiling = false;
    }
    return out;
  }

  function lastRouterMove(id) {
    let at = '';
    for (const event of store.allConversationEvents(id)) if (event.kind === 'conversation.workspace') at = event.at || event.createdAt || at;
    return at;
  }

  /**
   * Unfiles every chat in a folder the router made (never one he made): each unfiling is an auto
   * conversation.workspace event, so it is no decision of his and the chat is routable again.
   * `force` lists chat ids to unfile even though a non-auto event put them there (an agent's tool
   * call, not his hand); the caller vouches for them.
   */
  function unfileFolder(name, { force = [], dryRun = false } = {}) {
    const moved = [];
    for (const c of store.conversations()) {
      if (!sameFolder(canonicalWorkspace(c.workspace), name)) continue;
      if (!routerFiled(store, c.id) && !force.includes(c.id)) continue;
      moved.push({ id: c.id, title: c.title, from: c.workspace, to: null });
      if (!dryRun) { file(c.id, null); settled.delete(c.id); }
    }
    return moved;
  }

  return {
    route,
    routeHost,
    /** Whether a first message has a host to be decided for: some opted-in, described host other than this one. */
    hasRemoteCandidate: () => autoCandidates(hosts()).some((h) => !h.local),
    sweep,
    refile,
    unfileFolder,
    schedule(id, delay = delayMs) {
      clearTimeout(timers.get(id));
      const timer = setTimeoutImpl(() => { timers.delete(id); Promise.resolve(route(id)).then(() => routeHost(id)).catch((cause) => console.error(`[autoroute] ${id}: failed:`, cause?.message || cause)); }, delay);
      timer?.unref?.();
      timers.set(id, timer);
    },
    /** Sweep shortly after boot and then every SWEEP_MS. */
    startSweeping({ bootMs = SWEEP_BOOT_MS, everyMs = SWEEP_MS } = {}) {
      const run = () => sweep().catch((cause) => console.error('[autoroute] sweep failed:', cause?.message || cause));
      setTimeoutImpl(run, bootMs)?.unref?.();
      const interval = setIntervalImpl(run, everyMs);
      interval?.unref?.();
      return interval;
    },
    cancelAll() { for (const t of timers.values()) clearTimeout(t); }
  };
}
