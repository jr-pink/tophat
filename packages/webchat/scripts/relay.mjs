#!/usr/bin/env node
// The relay: holds one conversation child's pipes so the child outlives the webchat server.
//
// The boot then revived it with a "carry on" nudge, which is a new process, a cut-off turn and a lost model
// call, on every deploy that changed server code.
//
// So the server no longer spawns the child itself. It spawns this relay, detached in its own session, and
// the relay spawns the child and keeps its pipes for the child's whole life. The server talks to the relay
// over a unix socket. A server that goes away leaves the child running and the relay holding its output;
// the next server attaches and reads on from exactly where the last one stopped.
//
// Exactly, because the webchat store cannot tell a replayed line from a new one: every line of the child's
// stdout gets a sequence number here, the relay keeps each line until a server has acknowledged it, and an
// attaching server names the first sequence it has not processed. Which one that is, the server knows from
// its own handover record (runner.js handoffAll), written after it stopped reading at a line boundary.
//
// Wire (one JSON object per line, both ways):
//   relay -> server  {t:'hello', v, childPid, nextSeq, exited}   then {t:'out', seq, line}, {t:'err', data},
//                    {t:'exit', code, signal}
//   server -> relay  {t:'attach', from}  {t:'ack', seq}  {t:'in', data}  {t:'end'}  {t:'signal', sig, group}
//                    {t:'release'}  (this server will not adopt the child again: exit once it does)
//                    {t:'exit-seen'} (the server has the exit; the relay can go)
//
// A relay nobody attaches to for TOPHAT_RELAY_ORPHAN_MS (15 minutes) ends its child and itself, so a crash
// that leaves no handover record cannot leave a child running for ever.
//
//   node relay.mjs DIR ID -- COMMAND [ARGS...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const RELAY_PROTOCOL = 1;
const ORPHAN_MS = Number(process.env.TOPHAT_RELAY_ORPHAN_MS || 15 * 60_000);
const RELEASE_KILL_MS = 5000;
const STDERR_KEEP = 64 * 1024;

const [dir, id, sep, command, ...args] = process.argv.slice(2);
if (!dir || !id || sep !== '--' || !command) {
  process.stderr.write('usage: relay.mjs DIR ID -- COMMAND [ARGS...]\n');
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const socketPath = path.join(dir, `${id}.sock`);
const manifestPath = path.join(dir, `${id}.json`);
try { fs.unlinkSync(socketPath); } catch {}

// The relay never dies of a broken socket or a stray error: losing it would lose the child's pipes.
process.on('uncaughtException', (error) => log(`kept alive after: ${error?.stack || error}`));
process.on('unhandledRejection', (error) => log(`kept alive after rejection: ${error?.stack || error}`));
for (const sig of ['SIGHUP', 'SIGPIPE']) process.on(sig, () => {});
function log(text) { try { fs.appendFileSync(path.join(dir, `${id}.log`), `${new Date().toISOString()} ${text}\n`); } catch {} }

const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
let nextSeq = 1;
const held = [];            // {seq, line} not yet acknowledged
let stderrTail = '';
let exited = null;          // {code, signal} once the child is gone
let released = false;
let peer = null;            // the attached server's socket
let sending = false;        // attached and streaming
let orphanTimer = null;

function writeManifest() {
  const manifest = { v: RELAY_PROTOCOL, id, relayPid: process.pid, childPid: child.pid ?? null,
    conversationId: process.env.TOPHAT_CONVERSATION_ID || null, command: path.basename(command),
    startedAt: new Date().toISOString() };
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 });
  fs.renameSync(tmp, manifestPath);
}

function send(message) {
  if (!peer || peer.destroyed) return false;
  try { return peer.write(`${JSON.stringify(message)}\n`); } catch { return false; }
}

function finish(why) {
  log(`exiting: ${why}`);
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(manifestPath); } catch {}
  process.exit(0);
}

function signalChild(sig, group = true) {
  if (exited || !(child.pid > 0)) return false;
  try { if (group) process.kill(-child.pid, sig); else child.kill(sig); return true; }
  catch { try { child.kill(sig); return true; } catch { return false; } }
}

function armOrphan() {
  clearTimeout(orphanTimer);
  orphanTimer = setTimeout(() => {
    if (peer) return;
    if (exited) finish('the child exited and no server came for its output');
    log(`no server for ${ORPHAN_MS}ms; ending the child`);
    released = true;   // nobody is coming for it: go as soon as the child does
    signalChild('SIGTERM');
    setTimeout(() => { signalChild('SIGKILL'); finish('orphaned'); }, RELEASE_KILL_MS).unref();
  }, ORPHAN_MS);
}

function maybeFinish() {
  if (exited && released) finish('released, and the child is gone');
}

// Child output, numbered. stdout is split on newlines; a trailing partial line waits for its newline.
let partial = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  partial += chunk;
  let at;
  while ((at = partial.indexOf('\n')) >= 0) {
    const line = partial.slice(0, at);
    partial = partial.slice(at + 1);
    const entry = { seq: nextSeq++, line };
    held.push(entry);
    if (sending) send({ t: 'out', ...entry });
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (data) => {
  stderrTail = `${stderrTail}${data}`.slice(-STDERR_KEEP);
  if (sending) send({ t: 'err', data });
});
for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {});
child.on('error', (error) => { log(`child error: ${error.message}`); });
let stdoutEnded = false;
child.stdout.on('end', () => { stdoutEnded = true; });
child.on('exit', (code, signal) => {
  // stdout can still hold bytes the exit raced. Wait for its end, but not for ever: a tool process left in
  // the child's group can hold the pipe open long after the child itself is gone.
  const announce = () => {
    if (exited) return;
    if (partial) { const entry = { seq: nextSeq++, line: partial }; partial = ''; held.push(entry); if (sending) send({ t: 'out', ...entry }); }
    exited = { code, signal };
    if (sending) send({ t: 'exit', ...exited });
    if (released) finish('released, and the child is gone');
  };
  if (stdoutEnded) setImmediate(announce);
  else { child.stdout.once('end', () => setImmediate(announce)); setTimeout(announce, 500).unref(); }
});

const server = net.createServer((socket) => {
  // One server at a time: a new connection is the new server.
  if (peer && peer !== socket) { try { peer.destroy(); } catch {} }
  peer = socket;
  sending = false;
  clearTimeout(orphanTimer);
  socket.setEncoding('utf8');
  let buffer = '';
  socket.write(`${JSON.stringify({ t: 'hello', v: RELAY_PROTOCOL, childPid: child.pid ?? null, nextSeq, exited })}\n`);
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(raw); } catch { continue; }
      handleServer(socket, message);
    }
  });
  const gone = () => {
    if (peer !== socket) return;
    peer = null;
    sending = false;
    maybeFinish();
    if (!(exited && released)) armOrphan();
  };
  socket.on('close', gone);
  socket.on('error', gone);
});

function dropThrough(seq) {
  while (held.length && held[0].seq <= seq) held.shift();
}

function handleServer(socket, message) {
  if (socket !== peer) return;
  switch (message.t) {
    case 'attach': {
      // Everything before `from` was processed by a server already; never send it again.
      dropThrough(Number(message.from) - 1);
      sending = true;
      for (const entry of held) send({ t: 'out', ...entry });
      if (stderrTail && message.stderr) send({ t: 'err', data: stderrTail });
      if (exited) send({ t: 'exit', ...exited });
      break;
    }
    case 'ack': dropThrough(Number(message.seq)); break;
    case 'in': if (!exited) { try { child.stdin.write(message.data); } catch {} } break;
    case 'end': try { child.stdin.end(); } catch {} break;
    case 'signal': signalChild(message.sig, message.group !== false); break;
    case 'release':
      released = true;
      if (exited) finish('released after the child exited');
      // A released relay whose child will not go is not left holding it.
      setTimeout(() => { if (!exited) signalChild('SIGKILL'); }, RELEASE_KILL_MS * 6).unref();
      break;
    case 'exit-seen':
      if (exited) finish('the server has the exit');
      break;
    default: break;
  }
}

server.listen(socketPath, () => {
  try { fs.chmodSync(socketPath, 0o600); } catch {}
  writeManifest();
  armOrphan();
});
server.on('error', (error) => { log(`socket error: ${error.message}`); signalChild('SIGTERM'); finish('could not listen'); });
