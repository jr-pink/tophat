// tophat-cdp captcha, the provider half: config, spend ledger, 2Captcha client. No browser in this file.
// The browser half is captcha-run.mjs; the in-page scripts are captcha-page.mjs.
//
// Money: every limit lives in the `captcha` section of the tophat config file (TOPHAT_CONFIG); this code carries no
// default for any of them and refuses to run when one is missing. A solve is refused BEFORE anything is bought when
// its estimate exceeds maxUsdPerSolve or would push today's or the lifetime ledger past maxUsdPerDay / maxUsdTotal.
// The ledger is an append-only jsonl (a `submit` line before the purchase, a `done` line after it with the cost the
// provider reported), so concurrent solves need no lock and a crash between the two is counted at its estimate.
//
// Never: print, log or return the API key or a token (both are taught to the output redactor); read a limit from a default.
import fs from 'node:fs';
import path from 'node:path';
import { configFile, expandHome, stateDir } from '../lib/paths.mjs';
import * as K from './browser/kernel.mjs';
import * as S from './browser/secrets.mjs';

export const KINDS = ['recaptcha_v2', 'recaptcha_v2_enterprise', 'recaptcha_v3', 'hcaptcha', 'turnstile'];
export const E = (m, kind = 'usage') => new K.CdpError(m, kind);

// ---- config: one place, no defaults ------------------------------------------------------------
export const CONFIG_HELP = `captcha-config.json beside the tophat config file needs: provider "2captcha", keyFile, apiBase, maxUsdPerSolve, maxUsdPerDay, maxUsdTotal, estimateUsd {${KINDS.join(', ')}}, maxAttempts, initialWaitSeconds, pollSeconds, timeoutSeconds (optional: ledgerFile, enabled)`;

// The runner's config loader rejects unknown keys, so the captcha settings live in captcha-config.json beside config.json.
export function captchaConfigFile(env = process.env) { return path.join(path.dirname(configFile(env)), 'captcha-config.json'); }

export function captchaConfig(env = process.env) {
  const file = captchaConfigFile(env);
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw E(`captcha: cannot read ${file} (${e.code || e.name}); ${CONFIG_HELP}`); }
  if (!c || typeof c !== 'object') throw E(`captcha: ${file} is not an object; ${CONFIG_HELP}`);
  if (c.enabled === false) throw E(`captcha: switched off ("enabled": false in ${file})`, 'refused');
  const bad = (what) => E(`captcha: ${what} in ${file}; ${CONFIG_HELP}`);
  if (c.provider !== '2captcha') throw bad('provider must be "2captcha"');
  if (typeof c.keyFile !== 'string' || !c.keyFile) throw bad('keyFile is missing');
  if (typeof c.apiBase !== 'string' || !/^https:\/\//.test(c.apiBase)) throw bad('apiBase must be an https URL');
  for (const k of ['maxUsdPerSolve', 'maxUsdPerDay', 'maxUsdTotal', 'pollSeconds', 'timeoutSeconds']) if (!(Number(c[k]) > 0)) throw bad(`${k} must be a positive number`);
  if (!(Number(c.initialWaitSeconds) >= 0)) throw bad('initialWaitSeconds must be a number >= 0');
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts < 1 || c.maxAttempts > 5) throw bad('maxAttempts must be an integer 1..5');
  if (!c.estimateUsd || typeof c.estimateUsd !== 'object') throw bad('estimateUsd is missing');
  for (const k of KINDS) if (!(Number(c.estimateUsd[k]) > 0)) throw bad(`estimateUsd.${k} must be a positive number`);
  return { ...c, keyFile: expandHome(c.keyFile), ledgerFile: c.ledgerFile ? expandHome(c.ledgerFile) : path.join(stateDir(env), 'captcha/ledger.jsonl') };
}

/** The API key, read here and taught to the output redactor. Callers never print it. */
export function readKey(cfg) {
  let key;
  try { key = fs.readFileSync(cfg.keyFile, 'utf8').trim(); } catch (e) { throw E(`captcha: cannot read the key file ${cfg.keyFile} (${e.code || e.name})`); }
  if (!key) throw E(`captcha: the key file ${cfg.keyFile} is empty`);
  S.registerSecret(key);
  return key;
}

// ---- ledger: append-only, lockless ---------------------------------------------------------------
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function readLedger(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw E(`captcha: cannot read the ledger ${file} (${e.code})`, 'refused'); }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped; its solve is under-counted by at most one estimate */ }
  }
  return out;
}
export function appendLedger(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
/** A solve costs its reported cost once `done`, else its estimate (in flight, crashed, or timed out and maybe charged). */
export function spendSummary(entries, now = Date.now()) {
  const solves = new Map();
  for (const e of entries) {
    if (e.event === 'submit') solves.set(e.id, { at: e.at, usd: e.estimateUsd });
    else if (e.event === 'done' && solves.has(e.id) && typeof e.costUsd === 'number') solves.get(e.id).usd = e.costUsd;
  }
  const today = dayOf(now);
  let todayUsd = 0, totalUsd = 0, todaySolves = 0;
  for (const s of solves.values()) { totalUsd += s.usd; if (dayOf(s.at) === today) { todayUsd += s.usd; todaySolves += 1; } }
  return { today, todayUsd: r6(todayUsd), todaySolves, totalUsd: r6(totalUsd), totalSolves: solves.size };
}
/** Throws (exit 5) when buying one more solve of this kind would break a cap. Nothing has been bought yet. */
export function checkBudget(cfg, kind, entries, now = Date.now()) {
  const est = Number(cfg.estimateUsd[kind]), s = spendSummary(entries, now);
  if (est > cfg.maxUsdPerSolve) throw E(`captcha budget: a ${kind} solve is estimated at $${est}, above maxUsdPerSolve $${cfg.maxUsdPerSolve}; nothing bought`, 'refused');
  if (s.todayUsd + est > cfg.maxUsdPerDay) throw E(`captcha budget: today's spend $${s.todayUsd} plus this solve ($${est}) exceeds maxUsdPerDay $${cfg.maxUsdPerDay}; nothing bought`, 'refused');
  if (s.totalUsd + est > cfg.maxUsdTotal) throw E(`captcha budget: lifetime spend $${s.totalUsd} plus this solve ($${est}) exceeds maxUsdTotal $${cfg.maxUsdTotal}; nothing bought`, 'refused');
  return s;
}

// ---- provider: 2Captcha v2 JSON API --------------------------------------------------------------
export class ProviderError extends Error {
  constructor(code, description) { super(`2captcha ${code}${description ? `: ${description}` : ''}`); this.name = 'ProviderError'; this.providerCode = code; }
}
async function call(cfg, key, method, body, fetchImpl, timeoutMs = 30000) {
  let res, text;
  try {
    res = await fetchImpl(`${cfg.apiBase.replace(/\/$/, '')}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientKey: key, ...body }), signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (e) { throw new ProviderError('NETWORK', String(e?.message || e).split(key).join('[key]').slice(0, 160)); }
  let json;
  try { json = JSON.parse(text); } catch { throw new ProviderError('BAD_RESPONSE', `HTTP ${res.status}, not JSON`); }
  if (json.errorId) throw new ProviderError(json.errorCode || `errorId ${json.errorId}`, String(json.errorDescription || '').slice(0, 200));
  return json;
}
export const getBalance = async (cfg, key, fetchImpl = fetch) => Number((await call(cfg, key, 'getBalance', {}, fetchImpl)).balance);

export function buildTask(widget, pageUrl, opts = {}) {
  const base = { websiteURL: pageUrl, websiteKey: widget.sitekey };
  switch (widget.kind) {
    case 'recaptcha_v2': case 'recaptcha_v2_enterprise':
      return { type: widget.kind === 'recaptcha_v2' ? 'RecaptchaV2TaskProxyless' : 'RecaptchaV2EnterpriseTaskProxyless', ...base,
        ...(widget.invisible ? { isInvisible: true } : {}), ...(widget.dataS ? { recaptchaDataSValue: widget.dataS } : {}) };
    case 'recaptcha_v3':
      return { type: 'RecaptchaV3TaskProxyless', ...base, minScore: opts.minScore, pageAction: opts.action || widget.action || 'verify', ...(widget.enterprise ? { isEnterprise: true } : {}) };
    case 'hcaptcha':
      return { type: 'HCaptchaTaskProxyless', ...base, ...(widget.invisible ? { isInvisible: true } : {}) };
    case 'turnstile':
      return { type: 'TurnstileTaskProxyless', ...base, ...(widget.action || opts.action ? { action: opts.action || widget.action } : {}),
        ...(widget.cData ? { data: widget.cData } : {}), ...(widget.chlPageData ? { pagedata: widget.chlPageData } : {}) };
    default: throw E(`captcha: unsupported kind ${widget.kind}`);
  }
}

/** Submit and poll. Returns {token, userAgent, costUsd, taskId, seconds}. Throws ProviderError, or a timeout CdpError carrying taskId. */
export async function solveWithProvider(cfg, key, task, { fetchImpl = fetch, sleep = K.sleep, now = Date.now } = {}) {
  const t0 = now();
  const { taskId } = await call(cfg, key, 'createTask', { task }, fetchImpl);
  if (!taskId) throw new ProviderError('NO_TASK_ID', 'createTask returned no taskId');
  await sleep(cfg.initialWaitSeconds * 1000);
  for (;;) {
    const r = await call(cfg, key, 'getTaskResult', { taskId }, fetchImpl);
    if (r.status === 'ready') {
      const sol = r.solution || {};
      const token = sol.gRecaptchaResponse || sol.token;
      if (!token) throw new ProviderError('NO_TOKEN', 'the task is ready but carries no token');
      S.registerSecret(token);
      return { token, userAgent: sol.userAgent || null, costUsd: r.cost === undefined ? null : Number(r.cost), taskId, seconds: Math.round((now() - t0) / 100) / 10 };
    }
    if (now() - t0 > cfg.timeoutSeconds * 1000) throw Object.assign(E(`captcha: 2captcha task ${taskId} not ready after ${cfg.timeoutSeconds}s`, 'timeout'), { taskId });
    await sleep(cfg.pollSeconds * 1000);
  }
}

export async function balance(env = process.env, { fetchImpl = fetch } = {}) {
  const cfg = captchaConfig(env), key = readKey(cfg);
  try { return { provider: cfg.provider, balanceUsd: await getBalance(cfg, key, fetchImpl) }; } catch (e) { throw E(`captcha: ${e.message}`, 'verify_failed'); }
}

export function spend(env = process.env, now = Date.now()) {
  const cfg = captchaConfig(env), s = spendSummary(readLedger(cfg.ledgerFile), now);
  return { ...s, limits: { maxUsdPerSolve: cfg.maxUsdPerSolve, maxUsdPerDay: cfg.maxUsdPerDay, maxUsdTotal: cfg.maxUsdTotal },
    remainingTodayUsd: Math.max(0, r6(cfg.maxUsdPerDay - s.todayUsd)), remainingTotalUsd: Math.max(0, r6(cfg.maxUsdTotal - s.totalUsd)), ledger: cfg.ledgerFile };
}
