// Mercury, Oura, Toggl and Hevy, pulled from their read-only REST APIs (set `kind` on the source: mercury | oura | toggl |
// hevy). Each record's revision is the sha256 of its canonical JSON payload. Credentials are references in config:
// config.credential (a secret name, see ../lib/secrets.mjs; defaults mercury-api-token, toggl-api-token, hevy-api-key /
// hevy-web-session) and, for Oura, config.oauthFile (an OAuth token JSON refreshed under a lock; it rotates the refresh
// token and keeps the previous one for one retry). Oura re-checks 14 days behind the newest day seen, 400 days on a
// first run. Mercury balances are one snapshot per account per day. Ported from an upstream adapter (VENDOR.json `ported`).
import fs from 'node:fs';
import { readSecret } from '../lib/secrets.mjs';
import { fetchJson, guardedFetch, readCapped } from '../lib/http.mjs';
import { canonical, fail, isoOrFail, revisionOf, sha } from '../lib/common.mjs';

const record = (payload, occurredAt, text = canonical(payload)) => ({ id: payload.source_id, revision: revisionOf(payload), occurredAt: isoOrFail(occurredAt), text, metadata: { type: payload.schema } });
const secret = (name, read = readSecret) => { const v = read(name); if (!v) fail('credential-required', { secret: name }); return v; };
const day = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => day(Date.parse(`${d}T00:00:00Z`) + n * 86400000);

// ---- Mercury ----
const MERCURY = 'https://api.mercury.com/api/v1';
export function normalizeTransaction(t, a) {
  return { schema: 'linknotes.mercury-transaction/v1', source: 'mercury-transactions', source_id: `${a.id}:${t.id}`, account_id: a.id, account_name: a.name ?? null,
    account_nickname: a.nickname ?? null, account_legal_business_name: a.legalBusinessName ?? null, account_number_last4: a.accountNumber ? String(a.accountNumber).slice(-4) : null,
    transaction_id: t.id, amount: t.amount ?? null, status: t.status ?? null, kind: t.kind ?? null, counterparty_id: t.counterpartyId ?? null, counterparty_name: t.counterpartyName ?? null,
    counterparty_nickname: t.counterpartyNickname ?? null, bank_description: t.bankDescription ?? null, external_memo: t.externalMemo ?? null, note: t.note ?? null,
    created_at: t.createdAt ?? null, posted_at: t.postedAt ?? null, estimated_delivery_date: t.estimatedDeliveryDate ?? null, failed_at: t.failedAt ?? null,
    reason_for_failure: t.reasonForFailure ?? null, dashboard_link: t.dashboardLink ?? null, details: t.details ?? null, updated_at: t.postedAt || t.createdAt || null };
}
export function normalizeAccount(a, observedAt) {
  return { schema: 'linknotes.mercury-account/v1', source: 'mercury-transactions', source_id: `${a.id}:${observedAt.slice(0, 10)}`, account_id: a.id, name: a.name ?? null,
    nickname: a.nickname ?? null, legal_business_name: a.legalBusinessName ?? null, account_number_last4: a.accountNumber ? String(a.accountNumber).slice(-4) : null,
    routing_number_present: !!a.routingNumber, type: a.type ?? null, kind: a.kind ?? null, status: a.status ?? null, current_balance: a.currentBalance ?? null,
    available_balance: a.availableBalance ?? null, created_at: a.createdAt ?? null, observed_at: observedAt, updated_at: observedAt };
}
async function mercuryGet(endpoint, token, fetchImpl) {
  const { json } = await fetchJson(`${MERCURY}${endpoint}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: 30000, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!json || typeof json !== 'object') fail('mercury-invalid-response');
  return json;
}
export async function pollMercury(source, { now = new Date(), fetch: fetchImpl, readSecret: read } = {}) {
  const token = secret(source.config?.credential ?? 'mercury-api-token', read), observedAt = isoOrFail(now);
  const accounts = (await mercuryGet('/accounts', token, fetchImpl)).accounts;
  if (!Array.isArray(accounts)) fail('mercury-invalid-response');
  let credit = [];
  try {
    const known = new Set(accounts.map((a) => a.id)), byAccount = new Map();
    for (const c of (await mercuryGet('/cards', token, fetchImpl)).cards || []) if (c.kind === 'credit' && c.accountId && !known.has(c.accountId) && !byAccount.has(c.accountId))
      byAccount.set(c.accountId, { id: c.accountId, name: 'Mercury IO Credit', kind: 'credit', legalBusinessName: c.legalBusinessName ?? null, accountNumber: null });
    credit = [...byAccount.values()];
  } catch (e) { if (![403, 404].includes(e.status)) throw e; }
  const start = source.config?.start ?? day(Date.parse(observedAt) - 35 * 86400000), records = [], failures = [];
  for (const a of [...accounts, ...credit]) {
    try {
      for (let offset = 0; ; offset += 500) {
        const page = (await mercuryGet(`/account/${encodeURIComponent(a.id)}/transactions?${new URLSearchParams({ limit: '500', offset: String(offset), start })}`, token, fetchImpl)).transactions || [];
        for (const t of page) { const p = normalizeTransaction(t, a); records.push(record(p, p.updated_at || observedAt)); }
        if (page.length < 500 || offset > 100000) break;
      }
    } catch (e) { failures.push({ unit: a.id, code: e.code || `http-${e.status ?? 'error'}` }); }
  }
  for (const a of accounts) { const p = normalizeAccount(a, observedAt); records.push(record(p, observedAt)); }
  return { records, cursor: { observedAt, start }, complete: !failures.length, health: { status: failures.length ? 'partial' : 'ok', unreadable: failures, coverage: 'window-35d' } };
}

// ---- Oura ----
const OURA = 'https://api.ouraring.com/v2/usercollection';
export const OURA_ENDPOINTS = ['daily_sleep', 'sleep', 'daily_readiness', 'daily_activity', 'workout', 'daily_spo2', 'daily_stress', 'personal_info'];
export function normalizeOura(endpoint, r, observedAt) {
  const d = r.day || (r.start_datetime ? String(r.start_datetime).slice(0, 10) : null) || (r.timestamp ? String(r.timestamp).slice(0, 10) : null) || observedAt.slice(0, 10);
  return { schema: 'linknotes.oura-document/v1', source: 'oura', oura_endpoint: endpoint,
    source_id: r.id && endpoint !== 'personal_info' ? `${endpoint}:${r.id}` : `${endpoint}:${observedAt.slice(0, 10)}`, day: d,
    updated_at: r.timestamp || r.bedtime_end || r.end_datetime || `${d}T00:00:00+00:00`, record: r };
}
/** Oura OAuth store (file, rotates): refresh under a mkdir lock, previous refresh token kept for one retry. */
export async function ouraToken({ file, fetch: fetchImpl = globalThis.fetch, stale = null, skewMs = 120000 } = {}) {
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const fresh = (s) => s.access_token && s.expires_at && s.expires_at - skewMs > Date.now() && s.access_token !== stale;
  let s = read(); if (fresh(s)) return s.access_token;
  const lock = `${file}.lock`; let got = false;
  for (let i = 0; i < 60 && !got; i++) { try { fs.mkdirSync(lock); got = true; } catch (e) { if (e.code !== 'EEXIST') throw e; try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } await new Promise((r) => setTimeout(r, 500)); } }
  if (!got) fail('oura-refresh-locked');
  try {
    s = read(); if (fresh(s)) return s.access_token;
    const post = async (refresh) => { const r = await guardedFetch('https://api.ouraring.com/oauth/token', { method: 'POST', fetchImpl, allowStatus: [400, 401],
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: s.client_id, client_secret: s.client_secret }).toString() });
      const j = await r.json().catch(() => ({})); if (!r.ok || j.error || !j.access_token) fail(j.error === 'invalid_grant' ? 'oura-refresh-rejected' : 'oura-bad-token-response'); return j; };
    let t; try { t = await post(s.refresh_token); } catch (e) { if (e.code === 'oura-refresh-rejected' && s.refresh_token_prev) t = await post(s.refresh_token_prev); else throw e; }
    const next = { ...s, access_token: t.access_token, refresh_token: t.refresh_token || s.refresh_token, refresh_token_prev: t.refresh_token && t.refresh_token !== s.refresh_token ? s.refresh_token : s.refresh_token_prev,
      expires_at: Date.now() + (Number(t.expires_in) || 86400) * 1000, scope: t.scope || s.scope, refreshed_at: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file);
    return next.access_token;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export async function pollOura(source, { cursor = null, now = new Date(), fetch: fetchImpl = globalThis.fetch, token: given } = {}) {
  const c = source.config ?? {}, today = day(now), observedAt = isoOrFail(now), lastDay = { ...(cursor?.lastDay ?? {}) }, records = [], failures = [];
  let token = given ?? await ouraToken({ file: c.oauthFile, fetch: fetchImpl });
  const get = async (endpoint, params) => {
    const url = `${OURA}/${endpoint}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))}`;
    const send = () => guardedFetch(url, { fetchImpl, allowStatus: [400, 401, 403, 404, 422, 429], headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    let r = await send();
    if (r.status === 401 && !given) { const n = await ouraToken({ file: c.oauthFile, fetch: fetchImpl, stale: token }).catch(() => null); if (n && n !== token) { token = n; r = await send(); } }
    if (!r.ok) fail(r.status === 429 ? 'oura-rate-limited' : r.status === 401 || r.status === 403 ? 'oura-bad-token' : `http-${r.status}`);
    return JSON.parse(await readCapped(r, 8 << 20, url));
  };
  for (const endpoint of c.endpoints ?? OURA_ENDPOINTS) {
    try {
      const since = lastDay[endpoint] ? addDays(lastDay[endpoint], -14) : addDays(today, -400);
      const ranges = [];
      if (endpoint === 'personal_info') ranges.push([null, null]); else for (let s = since; s <= today; s = addDays(s, 180)) { const e = addDays(s, 179); ranges.push([s, e > today ? today : e]); }
      for (const [start, end] of ranges) {
        let next = null, guard = 0;
        do {
          const body = await get(endpoint, { next_token: next, start_date: start, end_date: end });
          for (const r of (Array.isArray(body?.data) ? body.data : [body]).filter(Boolean)) {
            const p = normalizeOura(endpoint, r, observedAt); records.push(record(p, p.updated_at));
            if (!lastDay[endpoint] || p.day > lastDay[endpoint]) lastDay[endpoint] = p.day;
          }
          const prev = next; next = body?.next_token || null; if (next && next === prev) next = null;
        } while (next && ++guard < 200);
      }
    } catch (e) { failures.push({ unit: endpoint, code: e.code || 'oura-read-failed' }); }
  }
  if (failures.length === (c.endpoints ?? OURA_ENDPOINTS).length) fail(failures[0].code);
  return { records, cursor: { lastDay }, complete: !failures.length, health: { status: failures.length ? 'partial' : 'ok', unreadable: failures, coverage: 'recheck-14d' } };
}

// ---- Toggl ----
export function normalizeToggl(e, projects = new Map()) {
  const p = projects.get(String(e.project_id)) || null;
  return { schema: 'linknotes.toggl-time-entry/v1', source: 'toggl-track', source_id: String(e.id), workspace_id: e.workspace_id ?? null, user_id: e.user_id ?? null,
    project_id: e.project_id ?? null, project_name: p?.name ?? null, client_id: p?.client_id ?? null, client_name: p?.client_name ?? null, description: e.description || '',
    tags: e.tags || [], tag_ids: e.tag_ids || [], start: e.start, stop: e.stop ?? null, duration: e.duration, billable: !!e.billable, updated_at: e.at || e.server_deleted_at || e.stop || e.start };
}
export async function pollToggl(source, { now = new Date(), fetch: fetchImpl, readSecret: read } = {}) {
  const token = secret(source.config?.credential ?? 'toggl-api-token', read);
  const get = async (p) => (await fetchJson(`https://api.track.toggl.com/api/v9${p}`, { maxBytes: 4 << 20, headers: { authorization: `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}` }, ...(fetchImpl ? { fetchImpl } : {}) })).json;
  const q = new URLSearchParams(); if (source.config?.start) q.set('start_date', isoOrFail(source.config.start)); if (source.config?.end) q.set('end_date', isoOrFail(source.config.end));
  const entries = await get(`/me/time_entries${q.size ? `?${q}` : ''}`);
  if (!Array.isArray(entries)) fail('toggl-invalid-response');
  const [projects, clients] = await Promise.all([get('/me/projects'), get('/me/clients')]);
  const names = new Map((clients || []).map((c) => [String(c.id), c.name]));
  const map = new Map((projects || []).map((p) => [String(p.id), { ...p, client_name: p.client_name ?? (p.client_id == null ? null : names.get(String(p.client_id)) ?? null) }]));
  return { records: entries.map((e) => { const p = normalizeToggl(e, map); return record(p, p.updated_at); }), cursor: { observedAt: isoOrFail(now) }, complete: false, health: { status: 'ok', coverage: 'api-retained-window' } };
}

// ---- Hevy ----
export function fromDeveloperApi(w) {
  const sec = (t) => Math.floor(new Date(t).getTime() / 1000);
  return { id: w.id, name: w.title, description: w.description ?? null, start_time: sec(w.start_time), end_time: sec(w.end_time), updated_at: w.updated_at, route: 'developer-api',
    exercises: (w.exercises || []).map((e) => ({ title: e.title, notes: e.notes ?? null, exercise_template_id: e.exercise_template_id ?? null, superset_id: e.supersets_id ?? null,
      sets: (e.sets || []).map((x) => ({ reps: x.reps ?? null, weight_kg: x.weight_kg ?? null, rpe: x.rpe ?? null, duration_seconds: x.duration_seconds ?? null, distance_meters: x.distance_meters ?? null, type: x.type ?? null })) })) };
}
const lb = (kg) => Math.round((kg / 0.45359237) * 10) / 10, num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
function setText(s) {
  const b = [];
  if (s.reps != null && s.weight_kg != null) b.push(`${s.reps}@${num(lb(s.weight_kg))}lb`); else if (s.reps != null) b.push(`${s.reps} reps`); else if (s.weight_kg != null) b.push(`${num(lb(s.weight_kg))}lb`);
  if (s.duration_seconds != null) b.push(`${s.duration_seconds}s`); if (s.distance_meters != null) b.push(`${s.distance_meters}m`); if (s.rpe != null) b.push(`rpe${s.rpe}`);
  return (s.indicator === 'warmup' || s.type === 'warmup' ? 'w ' : '') + (b.length ? b : ['set']).join(' ');
}
/** The greppable line: name, date, minutes, then each exercise with collapsed sets (3x 5@135lb), superset marks and notes. */
export function summarizeWorkout(w) {
  const mins = w.start_time && w.end_time ? Math.round((w.end_time - w.start_time) / 60) : null;
  const sets = (list = []) => { const g = []; for (const s of list) { const t = setText(s); if (g.at(-1)?.t === t) g.at(-1).n++; else g.push({ t, n: 1 }); } return g.map((x) => (x.n > 1 ? `${x.n}x ${x.t}` : x.t)).join(', '); };
  return `${[w.name || 'Workout', new Date(w.start_time * 1000).toISOString().slice(0, 10), mins == null ? null : `${mins} min`].filter(Boolean).join(' \u00b7 ')} \u00b7 ${(w.exercises || []).map((e) => {
    const note = (e.notes || '').trim().replace(/\s+/g, ' '); return `${e.title}${e.superset_id == null ? '' : ` [ss${e.superset_id}]`}: ${sets(e.sets)}${note ? ` (${note})` : ''}`; }).join(' | ')}`;
}
export async function pollHevy(source, { fetch: fetchImpl, readSecret: read = readSecret, now = new Date() } = {}) {
  const key = read('hevy-api-key'), workouts = [], measurements = [];
  const get = async (base, p, headers) => (await fetchJson(`${base}${p}`, { timeoutMs: 30000, headers, ...(fetchImpl ? { fetchImpl } : {}) })).json;
  if (key) {
    for (let page = 1; ; page++) { const j = await get('https://api.hevyapp.com/v1', `/workouts?page=${page}&pageSize=10`, { 'api-key': key }); workouts.push(...(j.workouts || []).map(fromDeveloperApi)); if (!j.workouts?.length || page >= (j.page_count || 1)) break; }
  } else {
    let s; try { s = JSON.parse(secret('hevy-web-session', read)); } catch (e) { fail(e.code || 'hevy-session-invalid'); }
    if (!s.authorization || !s['x-api-key'] || !s.username) fail('hevy-session-incomplete');
    if (s.expires_at && Date.parse(s.expires_at) - 60000 < Date.parse(isoOrFail(now))) fail('hevy-session-expired', { ownerStep: 'open hevy.com in the automation Chrome so the browser renews its session' });
    const h = { authorization: s.authorization, 'x-api-key': s['x-api-key'], 'Hevy-Platform': s['Hevy-Platform'] || 'web', 'x-client-time': String(Date.now()), accept: 'application/json', origin: 'https://hevy.com', referer: 'https://hevy.com/' };
    const { workout_count: total } = await get('https://api.hevyapp.com', '/workout_count', h);
    for (let off = 0; off < total; off += 5) { const p = await get('https://api.hevyapp.com', `/user_workouts_paged?username=${encodeURIComponent(s.username)}&limit=5&offset=${off}`, h); if (!p.workouts?.length) break; workouts.push(...p.workouts.map((w) => ({ ...w, route: 'web' }))); }
    measurements.push(...(await get('https://api.hevyapp.com', '/body_measurements', h).catch(() => [])));
  }
  const rec = (id, payload, when, text) => ({ id, revision: sha(canonical(payload)), occurredAt: isoOrFail(when), text, metadata: { type: 'hevy', payload: canonical(payload) } });
  return { records: [...workouts.map((w) => rec(String(w.id), w, w.start_time * 1000, summarizeWorkout(w))),
    ...measurements.map((m) => rec(`bw-${m.id}`, m, m.date, `${m.date} \u00b7 ${m.weight_kg == null ? 'no weight recorded' : `${lb(m.weight_kg)} lb (${Math.round(m.weight_kg * 100) / 100} kg)`}`))],
    cursor: { observedAt: isoOrFail(now) }, complete: true, health: { status: 'ok', coverage: key ? 'developer-api' : 'web-session' } };
}

export async function poll(source, ctx = {}) {
  const f = { mercury: pollMercury, oura: pollOura, toggl: pollToggl, hevy: pollHevy }[source.kind];
  return f ? f(source, ctx) : fail('unsupported-http-kind');
}
