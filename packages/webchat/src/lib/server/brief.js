

import { createHash } from 'node:crypto';
import { watch, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { briefRows } from '$lib/core/brief-rows.js';
import { reconcileBlocks } from '$lib/core/brief-blocks.js';

const REPO = process.env.WEBCHAT_REPO || join(homedir(), '.local', 'share', 'tophat', 'workspace');

export function briefPath(date) {
  return join(REPO, 'knowledge/memory/briefs', date.slice(0, 4), date.slice(5, 7), `${date}.md`);
}

export function localDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TOPHAT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export async function readBrief(date = localDate()) {
  for (let back = 0; back < 8; back += 1) {
    const day = localDate(new Date(Date.parse(`${date}T12:00:00Z`) - back * 86_400_000));
    try {
      return { date: day, stale: back > 0, markdown: await readFile(briefPath(day), 'utf8') };
    } catch {  }
  }
  return { date, stale: false, markdown: null };
}

export async function readStamps(date) {
  try { return JSON.parse(await readFile(briefPath(date).replace(/\.md$/, '.stamps.json'), 'utf8')); }
  catch { return { lines: {}, generatedAt: null, checkedAt: null }; }
}

let running = null;
let lastRun = 0;

let failure = null;

export function refreshCommand(env = process.env) {
  if (env.WEBCHAT_BRIEF_REFRESH === '0') return null;
  if (env.WEBCHAT_BRIEF_REFRESH_SCRIPT) return [env.WEBCHAT_BRIEF_REFRESH_SCRIPT];
  if (!env.TOPHAT_RUNTIME_DIR) return null;
  const configFile = env.TOPHAT_CONFIG || join(env.TOPHAT_CONFIG_DIR || join(homedir(), '.config/tophat'), 'config.json');
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (config.heartbeat?.engine !== 'understanding') return null;
    return [join(env.TOPHAT_RUNTIME_DIR, 'src/cli.mjs'), 'brief', '--config', configFile];
  } catch { return null; }
}

export function requestRefresh({ minIntervalMs = 60_000 } = {}) {
  
  
  const command = refreshCommand();
  if (!command) return { started: false, reason: 'disabled' };
  if (running) return { started: false, reason: 'already running' };
  if (Date.now() - lastRun < minIntervalMs) return { started: false, reason: 'checked recently' };
  lastRun = Date.now();
  const child = spawn(process.execPath, command, {
    cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'], detached: false
  });
  running = child;
  
  
  
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
  child.on('exit', (code) => {
    running = null;
    failure = code === 0 ? null : { at: Date.now(), code, message: firstError(stderr) };
  });
  child.on('error', (cause) => { running = null; failure = { at: Date.now(), code: null, message: cause.message }; });
  return { started: true };
}

export function firstError(stderr = '') {
  const lines = String(stderr).split('\n').map((line) => line.trim()).filter(Boolean);
  const thrown = lines.find((line) => /^[A-Za-z]*Error\b/.test(line));
  if (thrown) return thrown.slice(0, 200);
  const last = lines.filter((line) => !/ExperimentalWarning|trace-warnings/.test(line)).pop();
  return (last || 'the brief refresher exited nonzero').slice(0, 200);
}

export function refreshing() { return Boolean(running); }


export function lastFailure() { return failure; }

export function blocksPath(date) {
  return briefPath(date).replace(/\.md$/, '.blocks.json');
}

function sectionsOf(markdown) {
  let section = null;
  return briefRows(markdown).map((row) => {
    const heading = String(row.text ?? '').match(/^#{1,6}\s+(.*)$/u);
    if (heading) section = heading[1].trim();
    return { key: row.key, text: row.text ?? row.key, section };
  });
}

export async function readBlocks(date) {
  try { return JSON.parse(await readFile(blocksPath(date), 'utf8')); }
  catch { return { date, ids: {}, blocks: {}, markdownHash: null }; }
}

export async function blocksFor(date, markdown, { now = new Date().toISOString(), keep = null } = {}) {
  const sidecar = await readBlocks(date);
  const hash = createHash('sha256').update(String(markdown ?? '')).digest('hex');
  if (sidecar.markdownHash === hash) return sidecar.ids || {};
  const { ids, blocks } = reconcileBlocks(sidecar.blocks || {}, sectionsOf(markdown || ''), { now, keep });
  // The month directory may not exist yet (five ENOENTs in today's log); a sidecar that cannot be
  // written loses the block ids that keep a brief's anchors stable across a rewrite.
  try {
    const path = blocksPath(date);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ date, markdownHash: hash, ids, blocks }, null, 2)}\n`);
  }
  catch (cause) { console.error(`[brief] could not save block ids for ${date}: ${cause.message}`); }
  return ids;
}

export function hashOf(markdown) {
  return createHash('sha256').update(String(markdown ?? '')).digest('hex');
}

const waiters = new Set();
let watcher = null;

function ensureWatcher(date) {
  if (watcher) return;
  const directory = join(REPO, 'knowledge/memory/briefs', date.slice(0, 4), date.slice(5, 7));
  try {
    watcher = watch(directory, { persistent: false }, (_event, name) => {
      if (name && !String(name).endsWith('.md')) return;
      for (const waiter of [...waiters]) waiter();
    });
    watcher.on('error', () => { watcher = null; });
  } catch {  }
}

export async function waitForChange(date, since, { timeoutMs = 25_000 } = {}) {
  if (!since) return 'no-baseline';
  const current = await readBrief(date);
  if (hashOf(current.markdown) !== since) return 'changed';
  ensureWatcher(date);
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      waiters.delete(check);
      clearInterval(sweep);
      clearTimeout(timer);
      resolve(why);
    };
    const check = async () => {
      const next = await readBrief(date);
      if (hashOf(next.markdown) !== since) finish('changed');
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    
    
    
    
    
    
    
    const sweep = setInterval(() => {
      try {
        Promise.resolve(check()).catch((cause) => console.error('[brief] sweep failed:', cause));
      } catch (cause) {
        console.error('[brief] sweep threw:', cause);
      }
    }, 2_000);
    if (sweep.unref) sweep.unref();
    waiters.add(check);
  });
}
