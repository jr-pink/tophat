#!/usr/bin/env node
// tophat-fanout: send ONE brief to many different models in parallel, each allowed to search the web,
// and hand back every reply side by side for a merge that keeps the disagreements.
//
// One model family tends to converge on the same answers, so the default brief is a REFRAME template, not only
// answer-the-question: the point is diversity (a strong Gemini, a fast one, GPT, Kimi, Grok, a Meta model...).
//
// Reference: README.md beside this file. Routes, in the order a model tries them:
//   gpt-*            OpenAI Responses API with the built-in web_search tool, through rev5/openai.mjs
//                    (platform key, else the Codex ChatGPT subscription); falls back to OpenRouter openai/<id>:online.
//   gemini-*         Google generateContent with google_search grounding when a key file `gemini-api-key` or
//                    `google-api-key` exists in the secrets dir; otherwise OpenRouter <id>:online.
//   everything else  OpenRouter chat completions with the `:online` web plugin (Kimi, Grok, Meta Muse).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDir, envGet } from '../lib/paths.mjs';

export const OPENROUTER = 'https://openrouter.ai/api/v1';
export const DEFAULT_MAX_USD = 5;
export const DEFAULT_MAX_TOKENS = 16000;
const SEARCH_FEE_ESTIMATE = 0.1;

/** The default brief: reframe first, answer last. `{{prompt}}` is the owner's question and context. */
export const REFRAME_TEMPLATE = `You are one of several different AI models given the same question, because one model family tends to converge on the same answers. The point of asking you is DIVERSITY: be specific, be strange where it helps, be willing to be wrong. Label the sections.

1. FREE-ASSOCIATE. Wildly, for a while: whatever comes to mind, however loosely related. Fragments and lists are fine.

2. ASSUMPTION TO DROP. Which assumption inside the question below would you drop or flip first, and what opens up when you do?

3. DIVERGE. Work through each of these:
 - What could you drop entirely (a requirement, a step, a metric)?
 - What else does this remind you of? Analogies from other fields, domains, history, nature, games, other industries.
 - What else could you do cheaply: a cheaper proxy, a smaller experiment, skipping the build, asking someone, buying the answer?
 - What would you do if constrained to one day or one dollar?
 - What would the opposite approach be?
 - Who has already solved a structurally similar problem, and how?

4. ANSWER. Then answer the question directly.

Search the web where it helps. Name specific people, papers, projects and dates, and mark each as found by search or recalled from memory. Say where you disagree with the obvious framing.

---
QUESTION AND CONTEXT:
{{prompt}}
`;

export function buildBrief(prompt, { raw = false, template = REFRAME_TEMPLATE } = {}) {
  const text = String(prompt || '').trim();
  return raw ? text : template.replace('{{prompt}}', () => text);
}

/** The roster. `or` lists exact OpenRouter ids tried in order; `family` picks the newest matching id when none of
 * those exist, so a retired id degrades to its successor instead of dropping the model.
 */
export const ROSTER = Object.freeze({
  'gemini-top': { label: 'Gemini, smartest', or: ['google/gemini-4-argon', '~google/gemini-pro-latest'], family: /^google\/gemini-[\d.]+-(pro|argon)(-preview)?$/ },
  'gemini-fast': { label: 'Gemini, fast', or: ['google/gemini-3.8-flash', '~google/gemini-flash-latest'], family: /^google\/gemini-[\d.]+-flash$/ },
  luna: { label: 'GPT-6 Luna', or: ['openai/gpt-6-luna'], family: /^openai\/gpt-[\d.]+-luna$/ },
  sol: { label: 'GPT-6 Sol', or: ['openai/gpt-6-sol'], family: /^openai\/gpt-[\d.]+-sol$/ },
  astra: { label: 'GPT-6 Astra', or: ['openai/gpt-6-astra'], family: /^openai\/gpt-[\d.]+-astra$/ },
  kimi: { label: 'Kimi', or: ['moonshotai/kimi-k3.1-pro'], family: /^moonshotai\/kimi-k[\d.]+(-pro)?$/ },
  meta: { label: 'Meta Muse', or: ['meta/muse-spark-1.3'], family: /^meta\/muse-spark-[\d.]+$/ },
  grok: { label: 'Grok', or: ['x-ai/grok-4.7'], family: /^x-ai\/grok-[\d.]+$/ }
});
export const DEFAULT_MODELS = Object.keys(ROSTER);

const routeOf = (orId) => orId.startsWith('openai/') ? 'openai' : orId.replace(/^~/, '').startsWith('google/') ? 'gemini' : 'openrouter';
const slug = (s) => String(s).replace(/^~/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Turn the --models list into resolved entries against OpenRouter's /models list.
 * Returns { resolved: [{key, label, orId, route, price}], skipped: [{key, why}] }. Never throws on one bad name.
 */
export function resolveModels(names, catalog) {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const resolved = [], skipped = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    let entry = ROSTER[name], key = name, orId = null, label = name;
    if (entry) {
      label = entry.label;
      orId = entry.or.find((id) => byId.has(id)) || null;
      if (!orId) {
        const fam = catalog.filter((m) => entry.family.test(m.id)).sort((a, b) => (b.created || 0) - (a.created || 0))[0];
        orId = fam?.id || null;
      }
    } else if (name.includes('/')) {
      orId = byId.has(name) ? name : null; key = slug(name);
    } else if (/^gpt-/i.test(name)) {
      orId = byId.has(`openai/${name}`) ? `openai/${name}` : null; key = slug(name);
    } else {
      skipped.push({ key: name, why: `unknown model name; roster keys are ${DEFAULT_MODELS.join(', ')}, or give an OpenRouter id like vendor/model` });
      continue;
    }
    if (!orId) { skipped.push({ key, why: 'no matching id in the OpenRouter models list' }); continue; }
    const m = byId.get(orId);
    resolved.push({ key, label, orId, route: routeOf(orId), price: { input: Number(m.pricing?.prompt) || 0, output: Number(m.pricing?.completion) || 0 } });
  }
  return { resolved, skipped };
}

/** Worst-case spend for the whole fan-out, in USD: full max_tokens at output price plus the prompt plus a search fee each. */
export function estimateWorstCase(resolved, briefBytes, maxTokens = DEFAULT_MAX_TOKENS) {
  return resolved.reduce((sum, m) => sum + maxTokens * m.price.output + Math.ceil(briefBytes / 3) * m.price.input + SEARCH_FEE_ESTIMATE, 0);
}

export function readSecret(name, env = process.env) {
  const home = env.HOME || homedir();
  const dirs = [envGet(env, 'TOPHAT_FANOUT_SECRETS_DIR'), join(configDir(env), 'secrets')].filter(Boolean);
  for (const dir of dirs) {
    try { const v = readFileSync(join(dir, name), 'utf8').trim(); if (v) return v; } catch { /* next */ }
  }
  return null;
}

const redact = (text, secrets) => secrets.filter(Boolean).reduce((t, s) => t.split(s).join('[redacted]'), String(text ?? '')).replace(/\s+/g, ' ').slice(0, 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(fetchImpl, url, headers, body, { timeoutMs, retries = 2 }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no reply in ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) { last = { status: res.status, text }; await sleep(1500 * (attempt + 1)); continue; }
      return { status: res.status, text };
    } catch (error) {
      last = { status: 0, text: String(error?.message || error) };
      await sleep(1500 * (attempt + 1));
    } finally { clearTimeout(timer); }
  }
  return last;
}

/** OpenRouter chat completions with the `:online` web plugin. */
export async function callOpenRouter({ orId, brief, key, maxTokens, effort, fetchImpl, timeoutMs }) {
  const body = { model: `${orId}:online`, messages: [{ role: 'user', content: brief }], max_tokens: maxTokens, usage: { include: true }, ...(effort ? { reasoning: { effort } } : {}) };
  const headers = { authorization: `Bearer ${key}` };
  let res = await postJson(fetchImpl, `${OPENROUTER}/chat/completions`, headers, body, { timeoutMs });
  if (res.status === 400 && body.reasoning) { delete body.reasoning; res = await postJson(fetchImpl, `${OPENROUTER}/chat/completions`, headers, body, { timeoutMs }); }
  if (res.status !== 200) throw new Error(`openrouter HTTP ${res.status} ${redact(res.text, [key])}`);
  let data; try { data = JSON.parse(res.text); } catch { throw new Error('openrouter returned non-JSON'); }
  if (data.error) throw new Error(`openrouter ${redact(JSON.stringify(data.error), [key])}`);
  const choice = data.choices?.[0];
  const text = String(choice?.message?.content || '').trim();
  if (!text) throw new Error(`empty reply (finish_reason ${choice?.finish_reason || 'none'}, ${data.usage?.completion_tokens ?? '?'} completion tokens; raise --max-tokens if it was length)`);
  const sources = (choice.message.annotations || []).map((a) => a.url_citation).filter(Boolean).map((c) => ({ url: c.url, title: c.title }));
  return { text, route: 'openrouter', served_by: data.model || orId, cost_usd: data.usage?.cost ?? null, tokens: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 },
    searches: data.usage?.server_tool_use_details?.web_search_requests ?? null, sources, truncated: choice.finish_reason === 'length' };
}

/** Google generateContent with google_search grounding. Only runs when a Google key file exists. */
export async function callGemini({ orId, brief, key, maxTokens, fetchImpl, timeoutMs }) {
  const model = orId.replace(/^~/, '').replace(/^google\//, '');
  const body = { contents: [{ role: 'user', parts: [{ text: brief }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: maxTokens } };
  const res = await postJson(fetchImpl, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': key }, body, { timeoutMs });
  if (res.status !== 200) throw new Error(`gemini HTTP ${res.status} ${redact(res.text, [key])}`);
  const data = JSON.parse(res.text);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`empty gemini reply (finishReason ${cand?.finishReason || 'none'})`);
  const meta = cand.groundingMetadata || {};
  const sources = (meta.groundingChunks || []).map((c) => c.web).filter(Boolean).map((w) => ({ url: w.uri, title: w.title }));
  const u = data.usageMetadata || {};
  return { text, route: 'gemini-google_search', served_by: data.modelVersion || model, cost_usd: null, tokens: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
    searches: (meta.webSearchQueries || []).length, sources, truncated: cand.finishReason === 'MAX_TOKENS' };
}

/** OpenAI Responses API with web_search, reusing rev5/openai.mjs for auth, origin and event parsing. */
export async function callOpenAI({ orId, brief, env, maxTokens, effort, fetchImpl, timeoutMs }) {
  // call.mjs first: model.mjs and openai.mjs import each other, and only this entry order initialises cleanly.
  await import('../../runner/rev5/call.mjs');
  const { openaiAuthMode, openaiHeaders, openaiRequestUrl, parseResponsesFrame, usageFrom, classifyOpenAIStatus } = await import('../../runner/rev5/openai.mjs');
  const { resolveCredentials } = await import('../../runner/rev5/model-credentials.mjs');
  const creds = resolveCredentials(env);
  const mode = openaiAuthMode(creds.env);
  if (!mode) throw new Error('no OpenAI credential (platform key or Codex ChatGPT sign-in)');
  const model = orId.replace(/^openai\//, '');
  const body = { model, input: [{ role: 'user', content: [{ type: 'input_text', text: brief }] }], stream: true, store: false, tools: [{ type: 'web_search' }],
    ...(effort ? { reasoning: { effort } } : {}), ...(mode === 'chatgpt' ? {} : { max_output_tokens: maxTokens }) };
  const res = await postJson(fetchImpl, openaiRequestUrl(creds.env), openaiHeaders(creds.env), body, { timeoutMs });
  if (res.status !== 200) throw classifyOpenAIStatus(res.status, res.text);
  let text = '', searches = 0, usage = null, incomplete = false; const sources = new Map();
  for (const frame of res.text.split('\n\n')) {
    const e = parseResponsesFrame(frame);
    if (!e) continue;
    if (e.type === 'response.output_text.delta') text += e.delta || '';
    else if (e.type === 'response.web_search_call.completed') searches += 1;
    else if (e.type === 'response.output_text.annotation.added' && e.annotation?.url) sources.set(e.annotation.url, e.annotation.title);
    else if (e.type === 'response.completed' || e.type === 'response.incomplete') { usage = e.response?.usage; incomplete = e.type === 'response.incomplete'; }
    else if (e.type === 'response.failed' || e.type === 'error') throw new Error(`openai ${redact(JSON.stringify(e.response?.error || e.error || e), [])}`);
  }
  text = text.trim();
  if (!text) throw new Error('empty openai reply');
  const u = usageFrom(usage || {});
  return { text, route: mode === 'chatgpt' ? 'openai-chatgpt-subscription' : 'openai-api-key', served_by: model, cost_usd: mode === 'chatgpt' ? 0 : null,
    tokens: { in: u.input_tokens, out: u.output_tokens }, searches, sources: [...sources].map(([url, title]) => ({ url, title })), truncated: incomplete };
}

const apiEquivalent = (tokens, price) => Math.round((tokens.in * price.input + tokens.out * price.output) * 1e6) / 1e6;

/** One model, with its route chain; never throws. */
async function runOne(entry, ctx) {
  const started = Date.now();
  const { brief, env, maxTokens, effort, fetchImpl, timeoutMs, orKey, geminiKey } = ctx;
  const attempts = [];
  const routes = [];
  if (entry.route === 'openai') routes.push(['openai', () => callOpenAI({ orId: entry.orId, brief, env, maxTokens, effort, fetchImpl, timeoutMs })]);
  if (entry.route === 'gemini' && geminiKey) routes.push(['gemini', () => callGemini({ orId: entry.orId, brief, key: geminiKey, maxTokens, fetchImpl, timeoutMs })]);
  routes.push(['openrouter', () => callOpenRouter({ orId: entry.orId, brief, key: orKey, maxTokens, effort, fetchImpl, timeoutMs })]);
  for (const [name, run] of routes) {
    try {
      const r = await run();
      const cost = r.cost_usd ?? null;
      return { ...entry, ok: true, ...r, cost_usd: cost, api_equiv_usd: r.cost_usd === 0 || r.cost_usd == null ? apiEquivalent(r.tokens, entry.price) : cost, attempts, seconds: Math.round((Date.now() - started) / 100) / 10 };
    } catch (error) {
      attempts.push({ route: name, error: redact(error?.message || error, [orKey, geminiKey]) });
    }
  }
  return { ...entry, ok: false, attempts, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

const money = (n) => n == null ? 'cost unknown' : `$${n.toFixed(4)}`;

function replyFile(r, brief) {
  const head = [`# ${r.label} (${r.key})`, '', `- model: ${r.orId} (served by ${r.served_by}) via ${r.route}`,
    `- cost: ${r.route.startsWith('openai-chatgpt') ? `plan-metered; API-equivalent ${money(r.api_equiv_usd)}` : money(r.cost_usd)}; tokens in ${r.tokens.in}, out ${r.tokens.out}; web searches ${r.searches ?? 'unknown'}; ${r.seconds}s`,
    ...(r.truncated ? ['- WARNING: output was cut at the token limit'] : []),
    ...(r.attempts.length ? [`- earlier routes failed: ${r.attempts.map((a) => `${a.route}: ${a.error}`).join(' | ')}`] : []), ''];
  const src = r.sources.length ? ['', '## Sources the provider reported', ...r.sources.slice(0, 40).map((s) => `- ${s.title ? `${s.title}: ` : ''}${s.url}`)] : [];
  return `${head.join('\n')}\n${r.text}\n${src.join('\n')}\n`;
}

/** The whole fan-out. Returns { results, skipped, outDir, mergeInput, totals }. */
export async function runFanout({ prompt, models = DEFAULT_MODELS, outDir, raw = false, maxUsd = DEFAULT_MAX_USD, maxTokens = DEFAULT_MAX_TOKENS,
  effort = 'medium', timeoutMs = 240_000, stdoutChars = 7000, env = process.env, fetchImpl = fetch, log = () => {}, dryRun = false } = {}) {
  const orKey = readSecret('openrouter-api-key', env);
  if (!orKey) throw new Error('openrouter-api-key not found in the secrets dir (TOPHAT_FANOUT_SECRETS_DIR or <config dir>/secrets; needed for the model list and the :online routes)');
  const geminiKey = readSecret('gemini-api-key', env) || readSecret('google-api-key', env);
  const listRes = await fetchImpl(`${OPENROUTER}/models`, { headers: { authorization: `Bearer ${orKey}` } });
  if (listRes.status !== 200) throw new Error(`OpenRouter /models HTTP ${listRes.status}`);
  const catalog = (await listRes.json()).data || [];
  const { resolved, skipped } = resolveModels(models, catalog);
  const brief = buildBrief(prompt, { raw });
  const worst = estimateWorstCase(resolved, Buffer.byteLength(brief), maxTokens);
  log(`resolved: ${resolved.map((m) => `${m.key}=${m.orId}(${m.route})`).join(', ') || 'none'}`);
  for (const s of skipped) log(`skipped ${s.key}: ${s.why}`);
  log(`worst-case spend ${money(worst)} against cap ${money(maxUsd)}; gemini direct key: ${geminiKey ? 'yes' : 'no (using OpenRouter :online)'}`);
  if (worst > maxUsd) throw new Error(`worst-case spend ${money(worst)} is over --max-usd ${maxUsd}; lower --max-tokens, drop models, or raise the cap`);
  if (!resolved.length) throw new Error('no model resolved');
  if (dryRun) return { results: [], skipped, resolved, outDir, mergeInput: '', totals: { worst_case_usd: worst }, brief };

  const ctx = { brief, env, maxTokens, effort, fetchImpl, timeoutMs, orKey, geminiKey };
  const dir = outDir ? resolve(outDir) : null;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '_brief.md'), `${brief}\n`); }
  // Each model has a hard overall deadline (all its routes together) and its reply is on disk the moment it returns,
  // so one slow model can neither block the others nor keep finished replies off the disk.
  const results = await Promise.all(resolved.map(async (m) => {
    let timer;
    const deadline = new Promise((res) => { timer = setTimeout(() => res({ ...m, ok: false, attempts: [{ route: 'deadline', error: `no reply within ${Math.round(timeoutMs / 1000)}s` }], seconds: Math.round(timeoutMs / 100) / 10 }), timeoutMs + Math.min(5000, timeoutMs)); });
    const r = await Promise.race([runOne(m, { ...ctx, timeoutMs }), deadline]);
    clearTimeout(timer);
    if (dir) writeFileSync(join(dir, r.ok ? `${slug(r.key)}.md` : `${slug(r.key)}.FAILED.md`), r.ok ? replyFile(r, brief) : `# ${r.label} (${r.key}) FAILED\n\n${r.attempts.map((a) => `- ${a.route}: ${a.error}`).join('\n')}\n`);
    log(`${r.key} ${r.ok ? `answered in ${r.seconds}s (${money(r.cost_usd ?? r.api_equiv_usd)})` : `FAILED: ${r.attempts.map((a) => a.error).join(' | ')}`}`);
    return r;
  }));
  const ok = results.filter((r) => r.ok), failed = results.filter((r) => !r.ok);
  const totals = {
    cost_usd: Math.round(ok.reduce((s, r) => s + (r.cost_usd || 0), 0) * 1e4) / 1e4,
    api_equiv_usd: Math.round(ok.reduce((s, r) => s + (r.api_equiv_usd || 0), 0) * 1e4) / 1e4,
    worst_case_usd: Math.round(worst * 1e4) / 1e4
  };
  if (dir) {
    writeFileSync(join(dir, '_run.json'), `${JSON.stringify({ at: new Date().toISOString(), resolved: resolved.map(({ key, orId, route }) => ({ key, orId, route })), skipped,
      results: results.map(({ key, orId, ok: o, route, served_by, cost_usd, api_equiv_usd, tokens, searches, seconds, attempts }) => ({ key, orId, ok: o, route, served_by, cost_usd, api_equiv_usd, tokens, searches, seconds, attempts })), totals }, null, 2)}\n`);
  }
  const cut = (t) => t.length > stdoutChars ? `${t.slice(0, stdoutChars)}\n[cut at ${stdoutChars} of ${t.length} chars; full text in ${outDir ? `${outDir}/` : 'the out dir'}]` : t;
  const mergeInput = [
    `# tophat-fanout merge input: ${ok.length} of ${results.length + skipped.length} models answered`, '',
    'Merge rules: keep disagreements; list ideas that ONLY ONE model had (the diversity payoff) separately from consensus; list named people, papers and projects worth verifying, marking which a model found by search.', '',
    ...ok.flatMap((r) => [`## ${r.key}: ${r.label} (${r.served_by}, ${r.route}, ${money(r.api_equiv_usd)} API-equivalent, ${r.searches ?? '?'} searches)`, '', cut(r.text), '']),
    ...(failed.length || skipped.length ? ['## Not answered', ...failed.map((r) => `- ${r.key}: ${r.attempts.map((a) => `${a.route}: ${a.error}`).join(' | ')}`), ...skipped.map((s) => `- ${s.key}: ${s.why}`), ''] : []),
    `Totals: charged ${money(totals.cost_usd)} (OpenRouter), API-equivalent of everything ${money(totals.api_equiv_usd)}; OpenAI models ran on the plan when the ChatGPT sign-in was used.`
  ].join('\n');
  if (dir) writeFileSync(join(dir, '_merge-input.md'), `${mergeInput}\n`);
  return { results, skipped, resolved, outDir, mergeInput, totals, brief };
}

function parseArgs(argv) {
  const o = { models: DEFAULT_MODELS };
  const need = (i, flag) => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prompt-file') { o.promptFile = need(i, a); i += 1; }
    else if (a === '--models') { o.models = need(i, a).split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (a === '--out') { o.out = need(i, a); i += 1; }
    else if (a === '--max-usd') { o.maxUsd = Number(need(i, a)); i += 1; }
    else if (a === '--max-tokens') { o.maxTokens = Number(need(i, a)); i += 1; }
    else if (a === '--timeout') { o.timeoutMs = Number(need(i, a)) * 1000; i += 1; }
    else if (a === '--effort') { o.effort = need(i, a); i += 1; }
    else if (a === '--stdout-chars') { o.stdoutChars = Number(need(i, a)); i += 1; }
    else if (a === '--raw') o.raw = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--show-template') o.showTemplate = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const USAGE = `tophat-fanout --prompt-file F [--models a,b,c] [--out DIR] [--raw] [--max-usd 5] [--max-tokens 16000] [--effort medium] [--timeout 240] [--stdout-chars 7000] [--dry-run]
  Sends the same brief to every model in parallel (web search on), writes DIR/<model>.md, prints a merge input.
  Default brief: the reframe template (free-associate, drop an assumption, diverge, answer) around the text of F; --raw sends F as is.
  Roster keys: ${DEFAULT_MODELS.join(', ')}; or any OpenRouter id (vendor/model) or gpt-* id. --dry-run resolves ids and prices only.
  --show-template prints the reframe template.`;

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (o.showTemplate) { process.stdout.write(REFRAME_TEMPLATE); return 0; }
  if (!o.promptFile) throw new Error('--prompt-file is required');
  const prompt = readFileSync(o.promptFile, 'utf8');
  const result = await runFanout({ prompt, models: o.models, outDir: o.out, raw: o.raw, maxUsd: o.maxUsd, maxTokens: o.maxTokens, effort: o.effort, timeoutMs: o.timeoutMs,
    stdoutChars: o.stdoutChars, dryRun: o.dryRun, log: (m) => process.stderr.write(`tophat-fanout: ${m}\n`) });
  if (o.dryRun) { process.stdout.write(`dry run: ${result.resolved.map((m) => `${m.key}=${m.orId}`).join(' ')}\n`); return 0; }
  process.stdout.write(`${result.mergeInput}\n`);
  return result.results.some((r) => r.ok) ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { process.stderr.write(`tophat-fanout: ${String(error?.message || error)}\n`); process.exit(1); });
}
