// The demo instance file's required settings live in seed/instance-policy.json, not in a hand edit of the demo user's instance.json.
// `tophat-demo instance` merges them into the instance file (atomic write, mode kept) and `--check` reports what differs; the update
// runs it before it restarts the demo, so a rebuilt or re-seeded demo keeps them. The check also looks for chat rows in the demo's
// shared memory: visitors' chats must never reach it (TOPHAT_RUNNER_TRANSCRIPTS=0 stops the runner writing them).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../seed/instance-policy.json');
export const readPolicy = (file = POLICY) => { const { note, ...rest } = JSON.parse(readFileSync(file, 'utf8')); void note; return rest; };

/** Leaf settings of `policy` that `inst` does not carry: [{ path, want, have }]. */
export function differences(inst, policy, prefix = []) {
  const out = [];
  for (const [k, want] of Object.entries(policy)) {
    const have = inst?.[k];
    if (want && typeof want === 'object' && !Array.isArray(want)) out.push(...differences(have, want, [...prefix, k]));
    else if (JSON.stringify(have) !== JSON.stringify(want)) out.push({ path: [...prefix, k].join('.'), want, have: have ?? null });
  }
  return out;
}

function merge(inst, policy) {
  const out = { ...inst };
  for (const [k, v] of Object.entries(policy)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(inst?.[k] || {}, v) : v;
  return out;
}

/** Write the policy into the instance file. Returns { changed: [paths] }; nothing is written when it already holds. */
export function applyInstancePolicy(file, policy = readPolicy()) {
  const inst = JSON.parse(readFileSync(file, 'utf8'));
  const changed = differences(inst, policy);
  if (!changed.length) return { changed: [] };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merge(inst, policy), null, 2) + '\n', { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
  return { changed: changed.map((d) => d.path) };
}

/** Chat transcript rows (source `webchat`) in the instance's memory database; null when the file is absent. */
export async function webchatRows(db) {
  if (!db || !existsSync(db)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const h = new DatabaseSync(db, { readOnly: true });
  try { return h.prepare("SELECT count(*) AS n FROM raw_data WHERE source = 'webchat'").get().n; } finally { h.close(); }
}

/** { ok, policy: [differences], webchatRows } for the instance file and memory database. */
export async function checkInstance(file, db, policy = readPolicy()) {
  const rows = await webchatRows(db);
  const diff = differences(JSON.parse(readFileSync(file, 'utf8')), policy);
  return { ok: !diff.length && !rows, policy: diff, webchatRows: rows };
}
