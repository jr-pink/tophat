// The server's end of scripts/relay.mjs: a conversation child that lives in a relay process, presented
// to the runner as the ChildProcess it used to be (stdin, stderr, kill, 'exit', 'error').
//
// What is different, and why the runner asks for it by name:
//   - onLine(fn): output arrives here as numbered lines, and a line counts as processed only once fn has
//     returned. That number is what a handover records, so the next server reads on from the next line
//     and never writes an event into the store twice.
//   - pause(): stop at a line boundary (the handover), detach(): go without ending the child,
//     release(): this server is done with the child, let the relay go when the child does.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

export const RELAY_PROTOCOL = 1;
const ACK_EVERY = 64;
const ACK_MS = 250;

export function relaySocket(dir, id) { return path.join(dir, `${id}.sock`); }

export class RelayChild extends EventEmitter {
  constructor({ dir, id, from = 1, connectTimeoutMs = 5000 }) {
    super();
    this.relay = true;
    this.dir = dir;
    this.relayId = id;
    this.pid = undefined;
    this.processedSeq = from - 1;
    this.from = from;
    this.socket = null;
    this.outbox = [];            // server -> relay messages before the socket is up
    this.pending = [];           // lines (and the exit) received while paused or before a reader
    this.reader = null;
    this.paused = false;
    this.detached = false;
    this.exited = false;
    this.ackedSeq = this.processedSeq;
    this.ackTimer = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    const self = this;
    this.stdin = new Writable({
      write(chunk, _encoding, done) { self.#send({ t: 'in', data: String(chunk) }); done(); },
      final(done) { self.#send({ t: 'end' }); done(); },
    });
    this.#connect(Date.now() + connectTimeoutMs);
  }

  #connect(deadline) {
    if (this.exited) return;
    const socket = net.connect(relaySocket(this.dir, this.relayId));
    let buffer = '';
    let greeted = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => { this.socket = socket; });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (!greeted) {
          greeted = true;
          if (message.t !== 'hello' || message.v !== RELAY_PROTOCOL) {
            this.#fail(new Error(`relay ${this.relayId} speaks protocol ${message.v}, not ${RELAY_PROTOCOL}`));
            socket.destroy();
            return;
          }
          this.pid = message.childPid ?? undefined;
          socket.write(`${JSON.stringify({ t: 'attach', from: this.from })}\n`);
          for (const queued of this.outbox.splice(0)) socket.write(`${JSON.stringify(queued)}\n`);
          this.emit('attached', { childPid: this.pid, exited: message.exited });
          continue;
        }
        this.#receive(message);
      }
    });
    socket.on('error', (error) => {
      if (greeted) return;
      // No socket yet (ENOENT) or nothing listening on it yet (ECONNREFUSED): the relay may still be coming up.
      const starting = error.code === 'ENOENT' || error.code === 'ECONNREFUSED';
      if (starting && Date.now() < deadline) {
        setTimeout(() => this.#connect(deadline), 50).unref?.();
        return;
      }
      // Still nothing at the deadline: the relay is not there and will not be. That is a lost relay, not an
      // error of the conversation's: the runner picks the chat up again from its stored transcript, as it does
      // for a relay that dropped the connection below. Anything else (EACCES, ENOTSOCK) is a real fault.
      if (starting) { this.#lost(`could not reach relay ${this.relayId}: ${error.code}`); return; }
      this.#fail(new Error(`could not reach relay ${this.relayId}: ${error.code || error.message}`));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // A socket we did not close means the relay itself is gone, and the child's pipes with it.
      if (!this.detached && !this.exited) this.#exit(null, 'SIGKILL', { lostRelay: true });
    });
  }

  #fail(error) {
    if (this.exited) return;
    this.exited = true;
    this.emit('error', error);
  }

  // A relay that is gone for good: its socket never appeared, nothing listens on it, or it could not even be
  // spawned. the Mac account cutover that day left 941 conversations with a cwd under the old account, so
  // spawn() of their relay failed with ENOENT (swallowed), the socket never came, and every one of those chats
  // showed that line five times over. The runner handles { lostRelay: true } already (a fresh or resumed child
  // from the transcript), so a relay that never came up takes that path, with one line in the server log and
  // nothing in the chat.
  #lost(reason) {
    if (this.exited) return;
    console.error(`[relay] ${reason}; treating the relay as lost`);
    this.#exit(null, 'SIGKILL', { lostRelay: true, reason });
  }

  // For the spawner: the relay process itself failed to start (a cwd or executable that is not there), so
  // waiting out the connect deadline would only delay the same outcome.
  relayGone(reason) { this.#lost(reason); }

  #send(message) {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.write(`${JSON.stringify(message)}\n`); } catch {}
    } else if (!this.detached) this.outbox.push(message);
  }

  #receive(message) {
    if (message.t === 'err') { this.stderr.write(message.data); return; }
    if (message.t === 'out' || message.t === 'exit') {
      if (message.t === 'out' && message.seq <= this.processedSeq) return;
      if (this.paused || !this.reader || this.pending.length) { this.pending.push(message); this.#drain(); return; }
      this.#deliver(message);
    }
  }

  #deliver(message) {
    if (message.t === 'exit') { this.#exit(message.code ?? null, message.signal ?? null); return; }
    try { this.reader(message.line); }
    finally {
      this.processedSeq = message.seq;
      this.#ackSoon();
    }
  }

  #drain() {
    while (!this.paused && this.reader && this.pending.length) this.#deliver(this.pending.shift());
  }

  #ackSoon() {
    if (this.processedSeq - this.ackedSeq >= ACK_EVERY) { this.#ack(); return; }
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => { this.ackTimer = null; this.#ack(); }, ACK_MS);
    this.ackTimer.unref?.();
  }

  #ack() {
    if (this.processedSeq <= this.ackedSeq) return;
    this.ackedSeq = this.processedSeq;
    this.#send({ t: 'ack', seq: this.processedSeq });
  }

  #exit(code, signal, extra = {}) {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal, ...extra };
    this.#send({ t: 'exit-seen' });
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }

  onLine(fn) { this.reader = fn; this.#drain(); }

  pause() { this.paused = true; return this.processedSeq; }

  resume() { this.paused = false; this.#drain(); }

  // Leave the child running for the next server. Nothing after this reaches the runner.
  detach() {
    this.detached = true;
    this.paused = true;
    clearTimeout(this.ackTimer);
    this.#ack();
    try { this.socket?.end(); } catch {}
  }

  release() { this.#send({ t: 'release' }); }

  kill(signal = 'SIGTERM') {
    if (this.exited) return false;
    this.#send({ t: 'signal', sig: signal, group: true });
    return true;
  }

  unref() {}
  ref() {}
}

// The relay is its own session (detached: setsid), so launchd ending the service's process group cannot reach
// it, and it holds no pipe to the server (stdio ignored), so nothing breaks for it when the server goes.
export function relaySpawnOptions(options = {}) {
  return { cwd: options.cwd, env: options.env || process.env, stdio: 'ignore', detached: true };
}

// A spawn() for the providers: the relay is spawned instead of the command, and the command runs under it.
export function relaySpawner({ script, dir, nodePath = process.execPath, connectTimeoutMs } = {}) {
  return function spawnViaRelay(command, args = [], options = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(6).toString('hex');
    const relay = spawn(nodePath, [script, dir, id, '--', command, ...args], relaySpawnOptions(options));
    relay.unref();
    const child = new RelayChild({ dir, id, from: 1, connectTimeoutMs });
    child.relayPid = relay.pid;
    // spawn() reports a missing cwd or executable asynchronously, as 'error' with the errno and no exit; left
    // unheard the child waits out its connect deadline for a socket that never comes.
    relay.on('error', (error) => child.relayGone(`relay ${id} could not be spawned: ${error?.code || error?.message || error}`
      + `${options.cwd ? ` (cwd ${options.cwd})` : ''}`));
    return child;
  };
}

export function adoptRelay({ dir, id, from, connectTimeoutMs = 3000 }) {
  return new RelayChild({ dir, id, from, connectTimeoutMs });
}

// Relays on disk: one manifest per live relay, written once it listens.
export function listRelays(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      let alive = false;
      try { process.kill(manifest.relayPid, 0); alive = true; } catch {}
      out.push({ ...manifest, alive });
    } catch {}
  }
  return out;
}

// End a relay nobody will adopt: its child gets SIGTERM, the relay goes once the child has.
export function endRelay(dir, id, { signal = 'SIGTERM' } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(relaySocket(dir, id));
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ t: 'release' })}\n${JSON.stringify({ t: 'signal', sig: signal, group: true })}\n`);
      setTimeout(() => done(true), 50).unref?.();
    });
    socket.on('error', () => done(false));
  });
}
