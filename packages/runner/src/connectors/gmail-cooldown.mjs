// The file is a JSON map of source key -> ISO instant until which that mailbox must
// not be called.
//
// Inside the window a caller refuses without a request; a 429 from Gmail opens or
// extends it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const GMAIL_COOLDOWN_DEFAULT_MS = 15 * 60 * 1000;

/** The shared file: TOPHAT_GMAIL_COOLDOWN_FILE, else <stateDir>/automation/gmail-cooldown.json. */
export function gmailCooldownFile({ stateDir, env = process.env } = {}) {
  if (env.TOPHAT_GMAIL_COOLDOWN_FILE) return env.TOPHAT_GMAIL_COOLDOWN_FILE;
  return path.join(stateDir || path.join(os.homedir(), '.local/state/tophat'), 'automation', 'gmail-cooldown.json');
}

function readAll(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }

/** One prober per mailbox. For PROBE_GRACE_MS after a recorded window closes, only
 * the process that has TOPHAT_GMAIL_PROBER=1 (communication-fanin, the one Gmail
 * reader) may call; everyone else still reads it as cooling down. If the probe gets
 * another 429 the window reopens and escalates; if it succeeds nobody has to do
 * anything, the grace simply runs out. Only a mailbox that has had a 429 recorded
 * has a sidecar entry, so a healthy mailbox is never held back.
 */
export const PROBE_GRACE_MS = 5 * 60 * 1000;
export function isGmailProber(env = process.env) { return env.TOPHAT_GMAIL_PROBER === '1'; }
function probeGraceUntil(key, file, now, env) {
  if (isGmailProber(env)) return null;
  let streaks = {};
  try { streaks = JSON.parse(fs.readFileSync(`${path.dirname(file)}/gmail-cooldown-streak.json`, 'utf8')) || {}; } catch { return null; }
  const last = Number(streaks[key]?.lastUntilMs) || 0;
  return last > 0 && now >= last && now < last + PROBE_GRACE_MS ? new Date(last + PROBE_GRACE_MS).toISOString() : null;
}

/** The ISO instant this mailbox is cooling down until, or null when it may be called. */
export function gmailCooldownUntil(key, { file = gmailCooldownFile(), now = Date.now(), env = process.env } = {}) {
  const until = readAll(file)[key];
  return until && Date.parse(until) > now ? until : probeGraceUntil(key, file, now, env);
}

/**
 * When a 429 says to come back, as an ISO instant. Gmail names the instant in
 * the error message; the standard header is seconds or an HTTP date. With
 * neither, fifteen minutes, which is the window Gmail's own answers name.
 */
export function retryAtFrom(header, body, now = Date.now()) {
  const named = String(body || '').match(/Retry after (\d{4}-\d\d-\d\dT[0-9:.]+Z)/);
  if (named && Number.isFinite(Date.parse(named[1]))) return new Date(Date.parse(named[1])).toISOString();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000).toISOString();
    if (Number.isFinite(Date.parse(header))) return new Date(Date.parse(header)).toISOString();
  }
  return new Date(now + GMAIL_COOLDOWN_DEFAULT_MS).toISOString();
}

/** Who opened the window: one JSON line beside the cooldown file per recorded
 * 429 (pid, parent, argv, parent command). Never throws; the cooldown is the
 * product, this is the receipt.
 */
export function logCooldownCaller(key, until, file) {
  try {
    const parent = spawnSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).stdout?.trim().slice(0, 300);
    fs.appendFileSync(`${path.dirname(file)}/gmail-cooldown-callers.jsonl`, JSON.stringify({
      at: new Date().toISOString(), key, until, pid: process.pid, ppid: process.ppid,
      argv: process.argv.slice(0, 4).map((a) => String(a).slice(0, 160)), parent,
    }) + '\n', { mode: 0o600 });
  } catch { /* receipt only */ }
}

/** A window that ends in another 429 was not a window. So a 429 that arrives
 * within two minutes after the previous window closed doubles the next one (15,
 * 30, 60, then 120 minutes at most) and the quiet that results is what lets the
 * limit clear. Any other 429 starts again at the base. State is a sidecar so
 * every process that writes the cooldown applies the same rule.
 */
export const ESCALATION_CAP_MS = 120 * 60 * 1000;
export function escalatedUntil(key, until, { file, now = Date.now() } = {}) {
  const sidecar = `${path.dirname(file)}/gmail-cooldown-streak.json`;
  let streaks = {};
  try { streaks = JSON.parse(fs.readFileSync(sidecar, 'utf8')) || {}; } catch { /* first one */ }
  const prev = streaks[key] || { streak: 0, lastUntilMs: 0 };
  const atExpiry = prev.lastUntilMs > 0 && now >= prev.lastUntilMs && now - prev.lastUntilMs <= 120_000;
  const sameWindow = now < prev.lastUntilMs; // a call inside a window we already opened: leave it alone
  if (sameWindow) return until;
  const streak = atExpiry ? prev.streak + 1 : 0;
  const wanted = Math.min(GMAIL_COOLDOWN_DEFAULT_MS * 2 ** streak, ESCALATION_CAP_MS);
  const result = streak > 0 && Date.parse(until) < now + wanted ? new Date(now + wanted).toISOString() : until;
  streaks[key] = { streak, lastUntilMs: Date.parse(result) };
  try { fs.writeFileSync(`${sidecar}.${process.pid}.tmp`, JSON.stringify(streaks) + '\n', { mode: 0o600 }); fs.renameSync(`${sidecar}.${process.pid}.tmp`, sidecar); } catch { /* courtesy */ }
  return result;
}

/** Open (or move) a mailbox's window; expired entries are dropped. Never throws: the call already failed. */
export function setGmailCooldown(key, until, { file = gmailCooldownFile(), now = Date.now() } = {}) {
  const all = readAll(file);
  until = escalatedUntil(key, until, { file, now });
  for (const [k, v] of Object.entries(all)) if (!(Date.parse(v) > now)) delete all[k];
  // Never shorten a window another process recorded from a later answer.
  if (!(Date.parse(all[key]) > Date.parse(until))) all[key] = until;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the cooldown is a courtesy */ }
  logCooldownCaller(key, all[key], file);
  return all[key];
}

/** Record a Gmail 429 from its Retry-After header and body; returns the until instant. */
export function recordGmail429(key, { header, body, file = gmailCooldownFile(), now = Date.now() } = {}) {
  return setGmailCooldown(key, retryAtFrom(header, body, now), { file, now });
}
