// One real turn on the demo instance, cached for the public surface. The question goes through the instance's own
// loopback agent API (/api/agent, service token from the instance's secrets), so it is a chat in that instance like any
// other: the runner answers with the instance's model, instructions and memory. The public surface never runs a turn;
// it serves the last cached answer of each slot, so visitors spend no model budget and write nothing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function instance(c) {
  const inst = JSON.parse(readFileSync(c.instance, 'utf8'));
  const secrets = expand(inst.paths?.secrets || path.join(expand(inst.paths?.config || `~/.config/tophat/${inst.name}`), 'secrets'));
  return { model: inst.models?.chat?.model || null, url: `http://127.0.0.1:${inst.ports?.webchat ?? 4178}`, token: readFileSync(path.join(secrets, 'webchat-service-token'), 'utf8').trim() };
}

async function agent(inst, body) {
  const r = await fetch(`${inst.url}/api/agent`, { method: 'POST', headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`agent ${body.op}: ${r.status} ${j.error || ''}`);
  return j;
}

export function writeCache(c, slot, entry) {
  mkdirSync(c.cache, { recursive: true });
  const put = (name) => { const f = path.join(c.cache, name), tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(entry, null, 1) + '\n', { mode: 0o644 }); renameSync(tmp, f); };
  put(`${slot}.${entry.at.slice(0, 10)}.json`);
  put(`${slot}.json`);
}

/** Ask the slot's prompt (or `prompt`) in a new chat, wait for the turn to finish, cache the transcript. */
export async function ask(c, slotId, prompt = null, { timeoutMs = 15 * 60_000 } = {}) {
  const slot = c.slots.find((s) => s.id === slotId);
  if (!slot) throw new Error(`no slot ${slotId}`);
  const inst = instance(c);
  const text = prompt || slot.prompt;
  const today = new Date().toISOString().slice(0, 10);
  const title = slot.daily ? `${slot.title} (${today})` : slot.title;
  const spawned = await agent(inst, { op: 'spawn', prompt: text, title, ...(inst.model ? { model: inst.model } : {}) });
  const t0 = Date.now();
  let read;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    read = await agent(inst, { op: 'read', conversationId: spawned.id });
    const ended = read.rows.some((r) => r.role === 'end');
    if (ended && !read.busy) break;
    if (Date.now() - t0 > timeoutMs) throw new Error(`slot ${slotId}: no answer within ${timeoutMs / 60000} min (chat ${spawned.id})`);
  }
  const end = read.rows.filter((r) => r.role === 'end').at(-1);
  if (end.state !== 'completed') throw new Error(`slot ${slotId}: the turn ended ${end.state} ${end.text || ''}`);
  const tools = read.rows.filter((r) => r.role === 'observation').map((r) => ({ tool: r.tool, input: (r.input || '').slice(0, 300), error: Boolean(r.isError) }));
  const answer = read.rows.filter((r) => r.role === 'assistant').map((r) => r.text).join('\n\n').trim();
  if (!answer) throw new Error(`slot ${slotId}: the turn completed with no answer`);
  const entry = { slot: slotId, title: slot.title, prompt: text, answer, tools, conversationId: spawned.id, model: read.model, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
  writeCache(c, slotId, entry);
  return { slot: slotId, conversationId: spawned.id, chars: answer.length, tools: tools.length, seconds: entry.seconds };
}
