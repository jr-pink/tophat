// One rate-limit cooldown per mailbox shared by every process on the machine: Google's per-user window restarts on every
// call, refused ones included, so a locked mailbox is not called at all until the instant its 429 named. A window that
// ends in another 429 escalates (15, 30, 60, then 120 minutes at most), and for five minutes after a window closes only
// the process marked LINKNOTES_GMAIL_PROBER=1 may call, so jobs on a fixed interval do not land on every expiry.
// State: <stateDir>/automation/gmail-cooldown.json (+ -streak.json), written by atomic temp+rename; lockless.
// Ported from an upstream adapter (VENDOR.json `ported`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GMAIL_COOLDOWN_DEFAULT_MS = 15 * 60 * 1000;
export const PROBE_GRACE_MS = 5 * 60 * 1000;
export const ESCALATION_CAP_MS = 120 * 60 * 1000;

export function gmailCooldownFile({ stateDir, env = process.env } = {}) {
  if (env.LINKNOTES_GMAIL_COOLDOWN_FILE) return env.LINKNOTES_GMAIL_COOLDOWN_FILE;
  return path.join(stateDir || path.join(os.homedir(), '.local/state/linknotes'), 'automation', 'gmail-cooldown.json');
}
function readAll(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
const streakFile = (file) => `${path.dirname(file)}/gmail-cooldown-streak.json`;
export function isGmailProber(env = process.env) { return env.LINKNOTES_GMAIL_PROBER === '1'; }
function probeGraceUntil(key, file, now, env) {
  if (isGmailProber(env)) return null;
  let streaks = {};
  try { streaks = JSON.parse(fs.readFileSync(streakFile(file), 'utf8')) || {}; } catch { return null; }
  const last = Number(streaks[key]?.lastUntilMs) || 0;
  return last > 0 && now >= last && now < last + PROBE_GRACE_MS ? new Date(last + PROBE_GRACE_MS).toISOString() : null;
}
/** The ISO instant this mailbox is cooling down until, or null when it may be called. */
export function gmailCooldownUntil(key, { file = gmailCooldownFile(), now = Date.now(), env = process.env } = {}) {
  const until = readAll(file)[key];
  return until && Date.parse(until) > now ? until : probeGraceUntil(key, file, now, env);
}
/** When a 429 says to come back: Gmail's body names the instant; else Retry-After (seconds or a date); else 15 minutes. */
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
const writeAtomic = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); };
export function escalatedUntil(key, until, { file, now = Date.now() } = {}) {
  let streaks = {};
  try { streaks = JSON.parse(fs.readFileSync(streakFile(file), 'utf8')) || {}; } catch { /* first one */ }
  const prev = streaks[key] || { streak: 0, lastUntilMs: 0 };
  if (now < prev.lastUntilMs) return until; // inside a window we already opened
  const atExpiry = prev.lastUntilMs > 0 && now >= prev.lastUntilMs && now - prev.lastUntilMs <= 120_000;
  const streak = atExpiry ? prev.streak + 1 : 0;
  const wanted = Math.min(GMAIL_COOLDOWN_DEFAULT_MS * 2 ** streak, ESCALATION_CAP_MS);
  const result = streak > 0 && Date.parse(until) < now + wanted ? new Date(now + wanted).toISOString() : until;
  streaks[key] = { streak, lastUntilMs: Date.parse(result) };
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeAtomic(streakFile(file), streaks); } catch { /* courtesy */ }
  return result;
}
/** Open (or move) a mailbox's window; expired entries are dropped. Never throws: the call already failed. */
export function setGmailCooldown(key, until, { file = gmailCooldownFile(), now = Date.now() } = {}) {
  const all = readAll(file);
  until = escalatedUntil(key, until, { file, now });
  for (const [k, v] of Object.entries(all)) if (!(Date.parse(v) > now)) delete all[k];
  if (!(Date.parse(all[key]) > Date.parse(until))) all[key] = until;
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeAtomic(file, all); } catch { /* courtesy */ }
  return all[key];
}
