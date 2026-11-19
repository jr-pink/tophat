// The host door lives per turn, for that turn's work (host-door.js, door-work.js; docs/HOST-DESIGN.md item 5): a grant stays open while
// its own turn runs and while anything that turn started runs on the team host (subagents, background turns, jobs tagged with the grant in
// the runner ledger) or as a door call here; it closes after the grace once none is left; a new turn gets its own grant and never kills a
// command of the earlier one. The door is served on loopback with no tunnel (tunnel: false); requests go straight to its port.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrantBook } from '../src/lib/server/host-grant.js';
import { createHostDoors, doorNotice, installScript, removeScript } from '../src/lib/server/host-door.js';
import { doorAgent, doorOf, doorWork } from '../src/lib/server/door-work.js';
import { openLedger } from '../../runner/rev6/pull/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (check()) return; await sleep(10); } throw new Error('never'); };
const AGENTS = new Map(); // agent id -> { known, live, grant }: what the team host's ledger would answer
function setup(t, opts = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'door-life-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'chat'); mkdirSync(root);
  const grants = opts.grants || createGrantBook();
  const logs = [];
  const doors = createHostDoors({ grants, cwdOf: () => root, logPath: join(dir, 'door.jsonl'), log: (l) => logs.push(l), tunnel: false, ...opts });
  t.after(() => doors.suspend());
  const hooks = { agent: async (id) => AGENTS.get(id) || { known: false, live: false, grant: '' } };
  const call = (chat, path, { method = 'GET', body, agent, key } = {}) => {
    const e = doors.endpoint(chat);
    return fetch(`http://127.0.0.1:${e.port}${path}`, { method, body, headers: { authorization: `Bearer ${key ?? e.key}`, 'content-type': 'text/plain', ...(agent ? { 'x-door-agent': agent } : {}) } });
  };
  const run = (grant, shell, chat = 'c1') => call(chat, '/run', { method: 'POST', body: shell }).then((r) => r.json());
  return { dir, root, doors, logs, run, call, hooks, grants };
}

test('the door outlives its turn while a subagent of that turn runs on the host, and closes once it has ended plus the grace', async (t) => {
  const s = setup(t, { graceMs: 300, pollMs: 50 });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  const [{ grant }] = s.doors.active();
  let subagent = true;
  s.doors.turnEnded('c1', { probe: async () => ({ live: subagent }) });
  await sleep(600);
  assert.equal(s.doors.active().length, 1, 'past the grace, the subagent keeps it');
  assert.equal((await s.run(grant, 'echo hi')).stdout, 'hi\n');
  subagent = false;
  await until(() => s.doors.active().length === 0);
  assert.ok(s.logs.some((l) => l.includes(`closed c1 grant ${grant} (its turn and what it started have ended)`)));
});

test('a new turn gets its own grant and never kills a command the earlier turn started', async (t) => {
  const s = setup(t, { graceMs: 200, pollMs: 50 });
  await s.doors.open('c2', 'peer', { ssh: 'team' }, s.hooks);
  const [{ grant: first }] = s.doors.active();
  const marker = join(s.dir, 'finished');
  const running = s.run(first, `sleep 1; touch ${marker}; echo done`, 'c2');
  await until(() => s.doors.active()[0].running === 1);
  s.doors.turnEnded('c2', { probe: async () => ({ live: false }) });
  await s.doors.open('c2', 'peer', { ssh: 'team' }, s.hooks);
  assert.equal(s.doors.active().length, 2);
  assert.equal((await running).stdout, 'done\n');
  assert.ok(existsSync(marker));
  await until(() => s.doors.active().length === 1);
  assert.notEqual(s.doors.active()[0].grant, first);
  assert.equal(s.doors.active()[0].turnLive, true);
});

test('the team host answers per grant from the runner ledger: the turn, tagged subagents and jobs; another grant does not count', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'door-work-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runner.sqlite');
  const ledger = openLedger(path);
  t.after(() => ledger.db.close());
  const at = new Date().toISOString();
  const notice = doorNotice({ chatId: 'c1', grantId: 'gb', root: '/r', tool: '/home/u/.tophat-doors/c1/door' });
  assert.equal(doorOf(notice).grant, 'gb');
  ledger.append('s', 'user', 'owner', [{ type: 'text', text: `go\n\n${notice}` }], at);
  ledger.db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES ('agent_1', 's', 's/agent/agent_1', 'running', ?, 'ga')").run(at);
  ledger.db.prepare("INSERT INTO jobs (id, session_id, tool, input, status, started_at, door) VALUES ('job_1', 's', 'shell', '{}', 'running', ?, 'gc')").run(at);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gb', busy: true }).turn, true);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'ga', busy: true }), { grant: 'ga', live: true, turn: false, agents: ['agent_1'], jobs: [], why: '1 subagent(s)' });
  assert.equal(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gc' }).live, true);
  assert.equal(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gd' }).live, false);
});

test('the ledger maps a subagent id to its grant and liveness, only inside its own chat', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'door-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runner.sqlite');
  const ledger = openLedger(path);
  t.after(() => ledger.db.close());
  const at = new Date().toISOString();
  const add = (id, parent, status, door) => ledger.db.prepare('INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES (?, ?, ?, ?, ?, ?)').run(id, parent, `${parent}/agent/${id}`, status, at, door);
  add('agent_run', 's', 'running', 'ga'); add('agent_done', 's', 'done', 'ga'); add('agent_nested', 's/agent/agent_run', 'running', 'ga'); add('agent_other', 'other', 'running', 'gz');
  const ask = (agent) => doorAgent({ ledgerPath: path, sessionId: 's', agent });
  assert.deepEqual(ask('agent_run'), { agent: 'agent_run', known: true, live: true, grant: 'ga' });
  assert.deepEqual(ask('agent_done'), { agent: 'agent_done', known: true, live: false, grant: 'ga' });
  assert.equal(ask('agent_nested').live, true, 'a subagent of a subagent is in the chat tree');
  assert.equal(ask('agent_other').known, false, 'another chat\'s subagent is unknown here');
  assert.equal(ask('agent_nope').known, false);
});

test('the home host decides who a caller is: wrong key, unknown agent and finished agent are refused; a running agent is served under its own grant', async (t) => {
  const s = setup(t, { graceMs: 10_000, pollMs: 50 });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  const [{ grant: first }] = s.doors.active();
  s.doors.turnEnded('c1', { probe: async () => ({ live: true }) });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  const grants = s.doors.active().map((d) => d.grant);
  const second = grants.find((g) => g !== first);
  AGENTS.set('agent_live', { known: true, live: true, grant: first });
  AGENTS.set('agent_finished', { known: true, live: false, grant: first });
  AGENTS.set('agent_orphan', { known: true, live: true, grant: 'closedlong' });
  const ping = async (opts) => { const r = await s.call('c1', '/ping', opts); return { status: r.status, body: await r.json() }; };
  assert.equal((await ping({ key: 'not-the-key' })).status, 401, 'wrong key');
  assert.deepEqual(await ping({ agent: 'agent_nope' }), { status: 403, body: { error: 'refused: agent_nope is not a subagent of this chat' } });
  assert.equal((await ping({ agent: 'agent_finished' })).status, 403, 'a finished agent\'s grant is refused');
  assert.match((await ping({ agent: 'agent_finished' })).body.error, /finished/u);
  assert.equal((await ping({ agent: 'bad id;' })).status, 403);
  assert.equal((await ping({ agent: 'agent_live' })).body.grant, first, 'served under the grant it was started under');
  assert.equal((await ping({})).body.grant, second, 'no agent id: the chat\'s newest open grant');
  assert.equal((await ping({ agent: 'agent_orphan' })).body.grant, second, 'a running agent whose own grant closed is served under the newest open one');
  const r = await s.call('c1', '/run', { method: 'POST', body: 'echo from-agent', agent: 'agent_live' });
  assert.equal((await r.json()).stdout, 'from-agent\n');
  await sleep(100);
  const logged = readFileSync(join(s.dir, 'door.jsonl'), 'utf8');
  assert.ok(logged.includes('"agent":"agent_live"') && logged.includes(`"grant":"${first}"`), 'the call log names the agent and the grant');
  const failing = setup(t, {}); // the team host cannot be asked: retry, never allowed
  await failing.doors.open('c1', 'peer', { ssh: 'team' }, { agent: async () => { throw new Error('boom'); } });
  const down = await failing.call('c1', '/ping', { agent: 'agent_live' });
  assert.equal(down.status, 503);
});

test('a probe that cannot reach the team host (it is restarting) keeps the door past the grace; once it answers not-live the door closes', async (t) => {
  const s = setup(t, { graceMs: 100, pollMs: 30 });
  await s.doors.open('c3', 'peer', { ssh: 'team' }, s.hooks);
  let down = true;
  s.doors.turnEnded('c3', { probe: async () => { if (down) throw new Error('the team host is offline (ECONNREFUSED)'); return { live: false }; } });
  await sleep(500);
  assert.equal(s.doors.active().length, 1, 'unreachable counts as live');
  down = false;
  await until(() => s.doors.active().length === 0);
});

function fakeSsh(sent) { // `spawn` for ssh: the tunnel says it is up at once; the install script goes to `sent`
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
    if (args.includes('sh')) { child.stdout = new EventEmitter(); child.stdin = { end: (script) => { sent.push({ args, script }); setImmediate(() => { child.stdout.emit('data', '__OUT__'); child.emit('close', 0); }); } }; }
    else setImmediate(() => child.stderr.emit('data', 'debug1: remote forward success for: listen 47123'));
    child.tunnelArgs = args;
    return child;
  };
}

test('a restart keeps the doors: the record is owner-only, a graceful stop leaves the tool on the team host, boot restores the same grant and key at the same path', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'door-restart-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'chat'); mkdirSync(root);
  const statePath = join(dir, 'state', 'host-doors.json');
  const sent = [];
  const build = (grants) => createHostDoors({ grants, cwdOf: () => root, logPath: join(dir, 'door.jsonl'), statePath, log: () => {}, graceMs: 10_000, pollMs: 50, reconnectMs: 20,
    spawn: fakeSsh(sent), remote: async (target, script) => { sent.push({ target, script }); return { ok: true, out: 'TOPHAT_DOOR_TOOL=/home/pb/.tophat-doors/c1/door\n' }; } });
  const first = build(createGrantBook());
  t.after(() => first.suspend());
  const notice = await first.open('c1', 'peer', { ssh: 'team' }, { agent: async () => ({ known: false }) });
  assert.ok(notice.includes('/home/pb/.tophat-doors/c1/door') && !notice.includes('/g'), 'the notice names the one fixed path');
  const before = first.active()[0], key = first.endpoint('c1').key;
  first.turnEnded('c1', { probe: async () => ({ live: true }) });
  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the record is owner-only');
  assert.equal(statSync(join(dir, 'state')).mode & 0o777, 0o700);
  const record = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(record.lines[0].key, key);
  assert.deepEqual(record.lines[0].grants.map((g) => [g.id, g.turnEnded]), [[before.grant, true]]);
  const installs = sent.filter((x) => x.script?.includes('TOPHAT_DOOR_AUTH')).length;
  first.suspend(); // the graceful stop
  assert.equal(sent.filter((x) => x.script === removeScript('c1')).length, 0, 'the tool and key stay on the team host');
  const grants2 = createGrantBook(); // a fresh process: nothing in memory
  const second = build(grants2);
  t.after(() => second.suspend());
  assert.equal(await second.restore({ hooksFor: () => ({ probe: async () => ({ live: true, why: 'subagent' }), agent: async () => ({ known: true, live: true, grant: before.grant }) }) }), 1);
  await until(() => second.endpoint('c1')?.up);
  const after = second.active()[0];
  assert.equal(after.grant, before.grant, 'same grant id');
  assert.equal(second.endpoint('c1').key, key, 'same key');
  assert.equal(after.turnLive, false);
  assert.ok(grants2.get(before.grant), 'the grant is back in the book');
  const again = sent.filter((x) => x.script?.includes('TOPHAT_DOOR_AUTH'));
  assert.equal(again.length, installs + 1, 'the tool is reinstalled once');
  assert.ok(again.at(-1).script.includes(`Bearer ${key}`) && again.at(-1).script.includes('.tophat-doors/'), 'same key, same folder');
  const r = await fetch(`http://127.0.0.1:${second.endpoint('c1').port}/run`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain', 'x-door-agent': 'agent_x' }, body: 'echo back' });
  assert.equal((await r.json()).stdout, 'back\n', 'the door answers again');
  // the first process is still alive here (a handover): its next write finds the record taken over and it stops serving
  first.turnEnded('c1', {}); first.close('c1');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lines.length, 1, 'a superseded server does not clobber the record');
  assert.equal(sent.filter((x) => x.script === removeScript('c1')).length, 0, 'nor remove the new server\'s key');
});

test('boot cleans up what is past its cap instead of restoring it', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'door-expired-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'chat'); mkdirSync(root);
  const statePath = join(dir, 'host-doors.json');
  const sent = [];
  const mk = (extra) => createHostDoors({ grants: createGrantBook(), cwdOf: () => root, logPath: join(dir, 'd.jsonl'), statePath, log: () => {}, spawn: fakeSsh(sent),
    remote: async (target, script) => { sent.push({ target, script }); return { ok: true, out: '' }; }, ...extra });
  let clock = Date.now();
  const first = mk({ now: () => clock, ttlMs: 1000 });
  await first.open('c1', 'peer', { ssh: 'team' }, null);
  first.suspend();
  clock += 5000;
  const second = mk({ now: () => clock });
  t.after(() => second.suspend());
  assert.equal(await second.restore({}), 0);
  await until(() => sent.some((x) => x.script === removeScript('c1')));
  assert.equal(second.active().length, 0);
});

test('the installed tool: one fixed path, no id, the caller named by TOPHAT_AGENT_ID, plain words when the door is down', async (t) => {
  const s = setup(t, { graceMs: 10_000, pollMs: 50 });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  const [{ grant }] = s.doors.active();
  s.doors.turnEnded('c1', { probe: async () => ({ live: true }) });
  const e = s.doors.endpoint('c1');
  const home = join(s.dir, 'home'); mkdirSync(home);
  const installed = spawnSync('sh', ['-s'], { input: installScript({ chatId: 'c1', port: e.port, key: e.key, home: 'test-mac', root: s.root }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const tool = `${home}/.tophat-doors/c1/door`;
  assert.ok(installed.stdout.includes(`TOPHAT_DOOR_TOOL=${tool}`));
  assert.equal(statSync(`${home}/.tophat-doors/c1/auth`).mode & 0o777, 0o600);
  // async: the door server lives in this process, so a blocking spawn would starve it
  const door = (args, env = {}) => new Promise((resolve) => execFile(tool, args, { env: { PATH: process.env.PATH, HOME: home, DOOR_WAIT: '1', ...env }, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
  const hi = await door(['run', 'echo', 'hi']);
  assert.deepEqual([hi.stdout, hi.status], ['hi\n', 0], 'no agent id: the chat\'s newest grant');
  assert.equal((await door(['status'])).stdout.includes(`"grant":"${grant}"`), true);
  AGENTS.set('agent_t', { known: true, live: true, grant });
  assert.equal((await door(['run', 'echo', 'mine'], { TOPHAT_AGENT_ID: 'agent_t' })).stdout, 'mine\n');
  assert.equal((await door(['run', 'echo', 'main'], { TOPHAT_AGENT_ID: 'root_ab12cd34' })).stdout, 'main\n', 'the chat\'s own session id counts as no subagent');
  const unknown = (await door(['run', 'echo', 'x'], { TOPHAT_AGENT_ID: 'agent_nobody' }));
  assert.equal(unknown.status, 125); assert.match(unknown.stderr, /not a subagent of this chat/u);
  AGENTS.set('agent_t', { known: true, live: false, grant });
  assert.match((await door(['run', 'echo', 'x'], { TOPHAT_AGENT_ID: 'agent_t' })).stderr, /has finished/u);
  // an atomic reinstall (the door reopened at a new port) changes nothing for the caller
  assert.equal(spawnSync('sh', ['-s'], { input: installScript({ chatId: 'c1', port: e.port, key: e.key, home: 'test-mac', root: s.root }), env: { ...process.env, HOME: home } }).status, 0);
  assert.equal((await door(['run', 'echo', 'again'])).stdout, 'again\n');
  // the door is down: the tool says so plainly and tells the agent to retry, instead of implying only an owner message reopens it
  s.doors.suspend();
  const t0 = Date.now();
  const gone = (await door(['run', 'echo', 'x']));
  assert.equal(gone.status, 125);
  assert.match(gone.stderr, /no door into test-mac is reachable right now/u);
  assert.match(gone.stderr, /retry in about 30 seconds/u);
  assert.ok(Date.now() - t0 >= 900, 'it retried for DOOR_WAIT before giving up');
  assert.ok(existsSync(tool), 'the tool stays after the door closes');
  spawnSync('sh', ['-s'], { input: removeScript('c1'), env: { ...process.env, HOME: home } });
  assert.ok(existsSync(tool) && !existsSync(`${home}/.tophat-doors/c1/auth`));
  assert.match((await door(['run', 'echo', 'x'])).stderr, /retry in about 30 seconds/u);
});

test('a dropped tunnel is reopened (same key, same tool) instead of closing the grant', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'door-drop-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'chat'); mkdirSync(root);
  const sent = [], tunnels = [];
  const ssh = fakeSsh(sent);
  const doors = createHostDoors({ grants: createGrantBook(), cwdOf: () => root, logPath: join(dir, 'd.jsonl'), log: () => {}, graceMs: 10_000, pollMs: 50, reconnectMs: 20,
    spawn: (...a) => { const c = ssh(...a); if (!a[1].includes('sh')) tunnels.push(c); return c; }, remote: async (target, script) => { sent.push({ target, script }); return { ok: true, out: '' }; } });
  t.after(() => doors.suspend());
  await doors.open('c1', 'peer', { ssh: 'team' }, null);
  const key = doors.endpoint('c1').key;
  assert.equal(tunnels.length, 1);
  tunnels[0].emit('exit', 255); // the network blinked
  await until(() => tunnels.length === 2 && doors.endpoint('c1').up);
  assert.equal(doors.active().length, 1, 'the grant is still open');
  assert.equal(doors.endpoint('c1').key, key);
  assert.equal(sent.filter((x) => x.script?.includes(`Bearer ${key}`)).length, 2, 'the tool and port were written again');
});

test('rows an older runner could not tag (door empty) count for the grant of the owner message in force when they began', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'door-skew-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runner.sqlite');
  const ledger = openLedger(path);
  t.after(() => ledger.db.close());
  const t0 = Date.parse('2026-11-18T20:00:00Z'), iso = (m) => new Date(t0 + m * 60_000).toISOString();
  ledger.append('s', 'user', 'owner', [{ type: 'text', text: `first\n\n${doorNotice({ chatId: 'c1', grantId: 'g1', root: '/r' })}` }], iso(0));
  ledger.append('s', 'user', 'owner', [{ type: 'text', text: `second\n\n${doorNotice({ chatId: 'c1', grantId: 'g2', root: '/r' })}` }], iso(10));
  const agent = (id, door, at) => ledger.db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES (?, 's', ?, 'running', ?, ?)").run(id, `s/agent/${id}`, at, door);
  agent('agent_early', '', iso(5)); agent('agent_late', '', iso(12)); agent('agent_tagged', 'g1', iso(12));
  ledger.db.prepare("INSERT INTO jobs (id, session_id, tool, input, status, started_at, door) VALUES ('job_late', 's', 'shell', '{}', 'running', ?, '')").run(iso(13));
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'g1' }).agents.sort(), ['agent_early', 'agent_tagged']);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'g2' }).agents, ['agent_late']);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'g2' }).jobs, ['job_late']);
  assert.equal(doorAgent({ ledgerPath: path, sessionId: 's', agent: 'agent_late' }).grant, 'g2');
  assert.equal(doorAgent({ ledgerPath: path, sessionId: 's', agent: 'agent_tagged' }).grant, 'g1');
});

test('the newest open grant also holds what runs under a grant the home host no longer has open, so a running subagent never loses its door', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'door-orphan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runner.sqlite');
  const ledger = openLedger(path);
  t.after(() => ledger.db.close());
  const at = new Date().toISOString();
  const add = (id, door) => ledger.db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES (?, 's', ?, 'running', ?, ?)").run(id, `s/agent/${id}`, at, door);
  add('agent_gone', 'closed1'); add('agent_open', 'g2'); add('agent_none', ''); // none: no notice anywhere, started under no door
  const ask = (grant, extra) => doorWork({ ledgerPath: path, sessionId: 's', grant, ...extra });
  assert.deepEqual(ask('g3', { openGrants: ['g2', 'g3'], holder: false }).agents, [], 'a grant that is not the holder counts only its own');
  assert.deepEqual(ask('g3', { openGrants: ['g2', 'g3'], holder: true }).agents, ['agent_gone'], 'the holder takes the one whose grant is gone, not the one another open grant holds');
  assert.equal(ask('g3', { openGrants: ['g2', 'g3'], holder: true }).live, true);
  assert.deepEqual(ask('g3', { holder: true }).agents, [], 'no open list, no orphan rule (an older home host)');
  // and the home host sends that list: the newest grant is the holder
  const s = setup(t, { graceMs: 5000, pollMs: 20 });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  s.doors.turnEnded('c1', { probe: async () => ({ live: false }) });
  await s.doors.open('c1', 'peer', { ssh: 'team' }, s.hooks);
  const [a, b] = s.doors.active().map((d) => d.grant);
  const asked = [];
  s.doors.turnEnded('c1', { probe: async (grant, opts) => { asked.push([grant, opts]); return { live: false }; } });
  await until(() => asked.length > 0);
  assert.deepEqual(asked[0][1].open.sort(), [a, b].sort());
  assert.equal(asked[0][1].holder, true);
});
