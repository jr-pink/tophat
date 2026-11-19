// The door back into his home host for a chat that runs on another host.
//
// One door line per chat, one grant per turn. The grant (host-grant.js) is what a turn's work may do; the line is how the team host reaches
// this host. Lifetime of a grant: it lives while its own turn runs and while anything that turn started still runs (its subagents, background
// turns and jobs on the team host, tagged there with the grant id, and door commands here); when the last of those ends it closes after
// GRACE_MS. Hard cap: 2 h after his last message in the chat. The line lives while any grant of the chat is open. Inside a grant the door is
// plain access as his user (run, cat, put, ls).
//   server   one HTTP server per chat on 127.0.0.1:<ephemeral>, serving only the door's routes.
//   tunnel   `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<door port> <ssh name>` from this host to the team host (hosts.json `ssh`), so the door is
//            reachable only on the team host's loopback; reopened when it drops or when this host restarts.
//   key      one random key per line, delivered out of band: over the same ssh, on stdin, into ~/.tophat-doors/<chat>/ on the team host (0700
//            folder, 0600 `auth` header file, `port`, and the `door` tool). The tool sends the header from the file, so the key is in no
//            command line, no message, no feed and no memory row. The wire says only that a door exists and where the one tool is.
//   caller   an agent never handles an id or a path: `door run ...` at the one fixed per-chat path. The tool presents the key and the id of the
//            subagent it runs in (TOPHAT_AGENT_ID, which the team host's runner sets in every subagent's tools). THIS host decides: it asks the
//            team host's ledger which grant that subagent was started under and whether it still runs (GET /api/door?agent=), then serves the
//            call under that grant; an unknown or finished subagent, or a wrong key, is refused. A caller with no subagent id (the chat's own
//            session) is served under the chat's newest open grant.
//   restarts this host writes the open lines and grants (same ids, same key, cap deadline) to an owner-only file after every change, leaves the
//            installed tool alone when it stops, and on boot reopens server and tunnel and reinstalls the tool at the same path, so the team
//            host's agents find the door where it was. Doors past their cap are cleaned up instead. The team host restarting only fails the
//            lifetime probe, which counts as "still live" (the cap ends it), and its tool and ledger tags are files and rows that survive.
import { createServer } from 'node:http';
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXEC_OUTPUT_BYTES, EXEC_TIMEOUT_CAP_MS, EXEC_TIMEOUT_MS, GrantError, GRANT_TTL_MS, WRITE_BYTES, catPath, execCommand, listPath, logCall,
  reverseTunnelArgv, writePath } from './host-grant.js';
import { doorOf } from './door-work.js';

export const DOOR_PORTS = [47100, 47999]; // the team host's loopback ports a door may take (one per open chat)
export const TUNNEL_READY_MS = 15_000;
export const REMOTE_DIR = '.tophat-doors'; // under the team host user's home
export const GRACE_MS = 60_000;  // after the grant's turn and everything it started have ended
export const POLL_MS = 15_000;   // how often the team host is asked, after the turn, whether the grant's work still runs
export const RECONNECT_MS = 5_000; // between tries to bring a dropped tunnel (or a restored one) back

const pickPort = (rand = Math.random) => DOOR_PORTS[0] + Math.floor(rand() * (DOOR_PORTS[1] - DOOR_PORTS[0] + 1));
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_AGENT = /^[A-Za-z0-9_-]{1,64}$/u;
/** The chat's folder on the team host, relative to its user's home; the one `door` tool lives in it. */
export const chatDir = (chatId) => `${REMOTE_DIR}/${chatId}`;
export const toolPath = (chatId) => `~/${chatDir(chatId)}/door`;

/** What the team host's model reads: a door exists and where the one tool is (an absolute path when the install reported the home). No address, no key. */
export function doorNotice({ chatId, grantId, root, home = 'his home host', tool = toolPath(chatId) }) {
  return `[Automated event from ${home}: this turn has a door into ${home}, as his user: run commands, read and write his files (plain access, every call logged there). Tool: ${tool} (\`${tool} help\`; \`${tool} run COMMAND\`). It always works the same way, from any subagent or job, with no id or path to carry: it finds its own door, and if it says no door is reachable, ${home} is restarting, so retry in about 30 seconds. Commands start in ${root}. It stays open while this turn and the subagents, background turns and jobs it starts are running; give this line to any subagent that needs the door (door grant ${grantId}). Do only what the task needs.]`;
}
if (doorOf(doorNotice({ chatId: 'c', grantId: 'g1', root: '/r' }))?.grant !== 'g1') throw new Error('door-tag.mjs must read the grant out of the notice'); // one shape, two readers

// `$\{` below stands for the shell's dollar-brace (a template literal would interpolate it); __HOME__ / __ROOT__ / limits are filled in by doorScript.
const TOOL = String.raw`#!/bin/bash
# door: access to __HOME__ from this host (written by __HOME__; one fixed path per chat, replaced in place whenever __HOME__ reopens the door).
# The key stays in ./auth and never in argv. Which door and which grant is __HOME__'s decision: this tool only says who is calling.
D="$(cd "$(dirname "$0")" && pwd)"
WAIT="$DOOR_WAIT"; [ -n "$WAIT" ] || WAIT=20
AG="$TOPHAT_AGENT_ID"; case "$AG" in root_*) AG="";; esac
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
q() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
fail() { echo "door: $1" >&2; exit 125; }
down() { fail "no door into __HOME__ is reachable right now. __HOME__ may be restarting and reopens its doors when it is back, at this same path: retry in about 30 seconds. If it is still down after a few minutes, the door closed with its turn's work (or 2 hours after his last message) and reopens on his next message."; }
# call METHOD PATH [BODYFILE]: the answer lands in $T/out. Retries while the door is unreachable (nothing was sent, so a retry is safe); 1 when it answered an error.
call() {
  local t=$SECONDS code rc port A
  while :; do
    if [ -r "$D/auth" ] && [ -r "$D/port" ]; then
      port="$(cat "$D/port")"
      A=(-sS --connect-timeout 3 -m 700 -o "$T/out" -w '%{http_code}' -X "$1" -H @"$D/auth")
      [ -n "$AG" ] && A+=(-H "X-Door-Agent: $AG")
      [ -n "$3" ] && A+=(-H 'content-type: application/octet-stream' --data-binary @"$3")
      code="$(curl "$\{A[@]}" "http://127.0.0.1:$port$2" 2>/dev/null)"; rc=$?
    else code=000; rc=7; fi
    if [ "$rc" = 0 ]; then case "$code" in 2*) return 0;; 401|502|503) ;; *) return 1;; esac; fi
    [ $((SECONDS - t)) -ge "$WAIT" ] && down
    sleep 3
  done
}
err() { python3 -c 'import json,sys
try: print("door:", json.load(open(sys.argv[1]))["error"], file=sys.stderr)
except Exception: print("door: the door answered something unexpected", file=sys.stderr)' "$T/out"; exit 125; }
case "$1" in
  run) shift; [ $# -gt 0 ] || { echo "usage: door run COMMAND..." >&2; exit 2; }
       printf '%s' "$*" > "$T/body"
       call POST "/run?cwd=$(q "$DOOR_CWD")&timeout=$DOOR_TIMEOUT" "$T/body" || err
       python3 -c 'import json,sys
a=json.load(open(sys.argv[1]))
if "error" in a: print("door:", a["error"], file=sys.stderr); sys.exit(125)
sys.stdout.write(a["stdout"]); sys.stderr.write(a["stderr"])
if a.get("truncated"): print("\n[door: output cut at the size cap]", file=sys.stderr)
if a.get("timedOut"): print("[door: killed at the timeout]", file=sys.stderr)
sys.exit(a["exit"] if isinstance(a.get("exit"), int) else 124)' "$T/out" ;;
  cat) [ -n "$2" ] || { echo "usage: door cat PATH > local" >&2; exit 2; }; call GET "/cat?path=$(q "$2")" || err; cat "$T/out" ;;
  put) [ -n "$2" ] || { echo "usage: door put PATH < local" >&2; exit 2; }; cat > "$T/body"; call PUT "/put?path=$(q "$2")" "$T/body" || err; cat "$T/out"; echo ;;
  ls)  call GET "/ls?path=$(q "$\{2:-.}")" || err; python3 -c 'import json,sys; [print(e) for e in json.load(open(sys.argv[1]))["entries"]]' "$T/out" ;;
  status) call GET /ping || err; cat "$T/out"; echo ;;
  *) cat <<'USAGE'
door run COMMAND...      run on __HOME__ as his user (bash -c); exit code, stdout and stderr come back as its own
                         DOOR_CWD=DIR (default __ROOT__), DOOR_TIMEOUT=SECONDS (default __TIMEOUT__, max __TIMEOUT_CAP__); output cap __OUTPUT_KB__ KB
door cat PATH > local    read a file of his (relative paths are under __ROOT__, ~ is his home)
door put PATH < local    write a file of his (replaces it; folders are made)
door ls [DIR]            list a folder
door status              which door answers this call (grant, caller)
No ids, paths or keys to pass. DOOR_WAIT=SECONDS (default 20) is how long a call keeps retrying while __HOME__ is unreachable.
USAGE
     ;;
esac
`.replaceAll('$\\{', '${');

/** The `door` tool installed beside the key on the team host (bash + curl; python3 only to unpack answers). */
export function doorScript({ home = 'his home host', root }) {
  return TOOL.replaceAll('__HOME__', home).replaceAll('__ROOT__', root).replaceAll('__TIMEOUT_CAP__', `${EXEC_TIMEOUT_CAP_MS / 1000}`)
    .replaceAll('__TIMEOUT__', `${EXEC_TIMEOUT_MS / 1000}`).replaceAll('__OUTPUT_KB__', `${Math.round(EXEC_OUTPUT_BYTES / 1000)}`);
}

/**
 * The shell script, fed on ssh stdin, that installs the tool, the key and the port for a chat on the team host. Files are replaced atomically
 * (temp + rename), so a command running the tool while this runs never reads half a file; installing again over a live door changes nothing
 * but the port.
 */
export function installScript({ chatId, port, key, home, root }) {
  if (!SAFE_ID.test(chatId)) throw new Error('unsafe chat id');
  return `set -e; umask 077; C="$HOME/${chatDir(chatId)}"; mkdir -p "$C"; chmod 700 "$HOME/${REMOTE_DIR}" "$C"
w() { cat > "$1.new"; chmod "$2" "$1.new"; mv -f "$1.new" "$1"; }
w "$C/door" 700 <<'TOPHAT_DOOR_TOOL'
${doorScript({ home, root })}TOPHAT_DOOR_TOOL
w "$C/auth" 600 <<'TOPHAT_DOOR_AUTH'
Authorization: Bearer ${key}
TOPHAT_DOOR_AUTH
printf '%s' '${port}' | w "$C/port" 600
find "$C" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
printf 'TOPHAT_DOOR_TOOL=%s\\n' "$C/door"
`;
}
/** Takes the door down on the team host: key and port go; the tool stays, so a late call says plainly that no door is open. */
export const removeScript = (chatId) => {
  if (!SAFE_ID.test(chatId)) throw new Error('unsafe chat id');
  return `rm -f "$HOME/${chatDir(chatId)}/auth" "$HOME/${chatDir(chatId)}/port"\n`;
};

/** Run a shell script on the team host over ssh, script on stdin (so the key is never in an argv). */
export function sshScript(target, script, { spawn = spawnProcess, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'sh', '-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '', out = '';
    child.stdout?.on('data', (b) => { out = (out + b).slice(-4000); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stderr?.on('data', (b) => { err = (err + b).slice(-1000); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, why: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, why: code === 0 ? '' : `ssh exited ${code}: ${err.trim()}` }); });
    child.stdin.end(script);
  });
}

/**
 * `grants` is the host-grant.js book; `cwdOf(chatId)` the chat folder; `logPath` the append-only call log; `statePath` the owner-only file the open
 * lines and grants are kept in across restarts (none: nothing is kept). `spawn`, `remote`, `rand`, `now` are injectable for tests; `tunnel: false`
 * serves the door on loopback with no tunnel and no install (tests).
 *
 * Per grant: open(chat, runtime, host, hooks) mints a grant for the turn his message starts (a message that joins the turn still running reuses its
 * grant). turnEnded(chat, { probe }) says that turn's run has ended here; from then the grant is checked every `pollMs`: it is live while a door
 * command of it runs here or while `probe(grantId)` says the team host still runs work of it ({ live }: the turn itself, woken again, or
 * subagents, background turns and jobs tagged with it). It closes after `graceMs` without either, at the cap (`ttlMs` after his last message in
 * the chat). Only the close kills door commands still running. `hooks` = { probe(grantId), agent(agentId) -> { known, live, grant } }, both asking
 * the team host's ledger (remote-runtime.js); a probe that cannot reach it counts as live.
 */
export function createHostDoors({ grants, cwdOf, logPath, statePath = null, home = 'his home host', spawn = spawnProcess, remote = (target, script) => sshScript(target, script, { spawn }),
  log = (line) => console.log(line), readyMs = TUNNEL_READY_MS, rand = Math.random, ttlMs = GRANT_TTL_MS, graceMs = GRACE_MS, pollMs = POLL_MS, reconnectMs = RECONNECT_MS,
  now = () => Date.now(), tunnel = true, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  const lines = new Map();   // chat id -> { chatId, runtime, target, key, server, port, remotePort, child, hooks, tool, starting, retry, up }
  const doors = new Map();   // grant id -> { chatId, line, grant, root, running, inflight, turnLive, probe, idleSince, poll, cap, notice, seq }
  const current = new Map(); // chat id -> grant id of the turn running now
  const startedAt = now(), me = randomBytes(6).toString('hex'); // `me` tells this server's writes from another's (two can overlap in a handover)
  let seq = 0, superseded = false;

  // ---- the owner-only record of what is open, rewritten after every change (single writer, atomic temp + rename).
  /** False when another live process has taken the file over (a new server after a handover): this one then stops writing and keeps its hands off the team host. */
  function persist() {
    if (superseded) return false;
    if (!statePath) return true;
    try {
      let owner = null;
      try { owner = JSON.parse(readFileSync(statePath, 'utf8')).owner || null; } catch { /* none yet */ }
      if (owner && owner.id !== me && owner.at >= startedAt && alive(owner.pid)) { superseded = true; log('[host-door] another server owns the door record now; this one stops serving doors'); suspend(); return false; }
      const body = { version: 1, owner: { pid: process.pid, id: me, at: startedAt },
        lines: [...lines.values()].map((l) => ({ chatId: l.chatId, runtime: l.runtime, target: l.target, key: l.key, remotePort: l.remotePort, tool: l.tool, home,
          grants: [...doors.values()].filter((d) => d.line === l).map((d) => ({ id: d.grant.id, root: d.root, expiresAt: grants.get(d.grant.id)?.expiresAt ?? 0, turnEnded: !d.turnLive })) })) };
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      renameSync(tmp, statePath);
    } catch (cause) { log(`[host-door] could not write the door record: ${cause?.message || cause}`); }
    return true;
  }

  const openGrants = (line) => [...doors.values()].filter((d) => d.line === line).sort((a, b) => b.seq - a.seq);

  function stopLocal(d) { clearTimeout(d.poll); clearTimeout(d.cap); }
  function stopLine(line) {
    clearTimeout(line.retry); line.retry = null; line.up = false;
    const child = line.child; line.child = null;
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    try { line.server?.close(); line.server?.closeAllConnections?.(); } catch { /* already closed */ }
    line.server = null;
  }

  function close(grantId, why) {
    const d = doors.get(String(grantId));
    if (!d) return false;
    doors.delete(d.grant.id);
    if (current.get(d.chatId) === d.grant.id) current.delete(d.chatId);
    grants.revoke(d.grant.id);
    stopLocal(d);
    for (const c of d.running) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } } // a command outlives no grant
    const line = d.line, last = !openGrants(line).length;
    if (last) { lines.delete(line.chatId); stopLine(line); }
    if (!persist()) return true; // another server owns the record: leave the team host's files to it
    if (last && tunnel && line.target) remote(line.target, removeScript(line.chatId)).then((r) => { if (!r.ok) log(`[host-door] ${line.chatId}: could not remove the key on ${line.target} (${r.why}); the door is closed here anyway`); });
    log(`[host-door] closed ${d.chatId} grant ${d.grant.id} (${why})`);
    return true;
  }

  /** His message in the chat: every grant of it gets the full cap again, from now. */
  function bumpCap(chatId) {
    const until = now() + ttlMs;
    for (const d of doors.values()) {
      if (d.chatId !== chatId) continue;
      grants.extend(d.grant.id, until);
      clearTimeout(d.cap);
      d.cap = setTimeout(() => close(d.grant.id, 'hard cap'), ttlMs); d.cap.unref?.();
    }
    persist();
  }

  // After the turn: is anything of this grant still running? A probe that cannot reach the host counts as live (the cap still ends it).
  async function check(d) {
    if (doors.get(d.grant.id) !== d) return;
    const probe = d.probe || d.line.hooks?.probe;
    let live = d.turnLive || d.running.size > 0 || d.inflight > 0, why = live ? 'door call' : '';
    if (!live && probe) {
      try {
        const open = openGrants(d.line).map((x) => x.grant.id);
        const r = await probe(d.grant.id, { open, holder: open[0] === d.grant.id }); // the newest grant also holds what runs under a grant no longer open
        live = r == null ? true : Boolean(r.live); why = live ? (r?.why || 'host work') : ''; }
      catch (cause) { live = true; why = `host unreachable (${cause?.message || cause})`; }
    }
    if (doors.get(d.grant.id) !== d) return;
    if (live) d.idleSince = null;
    else if (d.idleSince == null) d.idleSince = now();
    if (!live && now() - d.idleSince >= graceMs) { close(d.grant.id, 'its turn and what it started have ended'); return; }
    const wait = live ? pollMs : Math.min(pollMs, Math.max(0, graceMs - (now() - d.idleSince)));
    clearTimeout(d.poll);
    d.poll = setTimeout(() => { check(d).catch((e) => log(`[host-door] check failed: ${e?.message || e}`)); }, wait); d.poll.unref?.();
  }

  /** Who a call is served as: the subagent it names, mapped by the team host's ledger to its grant, or the chat's newest open grant for the chat's own session. */
  async function callerGrant(line, agentId) {
    const open = openGrants(line).filter((d) => grants.get(d.grant.id));
    if (!agentId) { if (open[0]) return { d: open[0], agent: null }; throw new GrantError('no door grant is open for this chat', 403); }
    if (!SAFE_AGENT.test(agentId)) throw new GrantError('refused: not a subagent id', 403);
    let who;
    try { who = await line.hooks?.agent?.(agentId); } catch (cause) { throw new GrantError(`cannot check the caller on the team host right now (${cause?.message || cause}); retry`, 503); }
    if (!who?.known) throw new GrantError(`refused: ${agentId} is not a subagent of this chat`, 403);
    if (!who.live) throw new GrantError(`refused: subagent ${agentId} has finished, so its door is closed`, 403);
    const own = who.grant ? open.find((d) => d.grant.id === who.grant) : null;
    const d = own || open[0]; // a running subagent whose own grant has closed (resumed, or started under none) is served under the chat's newest open one
    if (!d) throw new GrantError('no door grant is open for this chat', 403);
    return { d, agent: agentId };
  }

  const sameKey = (given, key) => { const a = Buffer.from(String(given ?? '')), b = Buffer.from(key); return a.length === b.length && timingSafeEqual(a, b); };

  function serve(line) {
    const server = createServer(async (req, res) => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const body = async (cap) => { const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > cap) throw new GrantError(`body over ${cap} bytes`, 413); chunks.push(c); } return Buffer.concat(chunks); };
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /iu, '');
      if (!sameKey(bearer, line.key)) return send(401, { error: 'the door key was refused' });
      let who;
      try { who = await callerGrant(line, String(req.headers['x-door-agent'] || '')); }
      catch (cause) { return send(cause instanceof GrantError ? cause.status : 500, { error: cause.message }); }
      const { d: held, agent } = who;
      const g = grants.get(held.grant.id);
      if (!g) return send(403, { error: 'this door grant has ended' });
      // A call in flight keeps its grant open (check() above) from the moment it is accepted, not only once its command has spawned.
      held.inflight += 1; res.once('close', () => { held.inflight -= 1; });
      const url = new URL(req.url, 'http://door');
      if (req.method === 'GET' && url.pathname === '/ping') return send(200, { ok: true, chat: g.chatId, grant: g.id, agent });
      const path = url.searchParams.get('path');
      const base = { at: new Date().toISOString(), chat: g.chatId, grant: g.id, ...(agent ? { agent } : {}) };
      let line_ = null;
      try {
        if (req.method === 'GET' && url.pathname === '/ls') {
          const out = await listPath(g, path); line_ = { ...base, op: 'ls', path: out.path, status: 200 }; return send(200, out);
        }
        if (req.method === 'GET' && url.pathname === '/cat') {
          const out = await catPath(g, path); line_ = { ...base, op: 'cat', path: out.path, bytes: out.bytes.length, status: 200 };
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-size': String(out.size), 'x-truncated': String(out.truncated) });
          return res.end(out.bytes);
        }
        if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/put') {
          const out = await writePath(g, path, await body(WRITE_BYTES)); line_ = { ...base, op: 'put', path: out.path, bytes: out.bytes, sha256: out.sha256, status: 200 }; return send(200, out);
        }
        if (req.method === 'POST' && url.pathname === '/run') {
          const raw = await body(64_000);
          const json = /json/iu.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString('utf8') || '{}') : { shell: raw.toString('utf8') };
          const cwd = json.cwd || url.searchParams.get('cwd') || null;
          const timeoutSec = Number(json.timeoutSec || url.searchParams.get('timeout')) || 0;
          const out = await execCommand(g, { argv: json.argv, shell: json.shell, cwd, timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined },
            { onSpawn: (child) => { held.running.add(child); child.on('close', () => held.running.delete(child)); } });
          line_ = { ...base, op: 'run', cwd: out.cwd, command: json.argv || json.shell, exit: out.exit, signal: out.signal, timedOut: out.timedOut, ms: out.ms };
          return send(200, out);
        }
        return send(404, { error: 'not found' });
      } catch (cause) {
        const status = cause instanceof GrantError ? cause.status : (cause instanceof SyntaxError ? 400 : 500);
        line_ = { ...base, op: url.pathname.slice(1), path, status, error: String(cause?.message || cause).slice(0, 200) };
        return send(status, { error: status === 500 ? `door failed: ${cause?.message || cause}` : cause.message });
      } finally {
        if (line_) logCall(logPath, line_).catch((e) => log(`[host-door] log write failed: ${e.message}`));
      }
    });
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
  }

  // ssh prints "remote forward success" (with -v) once the team host listens; ExitOnForwardFailure makes a taken port an exit.
  function openTunnel(target, remotePort, localPort) {
    const argv = reverseTunnelArgv({ teamHost: target, remotePort, localPort });
    const child = spawn(argv[0], [...argv.slice(1, -1), '-v', argv.at(-1)], { stdio: ['ignore', 'ignore', 'pipe'] });
    return new Promise((resolve) => {
      let done = false, tail = '';
      const finish = (ok, why) => { if (done) return; done = true; clearTimeout(t); resolve({ ok, child, why }); if (!ok) { try { child.kill('SIGTERM'); } catch {} } };
      const t = setTimeout(() => finish(false, 'no forward within the time limit'), readyMs);
      child.stderr?.on('data', (b) => { tail = (tail + b).slice(-2000); if (/remote forward success/iu.test(tail)) finish(true); else if (/remote port forwarding failed|forward failed/iu.test(tail)) finish(false, 'port taken'); });
      child.on('exit', (code) => finish(false, `ssh exited ${code}: ${tail.split('\n').filter((l) => !/^debug/u.test(l)).slice(-2).join(' ').trim()}`));
      child.on('error', (e) => finish(false, e.message));
    });
  }

  /**
   * Bring the line up: its server, the reverse tunnel (the port it had first, else others) and the tool, key and port on the team host (same key,
   * same path). { ok, why }. Used for a new line, for one restored after a restart, and for one whose tunnel dropped.
   */
  async function connect(line) {
    if (!line.server) { try { line.server = await serve(line); } catch (cause) { return { ok: false, why: `server: ${cause.message}` }; } line.port = line.server.address().port; }
    if (!tunnel) { line.up = true; return { ok: true }; }
    let opened = null, why = '';
    for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
      const remotePort = attempt === 0 && line.remotePort ? line.remotePort : pickPort(rand);
      const t = await openTunnel(line.target, remotePort, line.port);
      if (t.ok) { opened = t; line.remotePort = remotePort; } else { why = t.why; log(`[host-door] ${line.chatId}: tunnel to ${line.target}:${remotePort} failed (${t.why})`); }
    }
    if (!opened) return { ok: false, why: `tunnel never came up (${why})` };
    const root = openGrants(line)[0]?.root || line.root;
    const installed = await remote(line.target, installScript({ chatId: line.chatId, port: line.remotePort, key: line.key, home, root }));
    if (!installed.ok) { try { opened.child.kill('SIGTERM'); } catch {} return { ok: false, why: `tool install failed: ${installed.why}` }; }
    const at = /TOPHAT_DOOR_TOOL=(\/\S+)/u.exec(installed.out || '')?.[1];
    if (at) line.tool = at; // absolute, so a subagent or job in any cwd finds it
    line.child = opened.child; line.up = true;
    opened.child.on('exit', () => {
      if (line.child !== opened.child) return; // stopped on purpose
      line.child = null; line.up = false;
      if (lines.get(line.chatId) === line && !superseded) { log(`[host-door] ${line.chatId}: tunnel dropped; reconnecting`); keepUp(line, 0); }
    });
    return { ok: true };
  }

  /** Keep trying to bring a line back until it is up or its last grant has closed (the cap ends them). */
  function keepUp(line, attempt) {
    clearTimeout(line.retry);
    line.retry = setTimeout(async () => {
      line.retry = null;
      if (lines.get(line.chatId) !== line || line.up || superseded) return;
      const r = await connect(line);
      if (lines.get(line.chatId) !== line || superseded) return;
      if (r.ok) { persist(); log(`[host-door] ${line.chatId}: door back up on ${line.target} 127.0.0.1:${line.remotePort}`); return; }
      if (attempt % 6 === 0) log(`[host-door] ${line.chatId}: door still down (${r.why}); trying again`);
      keepUp(line, attempt + 1);
    }, attempt === 0 ? 0 : reconnectMs);
    line.retry.unref?.();
  }

  function track(line, grant, root, { turnLive }) {
    const d = { chatId: line.chatId, line, grant, root, running: new Set(), inflight: 0, turnLive, probe: null, idleSince: null, poll: null, cap: null, seq: (seq += 1),
      notice: doorNotice({ chatId: line.chatId, grantId: grant.id, root, home, ...(line.tool ? { tool: line.tool } : {}) }) };
    const left = Math.max(1000, (grants.get(grant.id)?.expiresAt ?? now() + ttlMs) - now());
    d.cap = setTimeout(() => close(grant.id, 'hard cap'), left); d.cap.unref?.();
    doors.set(grant.id, d);
    return d;
  }

  /**
   * The notice for this chat's message to `runtimeId` (its hosts.json entry `host`). A message that joins the turn running now gets that
   * turn's notice; otherwise a new grant for the turn it starts, on the chat's line (opened here when the chat has none). '' when the host
   * has no `ssh` name or the door cannot open (logged; the message still goes, without a door).
   */
  async function open(chatId, runtimeId, host, hooks = null) {
    const id = String(chatId);
    bumpCap(id);
    const live = doors.get(current.get(id));
    if (hooks && live) live.line.hooks = hooks;
    if (live && live.turnLive && live.runtime === runtimeId) return live.notice;
    if (live) { live.turnLive = false; current.delete(id); persist(); check(live).catch(() => {}); } // moved host: its own work keeps it, as any ended turn
    const target = host?.ssh;
    if (!target || !SAFE_ID.test(id)) return '';
    let root;
    try { root = await realpath(cwdOf(id)); } catch { log(`[host-door] ${id}: chat folder unreadable, no door`); return ''; }
    let line = lines.get(id), fresh = false;
    if (!line) {
      fresh = true;
      line = { chatId: id, runtime: runtimeId, target, key: randomBytes(24).toString('base64url'), server: null, port: 0, remotePort: 0, child: null, hooks, tool: null, root, starting: null, retry: null, up: false };
      lines.set(id, line);
      line.starting = connect(line);
    } else if (hooks) line.hooks = hooks;
    if (line.starting) {
      const r = await line.starting; line.starting = null;
      if (!r.ok) {
        if (fresh && lines.get(id) === line && !openGrants(line).length) { lines.delete(id); stopLine(line); }
        log(`[host-door] ${id}: no door (${r.why})`); return '';
      }
    }
    const grant = grants.grant(id, root, { ttlMs });
    const d = track(line, grant, root, { turnLive: true });
    d.runtime = runtimeId;
    current.set(id, grant.id);
    persist();
    log(`[host-door] opened ${id} grant ${grant.id} -> ${target} 127.0.0.1:${line.remotePort} (cwd ${root})`);
    return d.notice;
  }

  /** The run of the chat's current turn ended here. `probe(grantId)` asks the team host whether work of that grant still runs. */
  function turnEnded(chatId, { probe = null } = {}) {
    const id = String(chatId);
    const d = doors.get(current.get(id));
    if (!d) return false;
    current.delete(id);
    d.turnLive = false; d.probe = probe || d.probe;
    persist();
    log(`[host-door] turn ended ${id} grant ${d.grant.id}; open while its work runs`);
    check(d).catch((e) => log(`[host-door] check failed: ${e?.message || e}`));
    return true;
  }

  /**
   * Boot: reopen what was open when this host stopped (same grants, key and tool path; the team host's agents notice nothing but a pause). A
   * grant past its cap is not restored; a chat with none left gets its key removed from the team host. `hooksFor(chatId, runtimeId)` gives the
   * probe and the caller lookup of that chat's team host. Each line comes up in the background, retrying until it does.
   */
  async function restore({ hooksFor = null } = {}) {
    if (!statePath) return 0;
    let saved;
    try { saved = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return 0; }
    let n = 0;
    for (const rec of saved.lines || []) {
      const live = (rec.grants || []).filter((g) => g.expiresAt > now() && g.root);
      if (!live.length || !SAFE_ID.test(rec.chatId) || !rec.key || !rec.target) {
        if (tunnel && rec.target && SAFE_ID.test(rec.chatId || '')) remote(rec.target, removeScript(rec.chatId)).then((r) => log(`[host-door] ${rec.chatId}: past its cap, key removed from ${rec.target}${r.ok ? '' : ` (failed: ${r.why})`}`));
        continue;
      }
      const line = { chatId: rec.chatId, runtime: rec.runtime, target: rec.target, key: rec.key, server: null, port: 0, remotePort: rec.remotePort || 0, child: null,
        hooks: hooksFor?.(rec.chatId, rec.runtime) || { probe: async () => { throw new Error('no team host attached yet'); } }, tool: rec.tool || null, root: live[0].root, starting: null, retry: null, up: false };
      lines.set(line.chatId, line);
      for (const g of live) {
        if (!grants.restore({ id: g.id, chatId: line.chatId, root: g.root, expiresAt: g.expiresAt })) continue;
        const d = track(line, grants.get(g.id), g.root, { turnLive: false });
        d.runtime = line.runtime;
        check(d).catch((e) => log(`[host-door] check failed: ${e?.message || e}`)); // the usual lifecycle resumes: live while the team host runs its work
      }
      n += 1;
      log(`[host-door] restoring ${line.chatId}: ${openGrants(line).length} grant(s) -> ${line.target}`);
      keepUp(line, 0);
    }
    persist(); // takes the record over from the process that wrote it
    return n;
  }

  /** The graceful stop: stop serving and tunnelling, keep every grant's record and the installed tool, so the next boot restores them. */
  function suspend() {
    for (const d of doors.values()) {
      stopLocal(d);
      for (const c of d.running) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
    }
    for (const line of lines.values()) stopLine(line);
  }

  return {
    open, turnEnded, restore, suspend,
    /** Close one grant now (by grant id), or every grant of a chat (by chat id). */
    close(idOrChat, why = 'closed') {
      if (doors.has(String(idOrChat))) return close(idOrChat, why);
      let any = false;
      for (const d of [...doors.values()]) if (d.chatId === String(idOrChat)) any = close(d.grant.id, why) || any;
      return any;
    },
    /** Close everything, key and all (tests; a graceful stop is `suspend`). */
    closeAll() { for (const g of [...doors.keys()]) close(g, 'closed'); },
    /** Where a chat's door answers on this host (for tests and a status page); the key is the secret the tool holds. */
    endpoint(chatId) { const l = lines.get(String(chatId)); return l ? { port: l.port, key: l.key, remotePort: l.remotePort, up: l.up } : null; },
    active() { return [...doors.values()].map((d) => ({ chat: d.chatId, grant: d.grant.id, runtime: d.runtime, port: d.line.port, remotePort: d.line.remotePort, root: d.root,
      turnLive: d.turnLive, running: d.running.size, idleSince: d.idleSince, notice: d.notice, up: d.line.up })); }
  };
}
