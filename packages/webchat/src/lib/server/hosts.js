// Hosts: the peers a chat can live on.
//
// A tophat instance is a peer on the hub (hub.tophat.md): every instance syncing through the same hub is a device row in each
// replica (`mc_devices`). A chat has one host, the peer whose runner answers it; its own transcript is kept on every peer that
// touched it (remote-runtime.js), so any peer can read it offline. Nothing here names a machine: the list is the hub's device
// list, "this machine" is the entry whose id is this instance's own device id, and a peer can host chats once this instance
// holds an address and token for its webchat.
//
// One file in the webchat state dir, hosts.json, one entry per hub device id:
//   { "<device id>": { "label"?, "url", "tokenFile", "description"?, "auto"?, "at"? } }
// `url` (the peer's webchat machine surface, normally a supervised port-forward on loopback) and `tokenFile` (that peer's
// service token) are written by hand once per peer. `description` and `auto` (the router may choose this host) are edited from
// the host menu; the newest edit per host wins on an offline replay, and the server is their only writer (temp + rename).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { webchatStorePath } from './paths.js';

const FILE = () => webchatStorePath('hosts.json');
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;

/** This instance's own device id on the hub (the deploy env names it), or '' when the instance has no hub identity. */
export const selfDevice = (env = process.env) => String(env.TOPHAT_DEVICE || '').trim();

export function readHosts(file = FILE()) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeHosts(all, file = FILE()) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, file);
}

/** The hub's device rows from this instance's replica: [{ id, user }]. Unreadable or absent replica = no peers known from the hub. */
export function hubPeers({ db = process.env.TOPHAT_RUNNER_DB } = {}) {
  if (!db || !existsSync(db)) return [];
  let handle;
  try {
    handle = new DatabaseSync(db, { readOnly: true });
    return handle.prepare('SELECT device, user FROM mc_devices ORDER BY at').all().map((r) => ({ id: String(r.device), user: String(r.user) }));
  } catch { return []; } finally { try { handle?.close(); } catch { /* read-only handle */ } }
}

/** The peers this instance can run a chat on: { id: { id, label, url, tokenFile } }. Only a hub peer with an address and a token. */
export function loadRuntimes({ file = FILE(), peers = hubPeers(), self = selfDevice() } = {}) {
  const known = new Set(peers.map((p) => p.id));
  const out = {};
  for (const [id, v] of Object.entries(readHosts(file))) {
    if (id === self || !v?.url || !v?.tokenFile) continue;
    // A configured peer the hub does not list is still reachable (a replica that has not synced yet): the hub list adds names, it does not gate.
    if (peers.length && !known.has(id)) continue;
    out[id] = { id, label: String(v.label || id), url: String(v.url).replace(/\/+$/u, ''), tokenFile: String(v.tokenFile) };
  }
  return out;
}

/** What the host menu and the router read: the local entry first, then every hub peer, each with its address state and notes. */
export function listHosts({ file = FILE(), peers = hubPeers(), self = selfDevice() } = {}) {
  const all = readHosts(file);
  // This machine is a host like any other: its description and auto-routing flag live under its own device id.
  const mine = (self && all[self]) || {};
  const out = [{ id: '', label: String(mine.label || self || 'this machine'), local: true, configured: true,
    description: String(mine.description || ''), auto: mine.auto === true, at: mine.at || null }];
  for (const p of peers) {
    if (p.id === self) continue;
    const v = all[p.id] || {};
    // A hub device this instance holds no address for cannot run a chat: it is not offered.
    if (!(v.url && v.tokenFile)) continue;
    out.push({ id: p.id, label: String(v.label || p.id), user: p.user, local: false, configured: Boolean(v.url && v.tokenFile),
      description: String(v.description || ''), auto: v.auto === true, at: v.at || null });
  }
  return out;
}

/** Hosts the router may choose: reachable by this instance, opted in, and described in words (a host with no description is never a candidate). */
export const autoCandidates = (hosts, self = selfDevice()) => hosts.filter((h) => h.configured && h.auto && h.description.trim())
  .map((h) => (h.local ? { ...h, id: self || 'this-machine' } : h));

/** His edit from the host menu: `description` and/or `auto`. The newest `at` per host wins, so an offline replay changes nothing newer. */
export function setNote(id, { description, auto, at = null } = {}, file = FILE()) {
  const key = String(id || '').trim();
  if (!DEVICE_ID.test(key)) return null;
  const all = readHosts(file);
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
  const cur = all[key] || {};
  if (at && cur.at && cur.at > when) return cur;
  const next = { ...cur, at: when };
  if (typeof description === 'string') { const clean = description.replace(/\s+/gu, ' ').trim().slice(0, 300); if (clean) next.description = clean; else delete next.description; }
  if (typeof auto === 'boolean') next.auto = auto;
  all[key] = next;
  writeHosts(all, file);
  return next;
}
