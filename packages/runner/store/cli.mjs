#!/usr/bin/env node
// The memory store as a child process: `node store/cli.mjs --db PATH [--read-only] COMMAND < request.json` prints one
// JSON answer (exit 0 ok, 2 refused, 1 internal), and `... serve` answers one request per line
// ({"id","command","request"} in, {"id","code","result"} out) with the store open until stdin closes (the warm reader
// rev6/pull/memory-worker.mjs keeps). Commands and shapes: ./memory.mjs.
import { createInterface } from 'node:readline';
import { answer, COMMANDS, syncStore } from './memory.mjs';

const USAGE = `usage: store/cli.mjs --db PATH [--read-only] {${COMMANDS.join('|')}|serve} < request.json`;
const argv = process.argv.slice(2);
let db = process.env.TOPHAT_RUNNER_DB || null, readOnly = false, command = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') db = argv[++i];
  else if (a === '--read-only') readOnly = true;
  else if (a === '--entities' || a === '--caller') { if (a === '--caller') i++; }
  else if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); process.exit(0); }
  else command = a;
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
if (!db || !command || (command !== 'serve' && !COMMANDS.includes(command))) { emit({ ok: false, reason: 'refused', detail: USAGE }); process.exit(2); }

if (command === 'serve') {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { emit({ id: null, code: 2, result: { ok: false, reason: 'refused', detail: 'one JSON object per line' } }); return; }
    const cmd = msg.command;
    if (!['search', 'read', 'status'].includes(cmd)) { emit({ id: msg.id ?? null, code: 2, result: { ok: false, reason: 'refused', detail: 'serve answers search, read and status only' } }); return; }
    const { result, code } = answer(cmd, msg.request ?? {}, { db, readOnly: true });
    emit({ id: msg.id ?? null, code, result });
  });
} else if (command === 'sync') {
  const { result, code } = await syncStore(db);
  emit(result);
  process.exitCode = code;
} else {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { text += c; });
  process.stdin.on('end', () => {
    let req;
    try { req = text.trim() ? JSON.parse(text) : {}; } catch (e) { emit({ ok: false, reason: 'refused', detail: `request is not JSON: ${e.message}` }); process.exit(2); }
    const { result, code } = answer(command, req, { db, readOnly });
    emit(result);
    process.exitCode = code;
  });
}
