// The team host's runner tags what a turn starts with the home host's door grant of that turn (base/door-tag.mjs), so the home host can
// keep that turn's door open until the last of it ends. A subagent's brief carries the turn's door line, so it can reach his host as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../rev6/pull/ledger.mjs';
import { createAgents } from '../rev6/pull/agents.mjs';
import { createJobs } from '../rev6/pull/tools.mjs';
import { lastOwnerDoor, doorOfCauses, causesOf } from '../rev6/pull/pull.mjs';
import { doorOf, withDoorNotice } from '../rev6/base/door-tag.mjs';

const NOTICE = (g) => `[Automated event from home-mac: this turn has a door into home-mac, as his user. Tool: /Users/p/.tophat-doors/c1/${g}/door (\`/Users/p/.tophat-doors/c1/${g}/door help\`). Commands start in /r.]`;

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rev6-door-tag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(join(dir, 'runner.sqlite'));
  t.after(() => ledger.close());
  return { dir, ledger };
}

test('doorOf reads the grant and the whole notice line; a brief gets the line once', () => {
  const text = `please deploy\n\n${NOTICE('a1b2')}`;
  assert.deepEqual(doorOf(text), { grant: 'a1b2', notice: NOTICE('a1b2') });
  assert.equal(doorOf('no door here'), null);
  const brief = withDoorNotice('build it', doorOf(text));
  assert.ok(brief.endsWith(NOTICE('a1b2')));
  assert.equal(withDoorNotice(brief, doorOf(text)), brief, 'a brief that names the tool already is left alone');
  assert.equal(withDoorNotice('build it', null), 'build it');
});

test('a subagent and a background turn started under a door are tagged with its grant, and the subagent brief carries the door line', async (t) => {
  const h = home(t);
  let door = doorOf(`go\n\n${NOTICE('g1')}`);
  const agents = createAgents({ ledger: h.ledger, parentSessionId: 'root', cwd: h.dir, env: {}, model: 'fake-model', now: () => new Date().toISOString(), door: () => door,
    stream: () => { throw new Error('no model in this test'); } });
  const r = await agents.spawn({ description: 'deploy', prompt: 'run the deploy' }, 'call-1');
  const row = h.ledger.db.prepare('SELECT door, prompt, session_id FROM agents WHERE id = ?').get(r.agent_id);
  assert.equal(row.door, 'g1');
  assert.ok(row.prompt.includes('/.tophat-doors/c1/g1/door'));
  const first = h.ledger.db.prepare("SELECT content FROM messages WHERE session_id = ? AND kind = 'owner' ORDER BY seq LIMIT 1").get(row.session_id);
  assert.ok(first.content.includes('/.tophat-doors/c1/g1/door'), 'the subagent reads the door line in its first message');
  agents.cancel({ agent_id: r.agent_id }); // no model here: end its run before the ledger closes
  await agents.wait({ agent_id: r.agent_id, timeout_ms: 5000 });
  door = null; // a turn under no door
  const bg = agents.adopt({ id: 'agent_bg', sessionId: 'root/bg', description: 'background turn', done: new Promise(() => {}) });
  assert.ok(bg.agent_id);
  assert.equal(h.ledger.db.prepare("SELECT door FROM agents WHERE id = 'agent_bg'").get().door, '', 'started under no door: empty, not NULL');
});

test('a background job is tagged with the grant of the turn that started it', async (t) => {
  const h = home(t);
  let door = { grant: 'g7', notice: null };
  const jobs = createJobs(h.ledger.db, { sessionId: 'root', cwd: h.dir, env: { PATH: process.env.PATH }, door: () => door });
  const a = jobs.start('shell', { command: 'true' }, 'true');
  door = { grant: 'g8', notice: null };
  const b = jobs.start('shell', { command: 'true' }, 'true');
  for (const j of [a, b]) await jobs.wait(j.job_id ?? j.id ?? j, 5000);
  assert.deepEqual(h.ledger.db.prepare('SELECT door FROM jobs ORDER BY rowid').all().map((r) => r.door), ['g7', 'g8']);
});

test('a relaunched runner reads the door of the latest owner message back from the ledger', (t) => {
  const h = home(t);
  assert.equal(lastOwnerDoor(h.ledger, 'root'), null);
  h.ledger.ensureSession('root', { model: 'm', cwd: h.dir, at: new Date().toISOString() });
  h.ledger.append('root', 'user', 'owner', [{ type: 'text', text: `first\n\n${NOTICE('g1')}` }], new Date().toISOString());
  h.ledger.append('root', 'user', 'injected', [{ type: 'text', text: 'context' }], new Date().toISOString());
  assert.equal(lastOwnerDoor(h.ledger, 'root')?.grant, 'g1');
  h.ledger.append('root', 'user', 'owner', [{ type: 'text', text: 'typed by someone with no door' }], new Date().toISOString());
  assert.equal(lastOwnerDoor(h.ledger, 'root'), null);
});
test('a wake inherits the grant of what caused it: subagent, background turn or job, down the chain; never the stale one of the owner\'s last message', (t) => {
  const h = home(t);
  const db = h.ledger.db;
  h.ledger.append('root', 'user', 'owner', [{ type: 'text', text: `go\n\n${NOTICE('g1')}` }], 'x');
  h.ledger.append('root', 'user', 'owner', [{ type: 'text', text: `later\n\n${NOTICE('g2')}` }], 'x');
  db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door, prompt) VALUES ('agent_aa11', 'root', 'root/agent/agent_aa11', 'done', 'x', 'g1', ?)").run(`build\n\n${NOTICE('g1')}`);
  db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES ('agent_bg1', 'root', 'root/bg', 'done', 'x', 'g1')").run();
  db.prepare("INSERT INTO agents (id, parent_session, session_id, status, created_at, door) VALUES ('agent_none', 'root', 'root/agent/agent_none', 'done', 'x', '')").run();
  db.prepare("INSERT INTO jobs (id, session_id, tool, input, status, started_at, door) VALUES ('job_j1', 'root', 'shell', '{}', 'done', 'x', 'g1')").run();
  assert.deepEqual(doorOfCauses(h.ledger, 'root', { agentIds: ['agent_aa11'] }), { grant: 'g1', notice: NOTICE('g1') }, 'subagent report: its brief carries the notice');
  assert.deepEqual(doorOfCauses(h.ledger, 'root', { agentIds: ['agent_bg1'] }), { grant: 'g1', notice: NOTICE('g1') }, 'background turn: notice found from the owner message of that grant');
  assert.deepEqual(doorOfCauses(h.ledger, 'root', { jobIds: ['job_j1'] }), { grant: 'g1', notice: NOTICE('g1') }, 'background job');
  assert.deepEqual(doorOfCauses(h.ledger, 'root', { agentIds: ['agent_none', 'agent_aa11'] })?.grant, 'g1', 'the first cause with a grant');
  assert.equal(doorOfCauses(h.ledger, 'root', { agentIds: ['agent_none'] }), null, 'started under no door passes none on');
  assert.equal(doorOfCauses(h.ledger, 'root', {}), null);
  assert.deepEqual(causesOf('[Subagent report context]\nsubagent agent_aa11 (x) is done'), { agentIds: ['agent_aa11'], jobIds: [] });
  assert.deepEqual(causesOf('[Background job context]\njob job_j1 (shell) is done'), { agentIds: [], jobIds: ['job_j1'] });
});
