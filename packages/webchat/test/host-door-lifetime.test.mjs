// The host door lives per turn, for that turn's work (host-door.js, door-work.js; docs/HOST-DESIGN.md item 5): a grant stays open while
// its own turn runs and while anything that turn started runs on the team host (subagents, background turns, jobs tagged with the grant in
// the runner ledger) or as a door call here; it closes after the grace once none is left; a new turn gets its own grant and never kills a
// command of the earlier one. The door is served on loopback with no tunnel (tunnel: false); requests go straight to its port.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrantBook } from '../src/lib/server/host-grant.js';
import { createHostDoors, doorNotice } from '../src/lib/server/host-door.js';
import { doorOf, doorWork } from '../src/lib/server/door-work.js';
import { openLedger } from '../../runner/rev6/pull/ledger.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (check()) return; await sleep(10); } throw new Error('never'); };
function setup(t, opts = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'door-life-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'chat'); mkdirSync(root);
  const grants = createGrantBook();
  const logs = [];
  const doors = createHostDoors({ grants, cwdOf: () => root, logPath: join(dir, 'door.jsonl'), log: (l) => logs.push(l), tunnel: false, ...opts });
  t.after(() => doors.closeAll());
  const grantsTokens = new Map();
  const grantFn = grants.grant;
  grants.grant = (...a) => { const g = grantFn(...a); grantsTokens.set(g.id, g.token); return g; };
  const run = (grant, shell) => fetch(`http://127.0.0.1:${doors.active().find((d) => d.grant === grant).port}/run`, { method: 'POST', headers: { authorization: `Bearer ${grantsTokens.get(grant)}`, 'content-type': 'text/plain' }, body: shell }).then((r) => r.json());
  return { dir, root, doors, logs, run };
}

test('the door outlives its turn while a subagent of that turn runs on the host, and closes once it has ended plus the grace', async (t) => {
  const s = setup(t, { graceMs: 300, pollMs: 50 });
  await s.doors.open('c1', 'peer', { ssh: 'team' });
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
  await s.doors.open('c2', 'peer', { ssh: 'team' });
  const [{ grant: first }] = s.doors.active();
  const marker = join(s.dir, 'finished');
  const running = s.run(first, `sleep 1; touch ${marker}; echo done`);
  await until(() => s.doors.active()[0].running === 1);
  s.doors.turnEnded('c2', { probe: async () => ({ live: false }) });
  await s.doors.open('c2', 'peer', { ssh: 'team' });
  assert.equal(s.doors.active().length, 2);
  assert.equal((await running).stdout, 'done\n');
  assert.ok(existsSync(marker));
  await until(() => s.doors.active().length === 1);
  assert.notEqual(s.doors.active()[0].grant, first);
  assert.equal(s.doors.active()[0].turnLive, true);
});

test('the team host answers per grant from the runner ledger: the turn, tagged subagents and jobs; a running one of the chat keeps every grant of the chat live', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'door-work-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runner.sqlite');
  const ledger = openLedger(path);
  t.after(() => ledger.db.close());
  const at = new Date().toISOString();
  const notice = doorNotice({ chatId: 'c1', grantId: 'gb', root: '/r', tool: '/home/u/.tophat-doors/c1/gb/door' });
  assert.equal(doorOf(notice).grant, 'gb');
  ledger.append('s', 'user', 'owner', [{ type: 'text', text: `go\n\n${notice}` }], at);
  ledger.db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES ('agent_1', 's', 's/agent/agent_1', 'running', ?, 'ga')").run(at);
  ledger.db.prepare("INSERT INTO jobs (id, session_id, tool, input, status, started_at, door) VALUES ('job_1', 's', 'shell', '{}', 'running', ?, 'gc')").run(at);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gb', busy: true }).turn, true);
  assert.deepEqual(doorWork({ ledgerPath: path, sessionId: 's', grant: 'ga', busy: true }), { grant: 'ga', live: true, turn: false, agents: ['agent_1'], jobs: ['job_1'], why: '1 subagent(s), 1 job(s)' });
  assert.equal(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gc' }).live, true);
  assert.equal(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gd' }).live, true); // a running row of the chat keeps every grant of it
  ledger.db.prepare("UPDATE agents SET status = 'done'").run();
  ledger.db.prepare("UPDATE jobs SET status = 'done'").run();
  assert.equal(doorWork({ ledgerPath: path, sessionId: 's', grant: 'gd' }).live, false);
  assert.equal(doorWork({ ledgerPath: path, sessionId: 'other', grant: 'ga' }).live, false);
});
