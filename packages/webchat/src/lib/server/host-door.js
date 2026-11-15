// The door back into the owner's home host for a chat that runs on another host (docs/HOST-DESIGN.md item 5): only for the chats he is in,
// only while the turn he started runs.
//
// The boundary is the per-turn grant (host-grant.js): a bearer token this host mints when a message of his starts a turn on the team host,
// held in memory. Lifetime: a grant
// lives while its own turn runs and while anything that turn started still runs (its subagents, background turns and jobs on the team
// host, tagged there with the grant id, and door commands here); when the last of those ends it closes after GRACE_MS. Hard cap: 2 h after
// his last message in the chat; a restart ends it too. A later turn gets its own grant; nothing of an earlier turn is cut off by it.
// Inside the grant the door is plain access as his user (run, cat, put, ls).
//   server   one HTTP server per grant on 127.0.0.1:<ephemeral>, serving only the door's routes for that grant.
//   tunnel   `ssh -N -R 127.0.0.1:<port>:127.0.0.1:<door port> <ssh name>` from this host to the team host (hosts.json `ssh`), so the
//            door is reachable only on the team host's loopback, only while the turn lives.
//   token    delivered out of band, never in the chat: over the same ssh, on stdin, into ~/.tophat-doors/<chat>/ on the team host (0700
//            folder, 0600 header file, the `door` tool beside it, one folder per grant); removed when the grant closes. The tool sends the header from the file, so the
//            token is in no command line, no message, no wire text, no feed and no memory row. The wire says only that a door exists and
//            where the tool is.
import { createServer } from 'node:http';
import { spawn as spawnProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { EXEC_OUTPUT_BYTES, EXEC_TIMEOUT_CAP_MS, EXEC_TIMEOUT_MS, GrantError, GRANT_TTL_MS, WRITE_BYTES, catPath, execCommand, listPath, logCall,
  reverseTunnelArgv, writePath } from './host-grant.js';
import { DOOR_TOOL_PATTERN } from './door-work.js';

export const DOOR_PORTS = [47100, 47999]; // the team host's loopback ports a door may take (one per open chat)
export const TUNNEL_READY_MS = 15_000;
export const REMOTE_DIR = '.tophat-doors'; // under the team host user's home
export const GRACE_MS = 60_000;  // after the grant's turn and everything it started have ended
export const POLL_MS = 15_000;   // how often the team host is asked, after the turn, whether the grant's work still runs

const pickPort = (rand = Math.random) => DOOR_PORTS[0] + Math.floor(rand() * (DOOR_PORTS[1] - DOOR_PORTS[0] + 1));
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_GRANT = /^[A-Za-z0-9]{1,64}$/u;
/** The grant's folder on the team host, relative to its user's home. */
export const grantDir = (chatId, grantId) => `${REMOTE_DIR}/${chatId}/${grantId}`;
export const toolPath = (chatId, grantId) => `~/${grantDir(chatId, grantId)}/door`;

/** What the team host's model reads: a door exists, where the tool is (an absolute path when the install reported the home). No address, no token. */
export function doorNotice({ chatId, grantId, root, home = 'his home host', tool = toolPath(chatId, grantId) }) {
  return `[Automated event from ${home}: this turn has a door into ${home}, as his user: run commands, read and write his files (plain access, every call logged there). Tool: ${tool} (\`${tool} help\`). Commands start in ${root}. It stays open while this turn and the subagents, background turns and jobs it starts are running; give this line to any subagent that needs the door. Do only what the task needs.]`;
}
if (!DOOR_TOOL_PATTERN.test(toolPath('c', 'g1'))) throw new Error('door-work.js DOOR_TOOL_PATTERN must match the tool path'); // one shape, two readers

/** The `door` tool installed beside the token on the team host (bash + curl; python3 only to unpack the run answer). */
export function doorScript({ home = 'his home host', root }) {
  return `#!/bin/bash
# door: this turn's access to ${home} (written by ${home}; removed when the turn and what it started have ended). The token stays in ./auth and never in argv.
D="$(cd "$(dirname "$0")" && pwd)"; B="http://127.0.0.1:$(cat "$D/port")"
q() { python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
case "$1" in
  run) shift; [ $# -gt 0 ] || { echo "usage: door run COMMAND..." >&2; exit 2; }
       printf '%s' "$*" | curl -sS -X POST -H @"$D/auth" -H 'content-type: text/plain' --data-binary @- "$B/run?cwd=$(q "\${DOOR_CWD:-}")&timeout=\${DOOR_TIMEOUT:-}" \\
       | python3 -c 'import json,sys
a=json.load(sys.stdin)
if "error" in a: print("door:", a["error"], file=sys.stderr); sys.exit(125)
sys.stdout.write(a["stdout"]); sys.stderr.write(a["stderr"])
if a.get("truncated"): print("\\n[door: output cut at the size cap]", file=sys.stderr)
if a.get("timedOut"): print("[door: killed at the timeout]", file=sys.stderr)
sys.exit(a["exit"] if isinstance(a.get("exit"), int) else 124)' ;;
  cat) [ -n "$2" ] || { echo "usage: door cat PATH > local" >&2; exit 2; }; curl -sS -f -H @"$D/auth" "$B/cat?path=$(q "$2")" ;;
  put) [ -n "$2" ] || { echo "usage: door put PATH < local" >&2; exit 2; }; curl -sS -f -X PUT -H @"$D/auth" --data-binary @- "$B/put?path=$(q "$2")"; echo ;;
  ls)  curl -sS -f -H @"$D/auth" "$B/ls?path=$(q "\${2:-.}")" | python3 -c 'import json,sys; [print(e) for e in json.load(sys.stdin)["entries"]]' ;;
  *) cat <<'USAGE'
door run COMMAND...      run on ${home} as his user (bash -c); exit code, stdout and stderr come back as its own
                         DOOR_CWD=DIR (default ${root}), DOOR_TIMEOUT=SECONDS (default ${EXEC_TIMEOUT_MS / 1000}, max ${EXEC_TIMEOUT_CAP_MS / 1000}); output cap ${Math.round(EXEC_OUTPUT_BYTES / 1000)} KB
door cat PATH > local    read a file of his (relative paths are under ${root}, ~ is his home)
door put PATH < local    write a file of his (replaces it; folders are made)
door ls [DIR]            list a folder
USAGE
     ;;
esac
`;
}

/** The shell script, fed on ssh stdin, that installs (or removes) the tool and the token on the team host. */
export function installScript({ chatId, grantId, port, token, home, root }) {
  if (!SAFE_ID.test(chatId)) throw new Error('unsafe chat id');
  if (!SAFE_GRANT.test(String(grantId))) throw new Error('unsafe grant id');
  const dir = `"$HOME/${grantDir(chatId, grantId)}"`;
  return `set -e; umask 077; mkdir -p "$HOME/${REMOTE_DIR}/${chatId}"; chmod 700 "$HOME/${REMOTE_DIR}" "$HOME/${REMOTE_DIR}/${chatId}"; rm -rf ${dir}; mkdir ${dir}
cat > ${dir}/auth <<'TOPHAT_DOOR_AUTH'
Authorization: Bearer ${token}
TOPHAT_DOOR_AUTH
printf '%s' '${port}' > ${dir}/port
cat > ${dir}/door <<'TOPHAT_DOOR_TOOL'
${doorScript({ home, root })}TOPHAT_DOOR_TOOL
chmod 700 ${dir}/door
printf 'TOPHAT_DOOR_DIR=%s\\n' ${dir}
`;
}
/** Removes one grant's folder, and the chat's folder once no grant is left in it. */
export const removeScript = (chatId, grantId) => {
  if (!SAFE_ID.test(chatId)) throw new Error('unsafe chat id');
  if (!SAFE_GRANT.test(String(grantId))) throw new Error('unsafe grant id');
  return `rm -rf "$HOME/${grantDir(chatId, grantId)}"; rmdir "$HOME/${REMOTE_DIR}/${chatId}" 2>/dev/null || true\n`;
};

/** Run a shell script on the team host over ssh, script on stdin (so the token is never in an argv). */
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
 * `grants` is the host-grant.js book; `cwdOf(chatId)` the chat folder; `logPath` the append-only call log. `spawn`, `remote`, `rand`, `now`
 * are injectable for tests; `tunnel: false` serves the door on loopback with no tunnel and no install (tests).
 *
 * Lifetime, per grant: open(chat) mints a grant for the turn his message starts (a message that joins the turn still running reuses its
 * grant). turnEnded(chat, { probe }) says that turn's run has ended here; from then the grant is checked every `pollMs`: it is live while a
 * door command of it runs here or while `probe(grantId)` says the team host still runs work of it ({ live }: the turn itself, woken again,
 * or subagents, background turns and jobs tagged with it). It closes after `graceMs` without either, at the cap (`ttlMs` after his last
 * message in the chat) or with its tunnel. Only the close kills door commands still running.
 */
export function createHostDoors({ grants, cwdOf, logPath, home = 'his home host', spawn = spawnProcess, remote = (target, script) => sshScript(target, script, { spawn }),
  log = (line) => console.log(line), readyMs = TUNNEL_READY_MS, rand = Math.random, ttlMs = GRANT_TTL_MS, graceMs = GRACE_MS, pollMs = POLL_MS,
  now = () => Date.now(), tunnel = true } = {}) {
  const doors = new Map();   // grant id -> { chatId, runtime, target, grant, server, port, remotePort, child, notice, running, turnLive, probe, idleSince, poll, cap }
  const current = new Map(); // chat id -> grant id of the turn running now

  function close(grantId, why) {
    const d = doors.get(String(grantId));
    if (!d) return false;
    doors.delete(d.grant.id);
    if (current.get(d.chatId) === d.grant.id) current.delete(d.chatId);
    grants.revoke(d.grant.id);
    clearTimeout(d.poll); clearTimeout(d.cap);
    try { d.child?.kill('SIGTERM'); } catch { /* already gone */ }
    for (const c of d.running) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } } // a command outlives no grant
    try { d.server.close(); d.server.closeAllConnections?.(); } catch { /* already closed */ }
    if (tunnel && d.target) remote(d.target, removeScript(d.chatId, d.grant.id)).then((r) => { if (!r.ok) log(`[host-door] ${d.chatId}: could not remove the tool on ${d.target} (${r.why}); the token is dead anyway`); });
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
  }

  // After the turn: is anything of this grant still running? A probe that cannot reach the host counts as live (the cap still ends it).
  async function check(d) {
    if (doors.get(d.grant.id) !== d) return;
    let live = d.turnLive || d.running.size > 0 || d.inflight > 0, why = live ? 'door call' : '';
    if (!live && d.probe) {
      try { const r = await d.probe(d.grant.id); live = r == null ? true : Boolean(r.live); why = live ? (r?.why || 'host work') : ''; }
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

  function serve(grant) {
    const server = createServer(async (req, res) => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const body = async (cap) => { const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > cap) throw new GrantError(`body over ${cap} bytes`, 413); chunks.push(c); } return Buffer.concat(chunks); };
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /iu, '');
      const g = grants.authorize(grant.id, bearer);
      if (!g) return send(404, { error: 'not found' });
      // A call in flight keeps its grant open (check() below) from the moment it is accepted, not only once its command has spawned.
      const held = doors.get(g.id);
      if (held) { held.inflight += 1; res.once('close', () => { held.inflight -= 1; }); }
      const url = new URL(req.url, 'http://door');
      const path = url.searchParams.get('path');
      const base = { at: new Date().toISOString(), chat: g.chatId, grant: g.id };
      let line = null;
      try {
        if (req.method === 'GET' && url.pathname === '/ls') {
          const out = await listPath(g, path); line = { ...base, op: 'ls', path: out.path, status: 200 }; return send(200, out);
        }
        if (req.method === 'GET' && url.pathname === '/cat') {
          const out = await catPath(g, path); line = { ...base, op: 'cat', path: out.path, bytes: out.bytes.length, status: 200 };
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-size': String(out.size), 'x-truncated': String(out.truncated) });
          return res.end(out.bytes);
        }
        if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/put') {
          const out = await writePath(g, path, await body(WRITE_BYTES)); line = { ...base, op: 'put', path: out.path, bytes: out.bytes, sha256: out.sha256, status: 200 }; return send(200, out);
        }
        if (req.method === 'POST' && url.pathname === '/run') {
          const raw = await body(64_000);
          const json = /json/iu.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString('utf8') || '{}') : { shell: raw.toString('utf8') };
          const cwd = json.cwd || url.searchParams.get('cwd') || null;
          const timeoutSec = Number(json.timeoutSec || url.searchParams.get('timeout')) || 0;
          const d = doors.get(g.id);
          const out = await execCommand(g, { argv: json.argv, shell: json.shell, cwd, timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined },
            { onSpawn: (child) => { if (d) { d.running.add(child); child.on('close', () => d.running.delete(child)); } } });
          line = { ...base, op: 'run', cwd: out.cwd, command: json.argv || json.shell, exit: out.exit, signal: out.signal, timedOut: out.timedOut, ms: out.ms };
          return send(200, out);
        }
        return send(404, { error: 'not found' });
      } catch (cause) {
        const status = cause instanceof GrantError ? cause.status : (cause instanceof SyntaxError ? 400 : 500);
        line = { ...base, op: url.pathname.slice(1), path, status, error: String(cause?.message || cause).slice(0, 200) };
        return send(status, { error: status === 500 ? `door failed: ${cause?.message || cause}` : cause.message });
      } finally {
        if (line) logCall(logPath, line).catch((e) => log(`[host-door] log write failed: ${e.message}`));
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
   * The notice for this chat's message to `runtimeId` (its hosts.json entry `host`). A message that joins the turn running now gets that
   * turn's notice; otherwise a new grant (and door) for the turn it starts. '' when the host has no `ssh` name or the door cannot open
   * (logged; the message still goes, without a door).
   */
  async function open(chatId, runtimeId, host) {
    const id = String(chatId);
    bumpCap(id);
    const live = doors.get(current.get(id));
    if (live && live.turnLive && live.runtime === runtimeId) return live.notice;
    if (live) { live.turnLive = false; current.delete(id); check(live).catch(() => {}); } // moved host: its own work keeps it, as any ended turn
    const target = host?.ssh;
    if (!target || !SAFE_ID.test(id)) return '';
    let root;
    try { root = await realpath(cwdOf(id)); } catch { log(`[host-door] ${id}: chat folder unreadable, no door`); return ''; }
    const grant = grants.grant(id, root, { ttlMs });
    const server = await serve(grant);
    const port = server.address().port;
    const fail = (why) => { log(`[host-door] ${id}: no door (${why})`); grants.revoke(grant.id); server.close(); return ''; };
    let child = null, remotePort = port, tool;
    if (tunnel) {
      let opened = null;
      for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
        remotePort = pickPort(rand);
        const t = await openTunnel(target, remotePort, port);
        if (t.ok) opened = t; else log(`[host-door] ${id}: tunnel to ${target}:${remotePort} failed (${t.why})`);
      }
      if (!opened) return fail('tunnel never came up');
      child = opened.child;
      const installed = await remote(target, installScript({ chatId: id, grantId: grant.id, port: remotePort, token: grant.token, home, root }));
      if (!installed.ok) { try { child.kill('SIGTERM'); } catch {} return fail(`tool install failed: ${installed.why}`); }
      const at = /TOPHAT_DOOR_DIR=(\/\S+)/u.exec(installed.out || '')?.[1];
      if (at) tool = `${at}/door`; // absolute, so a subagent or job in any cwd finds it
    }
    const d = { chatId: id, runtime: runtimeId, target, grant, server, port, remotePort, child, running: new Set(), inflight: 0, turnLive: true, probe: null, idleSince: null,
      poll: null, cap: null, notice: doorNotice({ chatId: id, grantId: grant.id, root, home, ...(tool ? { tool } : {}) }) };
    d.cap = setTimeout(() => close(grant.id, 'hard cap'), ttlMs); d.cap.unref?.();
    child?.on('exit', () => { if (doors.get(grant.id) === d) close(grant.id, 'tunnel ended'); });
    doors.set(grant.id, d);
    current.set(id, grant.id);
    log(`[host-door] opened ${id} grant ${grant.id} -> ${target} 127.0.0.1:${remotePort} (cwd ${root})`);
    return d.notice;
  }

  /** The run of the chat's current turn ended here. `probe(grantId)` asks the team host whether work of that grant still runs. */
  function turnEnded(chatId, { probe = null } = {}) {
    const id = String(chatId);
    const d = doors.get(current.get(id));
    if (!d) return false;
    current.delete(id);
    d.turnLive = false; d.probe = probe;
    log(`[host-door] turn ended ${id} grant ${d.grant.id}; open while its work runs`);
    check(d).catch((e) => log(`[host-door] check failed: ${e?.message || e}`));
    return true;
  }

  return {
    open, turnEnded,
    /** Close one grant now (by grant id), or every grant of a chat (by chat id). */
    close(idOrChat, why = 'closed') {
      if (doors.has(String(idOrChat))) return close(idOrChat, why);
      let any = false;
      for (const d of [...doors.values()]) if (d.chatId === String(idOrChat)) any = close(d.grant.id, why) || any;
      return any;
    },
    closeAll() { for (const g of [...doors.keys()]) close(g, 'server stopping'); },
    active() { return [...doors.values()].map((d) => ({ chat: d.chatId, grant: d.grant.id, runtime: d.runtime, port: d.port, remotePort: d.remotePort, root: d.grant.root,
      turnLive: d.turnLive, running: d.running.size, idleSince: d.idleSince, notice: d.notice })); }
  };
}
