

import { execFile } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { UPLOAD_ROOT } from './uploads.js';
import { secretsDir } from './secrets.js';
import { refreshIndex, searchIndex } from './path-index.js';

const run = promisify(execFile);

// The working-directory roots: where a relative path is tried first and where shorthand search starts.
export const ROOTS = (process.env.WEBCHAT_ROOTS || (process.env.WEBCHAT_CWD || join(homedir(), '.local', 'share', 'tophat', 'workspace')))
  .split(':')
  .filter(Boolean)
  .map((root) => resolve(root.replace(/^~/u, homedir())));

// The owner is the only user and the session cookie is his, so everything under his home opens. The
// credential guard below stays the floor under this: secrets, vault, keychains,.ssh, keys and.env
// files are refused however they are named. /etc, /usr and the rest of the system still need the
// owner to have typed the path himself (ownerNamedPath).
const envList = (name, fallback) => (process.env[name] ?? fallback)
  .split(':').filter(Boolean).map((root) => resolve(root.replace(/^~(?=\/|$)/u, homedir())));
export const SCOPE = envList('WEBCHAT_OPEN_SCOPE', `${homedir()}:/tmp:/private:/etc:/var:/usr:/bin:/sbin:/opt:/Applications:/Library:/System:/Volumes`);

export const OPENABLE = [...new Set([...ROOTS, resolve(UPLOAD_ROOT), ...SCOPE])];

// Where agents work, so a relative path written from one of these folders can be found again from a
// chat whose cwd is the workspace. A trailing /* stands for every folder directly inside.
const PROJECT_ROOTS = () => envList('WEBCHAT_PROJECT_ROOTS',
  '~/projects/*:~/projects:~/.local/share:~/.local/state:~');

// transcripts written before that still name the old home.
const LEGACY_HOMES = () => (process.env.WEBCHAT_LEGACY_HOMES ?? '').split(':').filter(Boolean);
const currentHome = () => process.env.WEBCHAT_HOME || homedir();

const MIME = {
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', jsonl: 'application/x-ndjson',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', svelte: 'text/plain',
  py: 'text/x-python', sh: 'text/x-shellscript', css: 'text/css', html: 'text/html',
  csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', sql: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', avif: 'image/avif',
  webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', heic: 'image/heic',
  // An epub served as octet-stream gives iOS Safari nothing to hand to Books, only Save to Files.
  epub: 'application/epub+zip', zip: 'application/zip'
};

const MAX_TEXT_BYTES = 2_000_000;

// The narrower set the app writes to and works in (roots plus uploads), for what publishes a file to
// the public web (/api/quicklook): widening what the owner may preview did not widen what he publishes.
export const WORK_ROOTS = [...new Set([...ROOTS, resolve(UPLOAD_ROOT)])];
export function withinWorkRoots(target) {
  return WORK_ROOTS.some((root) => target === root || target.startsWith(root + sep));
}

export function contained(target) {
  return OPENABLE.some((root) => target === root || target.startsWith(root + sep));
}

const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/u;

/**
 * The ways a path as written in a message may name a file, most literal first: as written, then with
 * wrapping quotes/backticks/angle brackets, a file:// scheme, %-encoding, a :line:col or #L42 suffix
 * and trailing sentence punctuation taken off, the legacy home mapped to the current one and ~
 * expanded. A leading ".../" (an elided prefix) can only be found by suffix search.
 */
export function pathForms(path) {
  const forms = [];
  const push = (text, elided = false) => {
    if (text && !forms.some((form) => form.text === text && form.elided === elided)) forms.push({ text, elided });
  };
  let text = String(path || '').trim();
  if (!text || text.length > 4096 || /[\u0000]/u.test(text)) return forms;
  const finish = (value) => {
    let out = value.replace(/^~(?=\/|$)/u, homedir());
    for (const legacy of LEGACY_HOMES()) {
      if (legacy !== currentHome() && (out === legacy || out.startsWith(`${legacy}/`))) out = currentHome() + out.slice(legacy.length);
    }
    return out;
  };
  push(finish(text));
  let clean = text.replace(/[,;.!?]+$/u, '').replace(/^[`'"<\u2018\u201c]+/u, '').replace(/[`'">\u2019\u201d]+$/u, '');
  if (/^file:\/\//iu.test(clean)) clean = clean.replace(/^file:\/\/(?:localhost)?/iu, '');
  if (/%[0-9a-f]{2}/iu.test(clean)) { try { clean = decodeURIComponent(clean); } catch {  } }
  clean = clean.replace(/#L\d+(?:-L?\d+)?$/u, '').replace(/(?::\d+){1,2}$/u, '');
  clean = clean.replace(/[.,;:!?]+$/u, '');
  if (clean.endsWith(')') && !clean.includes('(')) clean = clean.replace(/\)+$/u, '');
  clean = clean.trim();
  push(finish(clean));
  const elided = clean.match(/^(?:\.\.\.|\u2026)\/+(.+)$/u);
  if (elided) push(elided[1], true);
  return forms;
}

// For each base, the direct join, plus the join with any leading segments of the path dropped that
// repeat the base's own trailing segments: "workspace/jobs/x.png" under.../tophat/workspace
// is.../tophat/workspace/jobs/x.png, not.../workspace/workspace/jobs/x.png, and
// "tophat/webchat/src/app.html" under ~/projects/tophat/webchat is that repo's src/app.html.
function joinsOf(base, relative) {
  const out = [resolve(join(base, relative))];
  const head = relative.split('/').filter((part) => part && part !== '.');
  const tail = base.split(sep).filter(Boolean);
  for (let k = Math.min(head.length - 1, tail.length); k >= 1; k -= 1) {
    if (head.slice(0, k).join('/') === tail.slice(tail.length - k).join('/')) out.push(resolve(join(base, ...head.slice(k))));
  }
  return out;
}

let projectCache = { at: 0, list: [] };
function projectBases() {
  if (Date.now() - projectCache.at < 60_000) return projectCache.list;
  // First mention wins the order: the explicitly named projects before the rest of ~/projects.
  const list = [];
  for (const root of PROJECT_ROOTS()) {
    if (root.endsWith(`${sep}*`)) {
      const parent = root.slice(0, -2);
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) list.push(join(parent, entry.name));
        }
      } catch {  }
    } else list.push(root);
  }
  projectCache = { at: Date.now(), list: [...new Set(list)] };
  return projectCache.list;
}

function basesFor(cwd, context = []) {
  return [...new Set([cwd && resolve(cwd), ...context, ...ROOTS, resolve(UPLOAD_ROOT), ...projectBases()].filter(Boolean))];
}

export function resolvePath(path, cwd, context = []) {
  const candidates = [];
  for (const form of pathForms(path)) {
    if (form.elided) continue;
    if (isAbsolute(form.text)) candidates.push(resolve(form.text));
    else for (const base of basesFor(cwd, context)) candidates.push(...joinsOf(base, form.text));
  }
  const unique = [...new Set(candidates)];
  return unique.length ? unique : null;
}


// /api/file streams raw bytes to anyone holding a session cookie, so this list is the floor under every
// other check in this file. The shapes are the ones rev5/tools.mjs already refuses by path
// (SECRET_PATH), plus the two stores only this machine has: the Gmail OAuth grant directories named in
// TOPHAT_RUNNER_MAIL_ACCOUNTS and the keychains.
const CREDENTIAL_DIR = /\/\.(?:ssh|gnupg|aws|cloudflared|gmail-mcp[^/]*|kube|docker|password-store)(?:\/|$)|\/\.config\/[^/]+\/(?:secrets|vault)(?:\/|$)|\/\.config\/(?:gh|gcloud)(?:\/|$)|\/Keychains(?:\/|$)|\/Library\/Cookies(?:\/|$)|^\/(?:private\/)?etc\/(?:ssh|sudoers(?:\.d)?|master\.passwd|pam\.d)(?:\/|$)|^\/(?:private\/)?var\/(?:root|db\/(?:dslocal|sudo))(?:\/|$)/u;
const CREDENTIAL_FILE = /(?:^|\/)(?:vault-master-key|credentials\.json|\.credentials\.json|gcp-oauth\.keys\.json|\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|auth\.json|Cookies|Login Data(?: For Account)?|Web Data|kcpassword|[^/]*[Pp]asswords?[^/]*\.csv|[^/.]*(?:api-key|-token|password|passwd)[^/.]*|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(?:pem|key|p12|pfx|keychain|keychain-db))$/u;

function credentialRoots() {
  const named = [];
  try {
    for (const account of Object.values(JSON.parse(process.env.TOPHAT_RUNNER_MAIL_ACCOUNTS || '{}'))) {
      if (account && account.dir) named.push(String(account.dir));
    }
  } catch {  }
  const listed = [
    secretsDir(),
    process.env.TOPHAT_VAULT_DIR || join(homedir(), '.config', 'tophat', 'vault'),
    process.env.TOPHAT_VAULT_KEY_FILE || join(homedir(), '.config', 'tophat', 'vault-master-key'),
    join(homedir(), '.ssh'), join(homedir(), '.gnupg'), join(homedir(), '.aws'), join(homedir(), '.cloudflared'),
    join(homedir(), '.config', 'gcloud'), join(homedir(), 'Library', 'Keychains'), '/Library/Keychains',
    ...named
  ].map((root) => resolve(String(root).replace(/^~(?=\/|$)/u, homedir())));
  // Each root also in its resolved form: on this Mac /var and /tmp are symlinks into /private, so a
  // root named one way and a file reached the other way are the same directory. Not cached: a root
  // that does not exist yet when the first file is opened must still resolve once it does.
  const all = new Set(listed);
  for (const root of listed) { try { all.add(realpathSync(root)); } catch {  } }
  return [...all];
}

/** True when this path names a credential store, by its directory or by its own file name. */
export function credential(target) {
  const at = resolve(String(target || '').replace(/^~(?=\/|$)/u, homedir()).trim() || '/');
  if (CREDENTIAL_DIR.test(at) || CREDENTIAL_FILE.test(at)) return true;
  return credentialRoots().some((root) => at === root || at.startsWith(root + sep));
}

// The same question of the bytes rather than of the string: a symlink under an openable root that
// points at ~/.ssh/id_ed25519 is the same read. Containment stays lexical (a root may itself be a
// symlink); only the refusal follows the link.
async function credentialTarget(candidate) {
  if (credential(candidate)) return true;
  try { return credential(await realpath(candidate)); } catch { return false; }
}

/** True when any path this name could resolve to is a credential store; the route answers 403 for it. */
export async function namesCredential(path, cwd, context = []) {
  for (const candidate of resolvePath(path, cwd, context) || []) if (await credentialTarget(candidate)) return true;
  return false;
}

// Which candidate may be served. Inside an openable root, as before; inside the working directory of
// the conversation that is asking, because that directory is one the owner chose when he started that
// agent (15 of his conversations run with cwd ~/projects/tophat, which is outside the roots, and
// opening a file of that repo from the chat is the use namedOutright existed for). Nothing else: an
// absolute path that arrives from a model's message, from a tool result or from a hand-made query
// string is not served, which is the hole namedOutright left open -- it was true for every absolute
// path, so contained() was switched off for every absolute path.
export function openablePath(candidate, cwd, ownerNamed = false) {
  if (contained(candidate)) return true;
  if (cwd) {
    const at = resolve(cwd);
    if (candidate === at || candidate.startsWith(at + sep)) return true;
  }
  return Boolean(ownerNamed) && isAbsolute(candidate);
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Did the owner name this path himself, in the conversation that is asking for it? His own messages
 * (`message.user`) are the only source that may take a path outside the roots and the working
 * directory. A path a model wrote into a message or a tool result is not owner-typed, and neither is
 * one appended to the query string by whoever holds the cookie. The path has to appear as a whole
 * token, so "/etc" does not ride in on "/etc/hosts".
 */
export function ownerNamedPath(store, conversationId, path) {
  const wanted = String(path || '').trim();
  if (!store || typeof store.recentOfKinds !== 'function' || !conversationId || !wanted || wanted.length > 4096) return false;
  // Both the way he may have typed it and the way the query names it: "~/notes/plan.md" in his
  // message is the same file as the expanded absolute path in the link that was built from it.
  const forms = new Set([wanted, wanted.replace(/^~(?=\/|$)/u, homedir())]);
  if (wanted.startsWith(`${homedir()}/`)) forms.add(`~${wanted.slice(homedir().length)}`);
  const token = new RegExp(`(?:^|[\\s"'\`(<\\[])(?:${[...forms].map(escapeRe).join('|')})(?=$|[\\s"'\`)>\\],;:])`, 'u');
  let events = [];
  try { events = store.recentOfKinds(conversationId, ['message.user'], 400); } catch { return false; }
  for (const event of events) {
    const text = String(event.content?.text ?? '');
    if (!text) continue;
    if (token.test(text) || token.test(` ${text} `)) return true;
  }
  return false;
}

export async function locate(path, cwd, options = {}) {
  const found = await locateAny(path, cwd, options);
  return found && !found.directory ? found : null;
}

async function hitAt(candidate, extra = {}) {
  try {
    const info = await stat(candidate);
    if (info.isFile()) return { path: candidate, size: info.size, mtime: info.mtime.toISOString(), ...extra };
    if (info.isDirectory()) return { path: candidate, directory: true, mtime: info.mtime.toISOString(), ...extra };
  } catch {  }
  return null;
}

/**
 * Find the file a message named, deterministically and without a model: the path as written (and its
 * cleaned forms) against the conversation's cwd, the folders that conversation has been working in
 * (`context`, newest first), the roots and the known project folders, with root-segment overlap
 * dropped; then a moved absolute path by its tail inside its own repository; then shorthand (a bare
 * name, a partial or elided path) by suffix over git-tracked files and the workspace's files,
 * shallowest match first.
 */
export async function locateAny(path, cwd, { ownerNamed = false, context = [], deadline = Date.now() + LOOKUP_BUDGET_MS } = {}) {
  if (/^\s*https?:\/\//iu.test(String(path || ''))) return null;
  const forms = pathForms(path).filter((form) => !/^[a-z][a-z\d+.-]*:\/\//iu.test(form.text));
  for (const form of forms) {
    if (form.elided) continue;
    const candidates = isAbsolute(form.text)
      ? [resolve(form.text)]
      : basesFor(cwd, context).flatMap((base) => joinsOf(base, form.text));
    for (const candidate of new Set(candidates)) {
      if (!openablePath(candidate, cwd, ownerNamed)) continue;
      if (await credentialTarget(candidate)) continue;
      const hit = await hitAt(candidate);
      if (hit) return hit;
    }
  }
  for (const form of forms) {
    const hit = ELIDED_PART.test(form.text) && !form.elided
      ? await resolveElided(form.text, cwd, context, ownerNamed, deadline)
      : isAbsolute(form.text)
        ? await resolveMoved(form.text, cwd, deadline) || await resolveSiblingHome(form.text, cwd) || await resolveMovedIndexed(form.text, cwd)
        : await resolveShorthand(form.text, cwd, context, 'tracked', deadline) || await resolveIndexed(form.text, cwd, context) || await resolveShorthand(form.text, cwd, context, 'walks', deadline);
    if (hit) return hit;
  }
  return null;
}

// "contracts-stage/.../bell south city/SOURCE.md", "~/.local/state/tophat/runtime/releases/local-0e21.../src/x.mjs":
// a model shortened the middle of the path. The part before the elision is found as a folder, then
// its files are matched against the rest, "..." standing for any folders and "abc..." for any name
// starting abc; shallowest match.
const ELIDED_PART = /(?:^|\/)[^/]*(?:\.\.\.|\u2026)(?=\/|$)/u;
async function resolveElided(text, cwd, context, ownerNamed, hardDeadline = Infinity) {
  const parts = text.split('/');
  const at = parts.findIndex((part, index) => index > 0 && /(?:\.\.\.|\u2026)$/u.test(part));
  if (at < 1) return null;
  const prefix = parts.slice(0, at).join('/') || '/';
  const folder = await locateAny(`${prefix}/`, cwd, { ownerNamed, context, deadline: hardDeadline });
  if (!folder?.directory) return null;
  const rest = parts.slice(at).filter(Boolean);
  const found = [];
  let budget = 4_000;
  const deadline = Math.min(Date.now() + SEARCH_BUDGET_MS, hardDeadline);
  // Walk the folders the pattern allows, breadth first, so the shallowest match comes first.
  let frontier = [{ dir: folder.path, index: 0, depth: 0 }];
  while (frontier.length && !found.length && budget > 0 && Date.now() < deadline) {
    const next = [];
    for (const { dir, index, depth } of frontier) {
      if (budget-- <= 0) break;
      if (index === rest.length) { found.push(dir); continue; }
      const part = rest[index];
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      if (part === '...' || part === '\u2026') {
        next.push({ dir, index: index + 1, depth });
        if (depth < 10) for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') next.push({ dir: join(dir, entry.name), index, depth: depth + 1 });
        }
        continue;
      }
      const stem = part.match(/^(.*?)(?:\.\.\.|\u2026)$/u);
      for (const entry of entries) {
        if (stem ? entry.name.startsWith(stem[1]) : entry.name === part) next.push({ dir: join(dir, entry.name), index: index + 1, depth });
      }
    }
    frontier = next;
  }
  const target = found.sort((a, b) => a.length - b.length)[0];
  if (!target) return null;
  if (!openablePath(target, cwd, ownerNamed) || await credentialTarget(target)) return null;
  return hitAt(target, { shorthand: text });
}

// An absolute path that no longer exists, inside a repository that does: the file moved
// (src/eval/historic.mjs -> src/evaluation/...). Only a single tracked file whose path ends with the
// longest tail of the missing path counts; anything ambiguous stays a miss.
async function resolveMoved(absolute, cwd, hardDeadline = Infinity) {
  const target = resolve(absolute);
  if (!HAS_EXT.test(target)) return null;
  let at = dirname(target);
  for (let depth = 0; depth < 24; depth += 1) {
    const exists = await hitAt(at);
    if (exists?.directory) break;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  const repo = await gitRoot(at);
  if (!repo || !openablePath(repo, cwd)) return null;
  const parts = relativePath(repo, target).split(sep).filter(Boolean);
  let timer;
  const tracked = await Promise.race([trackedFiles(repo), new Promise((done) => { timer = setTimeout(() => done(null), Math.max(0, hardDeadline - Date.now())); })]);
  clearTimeout(timer);
  if (!tracked) return null;
  for (let from = 0; from < parts.length; from += 1) {
    const tail = parts.slice(from).join('/');
    const matches = tracked.filter((entry) => entry === tail || entry.endsWith(`/${tail}`));
    if (matches.length === 1) {
      const found = resolve(join(repo, matches[0]));
      if (await credentialTarget(found)) return null;
      return hitAt(found, { moved: absolute });
    }
    if (matches.length > 1) return null;
  }
  return null;
}

// An absolute path that names no file, written under ~/.local/state when the file is under ~/.local/share
// (or the reverse): an app keeps its state in one and its workspace in the other under the same name
// (the instance), and a reply that wrote the wrong half pointed at nothing. The same path under the
// other half is tried; it still has to be openable and not a credential.
async function resolveSiblingHome(absolute, cwd) {
  const target = resolve(absolute);
  const state = join(currentHome(), '.local', 'state') + sep;
  const share = join(currentHome(), '.local', 'share') + sep;
  const swap = target.startsWith(state) ? share + target.slice(state.length)
    : target.startsWith(share) ? state + target.slice(share.length) : null;
  if (!swap || !openablePath(swap, cwd) || await credentialTarget(swap)) return null;
  return hitAt(swap, { moved: absolute });
}

// An absolute path that no longer exists outside any repository (generated files: audio, renders,
// exports): the file whose path ends with the longest tail of the missing one, at least a folder and a
// name, found in the background file-name index. Only a single match counts; two files that share
// the tail are ambiguous and stay a miss.
async function resolveMovedIndexed(absolute, cwd) {
  const target = resolve(absolute);
  if (!HAS_EXT.test(target)) return null;
  refreshIndex();
  const parts = target.split(sep).filter(Boolean);
  for (let from = 0; from <= parts.length - 2; from += 1) {
    const tail = parts.slice(from).join('/');
    const matches = [];
    for (const candidate of await searchIndex(tail)) {
      if (candidate === target || COPY_FOLDERS.test(candidate) || !openablePath(candidate, cwd)) continue;
      if (await credentialTarget(candidate)) continue;
      matches.push(candidate);
    }
    if (matches.length === 1) return hitAt(matches[0], { moved: absolute });
    if (matches.length > 1) return null;
  }
  return null;
}

async function resolveShorthand(path, cwd, context = [], phase = 'tracked', hardDeadline = Infinity) {
  const wanted = String(path || '').replace(/^(?:\.\/)+/u, '').trim();
  if (!wanted || isAbsolute(wanted) || wanted.startsWith('~') || wanted.startsWith('..')) return null;
  const folder = wanted.endsWith('/');
  const needle = folder ? wanted.replace(/\/+$/u, '') : wanted;
  if (!needle) return null;
  // A name with an extension is specific enough to look for in every project; a bare folder name
  // ("graphs", "this/that") is only looked for where the conversation is working.
  const specific = !folder && HAS_EXT.test(needle);

  // A miss has to come back quickly too: the preview is waiting on it.
  const deadline = Math.min(Date.now() + SEARCH_BUDGET_MS, hardDeadline);
  for await (const { base, list } of await searchSpace(cwd, context, specific, deadline, phase)) {
    if (Date.now() > deadline) break;
    if (!list.length) continue;
    const hit = folder
      ? bestDirectory(list, needle)
      : (bestFile(list, needle) || bestDirectory(list, needle));
    if (!hit) continue;
    const target = resolve(join(base, hit));
    if (!openablePath(target, cwd)) continue;
    if (await credentialTarget(target)) continue;
    const found = await hitAt(target, { shorthand: wanted });
    if (found) return found;
  }
  return null;
}

// The last resort for a relative name: the background file-name index (path-index.js) of state,
// config, projects and his document folders. Several files may carry the name; the one nearest the
// conversation wins (inside a folder it worked in, then inside its cwd); among equals, copies in
// release folders and backups lose, then the shallowest. Every candidate still goes through the openable and
// credential checks, so being listed there serves nothing by itself.
const COPY_FOLDERS = /\/(?:releases|quarantine|backups?|snapshots?|\.Trash)(?:\/|$)/u;
async function resolveIndexed(path, cwd, context = []) {
  const wanted = String(path || '').replace(/^(?:\.\/)+/u, '').trim();
  if (!wanted || isAbsolute(wanted) || wanted.startsWith('~') || wanted.startsWith('..') || wanted.length > 1024) return null;
  refreshIndex();
  if (!wanted.endsWith('/') && !HAS_EXT.test(wanted)) return null;
  const folders = [...context, cwd && resolve(cwd)].filter(Boolean);
  const rank = (candidate) => {
    const near = folders.findIndex((folder) => candidate === folder || candidate.startsWith(folder + sep));
    return [near === -1 ? folders.length : near, COPY_FOLDERS.test(candidate) ? 1 : 0, candidate.split('/').length, candidate.length];
  };
  const hits = (await searchIndex(wanted)).map((line) => line.replace(/\/+$/u, '')).filter((candidate) => isAbsolute(candidate));
  const ranked = hits.map((candidate) => ({ candidate, key: rank(candidate) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3]);
  for (const { candidate } of ranked.slice(0, 20)) {
    if (!openablePath(candidate, cwd, false) || await credentialTarget(candidate)) continue;
    const hit = await hitAt(candidate, { shorthand: wanted });
    if (hit) return hit;
  }
  return null;
}

// Where shorthand is looked for, in order: the cwd's repository, the repositories of the folders the
// conversation has been working in, the repositories in and directly under the roots, the roots' own
// files when a root is not a repository (the workspace is not), then every project repository.
const CONTEXT_WALK_LIMIT = 8_000;
const SEARCH_BUDGET_MS = 1_500;
// One lookup, all its forms and fallbacks together: a miss answers in about this long, not once per form.
const LOOKUP_BUDGET_MS = 3_000;
async function searchSpace(cwd, context, specific, deadline = Infinity, phase = 'tracked') {
  const repos = [];
  const add = (repo) => { if (repo && !repos.includes(repo)) repos.push(repo); };
  add(await gitRoot(cwd));
  for (const dir of context) add(await gitRoot(dir));
  for (const repo of await rootRepos()) add(repo);
  const out = [];
  if (phase === 'walks') {
    // The folders the conversation worked in, walked as they are on disk: files a repository does not
    // track (an ignored sources/ folder, runtime state) are invisible to `git ls-files`, and the
    // background index can be half an hour old; "THEMES.md" or "outlines/" written from inside such a
    // folder means that one. The folder itself, then up to two levels above it (a chat that named
    // outlines/week1.md means the THEMES.md beside outlines/ too), never up to a repository root, a
    // root or a broad folder (/tmp, ~/projects, ~/.local/state), whose projects have their own search.
    const bases = projectBases();
    const walks = [];
    const broad = (dir) => ROOTS.includes(dir) || repos.includes(dir) || SCOPE.includes(dir) || bases.some((base) => base.startsWith(dir + sep));
    for (let up = 0; up < 3; up += 1) {
      for (const dir of context) {
        let at = dir;
        for (let k = 0; k < up && at !== dirname(at); k += 1) at = dirname(at);
        if (!broad(at) && !walks.includes(at)) walks.push(at);
      }
    }
    for (const dir of walks) out.push({ base: dir, lazy: () => walkedFiles(dir, CONTEXT_WALK_LIMIT, deadline) });
  } else {
    for (const repo of repos) out.push({ base: repo, lazy: () => trackedFiles(repo) });
    for (const root of ROOTS) if (!repos.includes(root)) out.push({ base: root, lazy: () => walkedFiles(root) });
    if (specific) {
      for (const base of projectBases()) {
        const repo = await gitRoot(base);
        if (repo && repo === base && !repos.includes(repo)) { repos.push(repo); out.push({ base: repo, lazy: () => trackedFiles(repo) }); }
      }
    }
  }
  // Lists are read only as the search reaches them.
  return {
    async *[Symbol.asyncIterator]() {
      for (const entry of out) {
        // A list that is slow to come (a cold `git ls-files`) does not hold the preview past its budget;
        // it keeps loading into the cache for the next lookup.
        const left = deadline - Date.now();
        if (left <= 0) return;
        let timer;
        const list = await Promise.race([entry.lazy(), new Promise((done) => { timer = setTimeout(() => done(null), left); })]);
        clearTimeout(timer);
        if (list === null) return;
        yield { base: entry.base, list };
      }
    }
  };
}

const shallowest = (candidates) => candidates
  .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];

function bestFile(tracked, needle) {
  const suffix = `/${needle}`;
  return shallowest(tracked.filter((entry) => entry === needle || entry.endsWith(suffix)));
}

function bestDirectory(tracked, needle) {
  const dirs = new Set();
  const prefix = `${needle}/`;
  const inner = `/${needle}/`;
  for (const entry of tracked) {
    if (entry.startsWith(prefix)) dirs.add(needle);
    else {
      const at = entry.indexOf(inner);
      if (at !== -1) dirs.add(entry.slice(0, at + inner.length - 1));
    }
  }
  return shallowest([...dirs]);
}

/** Tests create projects mid-run; the server's 60-second caches would hide them. */
export function resetFileCaches() {
  projectCache = { at: 0, list: [] };
  repoCache = { at: 0, list: [] };
  filesCache.clear();
  contextCache.clear();
}

const REPOS_TTL = 60_000;
let repoCache = { at: 0, list: [] };

async function gitRoot(cwd) {
  if (!cwd) return null;
  let at = resolve(cwd);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const info = await stat(join(at, '.git'));
      if (info) return at;
    } catch {  }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

async function rootRepos() {
  if (Date.now() - repoCache.at < REPOS_TTL) return repoCache.list;
  const list = [];
  for (const root of ROOTS) {
    try { await stat(join(root, '.git')); list.push(root); } catch {}
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const repo = join(root, entry.name);
      try {
        await stat(join(repo, '.git'));
        list.push(repo);
      } catch {  }
    }
  }
  repoCache = { at: Date.now(), list };
  return list;
}

// Tracked lists cost a `git ls-files` per repository; a minute was re-paid by the first preview of every minute.
const FILES_TTL = 300_000;
const filesCache = new Map();

// Lookups that arrive together (a page of previews) share one `git ls-files` per repository instead of
// each starting their own.
const loading = new Map();
async function trackedFiles(repo) {
  const cached = filesCache.get(repo);
  if (cached && Date.now() - cached.at < FILES_TTL) return cached.list;
  if (loading.has(repo)) return loading.get(repo);
  const job = (async () => {
    let list = [];
    try {
      const { stdout } = await run('git', ['-C', repo, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 });
      list = stdout.split('\0').filter(Boolean);
    } catch {  }
    filesCache.set(repo, { at: Date.now(), list });
    return list;
  })().finally(() => loading.delete(repo));
  loading.set(repo, job);
  return job;
}

// The files of a root that is not a repository (the workspace), for shorthand: dot folders and
// node_modules skipped, bounded in depth and count, cached like the tracked lists.
const WALK_LIMIT = 200_000;
async function walkedFiles(root, limit = WALK_LIMIT, deadline = Infinity) {
  const key = `walk:${limit}:${root}`;
  const cached = filesCache.get(key);
  if (cached && Date.now() - cached.at < (cached.ttl ?? 60_000)) return cached.list;
  const list = [];
  let folders = 0;
  let cut = false;
  const walk = async (dir, prefix, depth) => {
    if (Date.now() > deadline) { cut = true; return; }
    if (depth > 12 || list.length >= limit || folders >= limit / 4) return;
    folders += 1;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel, depth + 1);
      else if (list.length < limit) list.push(rel);
    }
  };
  await walk(root, '', 0);
  // A walk that ran out of time is remembered only briefly, so the same miss does not pay for it twice in a row.
  filesCache.set(key, { at: Date.now(), list, ttl: cut ? 15_000 : undefined });
  return list;
}

const CONTEXT_TTL = 20_000;
const contextCache = new Map();
const CONTEXT_PATH = /(?:^|[\s"'`(<\[=:])((?:~|\/(?:Users|Volumes|private|tmp|var|opt))\/[^\s"'`<>()[\]{},;:|*]+)/gu;

/**
 * The folders a conversation has been working in, newest first: every absolute or ~ path in its
 * recent messages and tool calls, reduced to the nearest existing folder. A relative path a model
 * writes ("src/lib/llm.mjs") is usually relative to one of these, not to the chat's cwd.
 */
export async function conversationDirs(store, conversationId) {
  if (!store || typeof store.recentOfKinds !== 'function' || !conversationId) return [];
  const cached = contextCache.get(conversationId);
  if (cached && Date.now() - cached.at < CONTEXT_TTL) return cached.dirs;
  let rows = [];
  try {
    rows = store.recentOfKinds(conversationId, ['message.user', 'assistant.message', 'tool.started'], 240);
  } catch { rows = []; }
  const seen = new Set();
  const named = [];
  for (const row of rows) {
    let text = '';
    try {
      const body = row.content || {};
      text = row.kind === 'tool.started' ? JSON.stringify(body.input ?? '') .replace(/\\n/gu, ' ') : String(body.text ?? '');
    } catch { text = ''; }
    for (const match of text.matchAll(CONTEXT_PATH)) {
      const form = pathForms(match[1]).at(-1)?.text;
      if (!form || !isAbsolute(form)) continue;
      const dir = HAS_EXT.test(form) ? dirname(form) : form.replace(/\/+$/u, '');
      if (!seen.has(dir)) { seen.add(dir); named.push(dir); }
      if (named.length >= 80) break;
    }
    if (named.length >= 80) break;
  }
  const dirs = [];
  for (const dir of named) {
    let at = dir;
    for (let depth = 0; depth < 6 && at !== dirname(at); depth += 1) {
      if ((await hitAt(at))?.directory) break;
      at = dirname(at);
    }
    if (at === dirname(at) || at === homedir() || !contained(at) || credential(at)) continue;
    if (!dirs.includes(at)) dirs.push(at);
    if (dirs.length >= 30) break;
  }
  contextCache.set(conversationId, { at: Date.now(), dirs });
  return dirs;
}

// The folders a conversation named that are not on this Mac: absolute paths in its recent messages and
// tool calls under another machine's home (/Users/server/server/inventory/boxes.yaml), reduced to
// their folder, newest first. A relative path written from such a chat ("inventory/boxes.yaml") is
// relative to one of these on that machine.
export async function conversationRemoteDirs(store, conversationId) {
  if (!store || typeof store.recentOfKinds !== 'function' || !conversationId) return [];
  let rows = [];
  try {
    rows = store.recentOfKinds(conversationId, ['message.user', 'assistant.message', 'tool.started'], 240);
  } catch { return []; }
  const dirs = [];
  const own = currentHome();
  for (const row of rows) {
    let text = '';
    try {
      const body = row.content || {};
      text = row.kind === 'tool.started' ? JSON.stringify(body.input ?? '').replace(/\\n/gu, ' ') : String(body.text ?? '');
    } catch { text = ''; }
    for (const match of text.matchAll(/(?:^|[\s"'`(<\[=:])(\/(?:Users|home)\/[^\s"'`<>()[\]{},;:|*]+)/gu)) {
      const form = pathForms(match[1]).at(-1)?.text;
      if (!form || form === own || form.startsWith(`${own}/`)) continue;
      if (LEGACY_HOMES().some((legacy) => form === legacy || form.startsWith(`${legacy}/`))) continue;
      const dir = HAS_EXT.test(form) ? dirname(form) : form.replace(/\/+$/u, '');
      if (dir.split('/').length > 3 && !dirs.includes(dir)) dirs.push(dir);
      if (dirs.length >= 20) return dirs;
    }
  }
  return dirs;
}

export async function listDirectory(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const rows = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(target, entry.name), directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return rows;
}

export function mimeFor(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function isText(path) {
  return !['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'pdf', 'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'epub', 'zip'].includes(String(path).split('.').pop().toLowerCase());
}

export async function readForPreview(found) {
  if (!isText(found.path)) return { binary: true };
  if (found.size > MAX_TEXT_BYTES) {
    const handle = await readFile(found.path);
    const head = handle.subarray(0, MAX_TEXT_BYTES);
    return head.includes(0) ? { binary: true } : { text: head.toString('utf8'), truncated: true };
  }
  // /bin/sh and an extensionless executable are bytes, not text.
  const bytes = await readFile(found.path);
  return bytes.includes(0) ? { binary: true } : { text: bytes.toString('utf8'), truncated: false };
}
