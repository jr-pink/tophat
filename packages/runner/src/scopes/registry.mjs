// Scope registry: who the accounts are and which scopes each may open.
//
// A scope is a boundary around context (chats, memory, files). Three kinds:
//   personal  one per account, only that account may open it (mine is not yours)
//   group a named set of accounts, e.g. "friends" (every employee) or "personal"
// a organisation registry service can replace the file later without changing this interface.
//
// File shape (see ../../tests/fixtures/scopes.example.json):
//   { version, accounts: { <accountId>: { emails:[...], name, groups:[...] } },
//     scopes:   { <scopeId>: { kind, label, owner?, members?, everyone?, serving? } } }
// A personal scope's owner is an account id. A group lists member account ids, or sets
// everyone:true for all accounts. serving names the host that serves the group; null means nothing
// serves it yet (defined in the registry, not reachable).
//
// Interface: loadRegistry(path), accountsFor(identity), canAccess(account, scopeId),
// listScopes(account). Every function after loadRegistry takes the registry as an optional last
// argument and otherwise uses the one most recently loaded.

import { readFileSync } from 'node:fs';

let current = null;

const norm = (email) => String(email || '').trim().toLowerCase();

export function parseRegistry(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || typeof raw !== 'object' || typeof raw.accounts !== 'object' || typeof raw.scopes !== 'object') {
    throw new Error('scope registry: needs "accounts" and "scopes" objects');
  }
  const byEmail = new Map();
  const accounts = {};
  for (const [id, acct] of Object.entries(raw.accounts)) {
    const emails = (acct.emails || []).map(norm).filter(Boolean);
    if (!emails.length) throw new Error(`scope registry: account ${id} has no email`);
    for (const e of emails) {
      if (byEmail.has(e)) throw new Error(`scope registry: ${e} belongs to two accounts`);
      byEmail.set(e, id);
    }
    accounts[id] = { id, name: acct.name || id, emails };
  }
  const scopes = {};
  for (const [id, s] of Object.entries(raw.scopes)) {
    if (s.kind === 'personal') {
      if (!accounts[s.owner]) throw new Error(`scope registry: personal scope ${id} has unknown owner ${s.owner}`);
    } else if (s.kind === 'group') {
      for (const m of s.members || []) {
        if (!accounts[m]) throw new Error(`scope registry: group ${id} has unknown member ${m}`);
      }
    } else {
      throw new Error(`scope registry: scope ${id} has unknown kind ${s.kind}`);
    }
    scopes[id] = {
      id,
      kind: s.kind,
      label: s.label || id,
      owner: s.owner || null,
      members: s.members || [],
      everyone: Boolean(s.everyone),
      serving: s.serving ?? null
    };
  }
  for (const [id, acct] of Object.entries(accounts)) {
    const personal = Object.values(scopes).find((s) => s.kind === 'personal' && s.owner === id);
    acct.personalScope = personal ? personal.id : null;
  }
  const autoDomains = (Array.isArray(raw.autoDomains) ? raw.autoDomains : []).map((d) => norm(d).replace(/^@/, '')).filter(Boolean);
  return { version: raw.version || 1, accounts, scopes, byEmail, autoDomains };
}

export function loadRegistry(path) {
  current = parseRegistry(readFileSync(path, 'utf8'));
  return current;
}

function use(registry) {
  const r = registry || current;
  if (!r) throw new Error('scope registry: loadRegistry(path) first');
  return r;
}

function inScope(registry, accountId, scope) {
  if (scope.kind === 'personal') return scope.owner === accountId;
  return scope.everyone || scope.members.includes(accountId);
}

// Self-serve: an address on one of the registry's `autoDomains` (identity is verified upstream, e.g. by auth.eng.pink) gets an
// account named after its local part, plus a personal scope, created in the parsed registry on first sight. Nothing is written to
// the file; a reload re-creates it on the next lookup. A local part that is not a plain id, or an id another address already owns,
// gets nothing.
function selfServe(r, email) {
  const at = email.lastIndexOf('@');
  if (at < 1 || !(r.autoDomains || []).includes(email.slice(at + 1))) return null;
  const id = email.slice(0, at);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || r.accounts[id]) return null;
  r.accounts[id] = { id, name: id, emails: [email], personalScope: `personal:${id}` };
  r.scopes[`personal:${id}`] = { id: `personal:${id}`, kind: 'personal', label: `${id} (personal)`, owner: id, members: [], everyone: false, serving: null };
  r.byEmail.set(email, id);
  return id;
}

// identity: an email string or {email}. Unknown identities get null (no account, no scopes).
export function accountsFor(identity, registry) {
  const r = use(registry);
  const email = norm(typeof identity === 'string' ? identity : identity?.email);
  const id = r.byEmail.get(email) || selfServe(r, email);
  if (!id) return null;
  const acct = r.accounts[id];
  const scopes = Object.values(r.scopes).filter((s) => inScope(r, id, s)).map((s) => s.id);
  return { account: id, name: acct.name, email, personalScope: acct.personalScope, scopes };
}

const accountId = (account) => (typeof account === 'string' ? account : account?.account);

export function canAccess(account, scopeId, registry) {
  const r = use(registry);
  const id = accountId(account);
  const scope = r.scopes[scopeId];
  if (!id || !r.accounts[id] || !scope) return false;
  return inScope(r, id, scope);
}

// Scope descriptors the account may open: personal first, then groups.
export function listScopes(account, registry) {
  const r = use(registry);
  const id = accountId(account);
  if (!id || !r.accounts[id]) return [];
  return Object.values(r.scopes)
    .filter((s) => inScope(r, id, s))
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'personal' ? -1 : 1))
    .map(({ id: sid, kind, label, serving }) => ({ id: sid, kind, label, serving }));
}
