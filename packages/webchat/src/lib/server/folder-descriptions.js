// One-line description per folder (workspace), shown on the folder and read by the auto-router.
// Source 'auto' is rewritten daily from the folder's chats; source 'manual' (he edited it) is
// never overwritten. One file, written whole by temp+rename; the server is its only writer.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSecret } from './auth.js';
import { UNFILED, canonicalWorkspace, normalizeWorkspace } from '../core/workspaces.js';
import { webchatStorePath } from './paths.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const PATH = webchatStorePath('folder-descriptions.json');
const SEED = join(homedir(), '.config', 'tophat', 'folder-descriptions.json');
const ENDPOINT = process.env.WEBCHAT_TITLE_ENDPOINT || '' + (process.env.TOPHAT_FAST_MODEL_ENDPOINT || '');
const MODEL = process.env.WEBCHAT_TITLE_MODEL || 'gpt-oss-120b';

const key = (name) => String(normalizeWorkspace(name) || '').toLowerCase();

export function readAll(path = PATH) {
  let out = {};
  try { out = JSON.parse(readFileSync(path, 'utf8')) || {}; } catch {
    // First run: the hand-written seed he approved becomes manual descriptions.
    try {
      for (const [name, text] of Object.entries(JSON.parse(readFileSync(SEED, 'utf8')) || {})) out[key(name)] = { name, text: String(text), source: 'manual', at: new Date().toISOString() };
    } catch { /* no seed */ }
  }
  return out;
}

function writeAll(all, path = PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, path);
}

/** Text only, keyed by lowercase folder name: what the router and the page read. */
export function texts(path = PATH) {
  const all = readAll(path);
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.text || '']));
}

export function setManual(name, text, path = PATH, { at = null } = {}) {
  const k = key(name);
  if (!k) return null;
  const all = readAll(path);
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  // A device replays an edit from its outbox with the time he made it: the newest edit per folder
  // wins, so a replay changes nothing and two devices converge. A manual text is never replaced by an older one.
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  if (at && all[k]?.source === 'manual' && all[k].at > when) return all[k];
  // Clearing his text hands the folder back to the daily generator; where the folder sits stays.
  if (!clean) { if (all[k]) all[k] = withoutText(all[k]); if (all[k] && !hasMeta(all[k])) delete all[k]; }
  else all[k] = { ...(all[k] || {}), name: normalizeWorkspace(name), text: clean, source: 'manual', at: when };
  writeAll(all, path);
  return all[k] || null;
}

// Folder nesting. The tree is shared, here, beside the descriptions, so every device and the router see one tree:
// `parent` is the lowercase key of the folder it sits in ('' = top level; UNFILED = inside Inbox). Newest edit per folder
// wins by `parentAt`, so a replayed edit changes nothing and two devices converge. Membership still rides on each chat
// (conversation.workspace). A folder has a place once a parent edit reached it (parentAt), top level ('') included: an
// explicit statement that wins over any device's old local layout.
const hasPlace = (e) => typeof e?.parentAt === 'string';
// Folder archive: a flag beside the place, newest `archivedAt` wins. Nothing else about the folder changes.
const hasArchive = (e) => typeof e?.archivedAt === 'string';
const hasMeta = (e) => hasPlace(e) || hasArchive(e);
function withoutText(e) { const { text: _t, source: _s, at: _a, ...rest } = e; return rest; }

export function setParent(name, parent, path = PATH, { at = null } = {}) {
  const k = key(name);
  if (!k) return null;
  const p = typeof parent === 'string' ? (parent === UNFILED ? UNFILED : key(parent)) : '';
  if (p === k) return null;
  const all = readAll(path);
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  if (all[k]?.parentAt && all[k].parentAt > when) return all[k];
  // A cycle (k would sit inside its own subtree) is refused: the tree stays a tree on the server too.
  for (let cur = p, seen = 0; cur && cur !== UNFILED && seen < 64; cur = all[cur]?.parent || '', seen += 1) if (cur === k) return all[k] || null;
  const next = { ...(all[k] || { name: normalizeWorkspace(name) }), parent: p, parentAt: when };
  if (!next.name) next.name = normalizeWorkspace(name);
  if (!hasMeta(next) && !next.text) delete all[k]; else all[k] = next;
  writeAll(all, path);
  return all[k] || null;
}

export function setArchived(name, archived, path = PATH, { at = null } = {}) {
  const k = key(name);
  if (!k) return null;
  const all = readAll(path);
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  if (all[k]?.archivedAt && all[k].archivedAt > when) return all[k];
  all[k] = { ...(all[k] || { name: normalizeWorkspace(name) }), archived: archived === true, archivedAt: when };
  if (!all[k].name) all[k].name = normalizeWorkspace(name);
  writeAll(all, path);
  return all[k];
}

/** Each folder's parent key ('' = top level), keyed by lowercase folder name: what the router reads. */
export function parents(path = PATH) {
  return Object.fromEntries(Object.entries(readAll(path)).filter(([, v]) => hasPlace(v)).map(([k, v]) => [k, v.parent || '']));
}

const PROMPT = `You write a one-line description of a folder of chat threads, for a sidebar and for a router that files new chats.
Given the folder name and the titles of its chats, reply with ONLY one sentence (max 25 words) saying what the folder is about: the project, system or group its chats share. No quotes.`;

export async function describe(name, titles, { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  if (!apiKey || !titles.length) return null;
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, max_completion_tokens: 800, temperature: 0.2, messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `Folder: ${name}\nChats:\n${titles.map((t) => `- ${t}`).join('\n')}` }] })
  });
  if (!response.ok) return null;
  const body = await response.json();
  const text = String(body.choices?.[0]?.message?.content || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return text.replace(/^["'`]+|["'`]+$/gu, '').slice(0, 300) || null;
}

/** Regenerate every non-manual description from the chats now in each folder. */
export async function refreshAuto(conversations, { ask = describe, path = PATH, now = () => new Date() } = {}) {
  const folders = new Map();
  for (const c of conversations) {
    // The catch-all (Inbox) is no folder: nothing describes it, nothing is filed by it.
    const name = canonicalWorkspace(c?.workspace);
    if (!name || c.archived) continue;
    const k = name.toLowerCase();
    if (!folders.has(k)) folders.set(k, { name, titles: [] });
    if (c.title && c.title !== 'New chat' && folders.get(k).titles.length < 15) folders.get(k).titles.push(c.title);
  }
  const all = readAll(path);
  let changed = 0;
  // A generated description of a folder that has no chats now (or of the catch-all) is stale; his own stay.
  for (const [k, d] of Object.entries(all)) {
    if (d?.source === 'manual' || folders.has(k) || (!d?.text && hasMeta(d))) continue;
    if (hasMeta(d)) all[k] = withoutText(d); else delete all[k];
    changed += 1;
  }
  for (const [k, f] of folders) {
    if (all[k]?.source === 'manual') continue;
    let text = null;
    try { text = await ask(f.name, f.titles); } catch { text = null; }
    if (!text) continue;
    all[k] = { ...(all[k] || {}), name: f.name, text, source: 'auto', at: now().toISOString() };
    changed += 1;
  }
  if (changed || !Object.keys(readAll(path)).length) writeAll(all, path);
  return changed;
}

/** Run now (after a minute, so boot is quiet), then each day; a restart repeats it harmlessly. */
export function startDaily(getConversations, { setIntervalImpl = setInterval, setTimeoutImpl = setTimeout } = {}) {
  const run = () => refreshAuto(getConversations()).catch((cause) => console.error('[folder-descriptions]', cause?.message || cause));
  setTimeoutImpl(run, 60 * 1000)?.unref?.();
  setIntervalImpl(run, DAY_MS)?.unref?.();
}
