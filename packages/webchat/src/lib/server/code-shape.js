import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEADLINES, PHASES, initialState } from './session-machine.js';
import { SIGNALS, emptyContext, translate } from './translate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SINGLETON_ROOTS = Object.freeze([
  'store.js', 'runner.js', 'autotitle.js', 'auth.js', 'sidechat.js', 'reconcile.js',
]);

// Side-effect imports execute dependencies too and must affect the fingerprint.
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;

export function moduleClosure(roots = SINGLETON_ROOTS, from = HERE) {
  const seen = new Set();
  const queue = roots.map((root) => resolve(from, root));
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    let src;
    try { src = readFileSync(path, 'utf8'); } catch { continue; }
    seen.add(path);
    for (const match of src.matchAll(SPECIFIER)) {
      const spec = match[1] || match[2] || match[3] || '';
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}

export function codeShapeDetail(roots = SINGLETON_ROOTS, from = HERE) {
  const files = [...moduleClosure(roots, from)].sort();
  const hash = createHash('sha256');
  const parts = [];
  for (const path of files) {
    let src = '';
    try { src = readFileSync(path, 'utf8'); } catch { }
    const name = relative(from, path);
    const digest = createHash('sha256').update(src).digest('hex');
    parts.push(`${name}:${digest}`);
    hash.update(`${name}:${digest}\n`);
  }
  return { hash: hash.digest('hex').slice(0, 12), files: parts };
}

export function codeShape(roots = SINGLETON_ROOTS, from = HERE) {
  return codeShapeDetail(roots, from).hash;
}

export function builtShapeDetail() {
  if (typeof __WEBCHAT_CODE_SHAPE__ !== 'undefined') return __WEBCHAT_CODE_SHAPE__;
  return codeShapeDetail();
}

export function builtShape() {
  return builtShapeDetail().hash;
}

// What a handover record (runner.handoffAll) is written in terms of: the session machine, the translator
// context, the direct adapter's link, and the relay client.
//
// The record is a serialization of state, so what decides whether the next server can read it is the
// structure of that state, not the code that moves it; code that only moves state differently is exactly
// what a hot swap already replaces under live objects.
//
// So the shape is now the structure: the key paths and value types of a fresh machine state, a fresh
// translator context and the context after a canned transcript (parent text, a tool, a subagent lane and
// its text), plus the machine's phase, deadline and signal names. HANDOVER_SCHEMA is the owner's lever
// for what a fingerprint cannot see: bump it when a persisted field keeps its name and type but changes
// meaning (a count that used to be milliseconds), and every live child is then ended and revived as
// before. deploy.sh refuses such a restart while children are live unless it is told `--break-handover`.
export const HANDOVER_SCHEMA = 1;

export const HANDOVER_ROOTS = Object.freeze([
  'session-machine.js', 'translate.js', 'providers/direct.js', 'relay-child.js',
]);

/** Sorted `path:type` lines for a JSON-shaped value; arrays contribute their element shapes under `[]`. */
export function shapePaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
    for (const item of value.slice(0, 3)) shapePaths(item, `${prefix}[]`, out);
  } else if (value && typeof value === 'object') {
    out.add(`${prefix}{}`);
    for (const key of Object.keys(value).sort()) shapePaths(value[key], `${prefix}.${key}`, out);
  } else {
    out.add(`${prefix}:${value === null ? 'null' : typeof value}`);
  }
  return out;
}

const CANNED_TRANSCRIPT = Object.freeze([
  { type: 'system', subtype: 'init', session_id: 's', model: 'm', permissionMode: 'p', tools: [] },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'Bash', input: {} } } },
  { type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'message_start', message: { id: 'c1' } } },
  { type: 'stream_event', parent_tool_use_id: 't1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
]);

/** The structure a handover record is written in, as a sorted list of lines (the thing the shape hashes). */
export function handoverStructure() {
  const lines = new Set([`schema:${HANDOVER_SCHEMA}`]);
  for (const [group, names] of [['phase', PHASES], ['deadline', DEADLINES], ['signal', SIGNALS]]) {
    for (const value of Object.values(names)) lines.add(`${group}=${value}`);
  }
  shapePaths(initialState(), 'machine', lines);
  shapePaths(emptyContext(), 'ctx', lines);
  let ctx = emptyContext();
  try { for (const message of CANNED_TRANSCRIPT) ctx = translate(ctx, message).ctx; } catch (error) { lines.add(`canned-transcript-threw:${error?.message}`); }
  shapePaths(ctx, 'ctx-after', lines);
  return [...lines].sort();
}

/** The shape this process writes into a handover record and checks a record against. */
export function handoverShape() {
  return createHash('sha256').update(handoverStructure().join('\n')).digest('hex').slice(0, 12);
}

export function legacyHandoverShape() {
  if (typeof __WEBCHAT_HANDOVER_SHAPE__ !== 'undefined') return __WEBCHAT_HANDOVER_SHAPE__;
  return codeShape(HANDOVER_ROOTS);
}

/**
 * Every shape a record may carry for this process to adopt it: the structure, and the legacy source hash, so
 * the one boot that follows the deploy of this change still adopts what the last (legacy-shaped) server wrote
 * when those files did not change in between. Nothing writes a legacy shape any more.
 */
export function acceptedHandoverShapes() {
  return [handoverShape(), legacyHandoverShape()];
}
