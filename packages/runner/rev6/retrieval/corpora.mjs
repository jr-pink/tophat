// Corpus readers: one function per printed block of tophat-ask, each taking the
// query context `c` (built in query.mjs) and returning the block's lines.
// Determinism: every multi-file ripgrep result is sorted by (path, line) before
// ranking, mdfind and find output are sorted, and every remaining sort ends on
// a path, so equal scores cannot reorder between runs.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { privateLabelSet, withholdRow } from '../base/privacy.mjs';
import { decodeAttributedBody } from '../../src/connectors/imessage.mjs';
import { STOP, tokenize } from './terms.mjs';
import { secretExportName } from '../../src/vault/secret-file.mjs';
import { fastRg, planFastRg } from './rg-fast.mjs';
import { bestLines as bestDocLines, bounded, diverseQuotes, docScore, esc, paragraphHits, rank as rankLines, rankedWithTotal,
  rankFiles, rowTime, specificTier, spotlightNote, spotlightTiers, spreadDirs, winningTier } from './rank.mjs';
const run = promisify(execFile);

// ---- process helpers ----------------------------------------------------------
export const sh = async (c, cmd, args, opts = {}) => (await run(cmd, args, { maxBuffer: 32 << 20, timeout: c.grepMs, ...opts })).stdout;
/** Debug (ASK_RG_FAST_VERIFY=<file>): run the original too and log whether the line sets match, with both times. */
async function verifyFast(c, cmd, args, opts, fast, fastMs) {
  const t0 = Date.now();
  let orig; try { orig = await sh(c, cmd, args, opts); } catch (e) { orig = e?.code === 1 ? '' : `ERROR ${e?.code}`; }
  const lines = (t) => String(t).split('\n').filter(Boolean).sort(), a = lines(orig), b = fast == null ? null : lines(fast);
  const same = b != null && a.length === b.length && a.every((l, i) => l === b[i]);
  appendFileSync(c.env.ASK_RG_FAST_VERIFY, `${JSON.stringify({ planned: Boolean(planFastRg(args)), args: args.filter((x) => !x.includes('|')).slice(-3), fell_back: fast == null, same: fast == null ? null : same,
    orig_lines: a.length, fast_lines: b?.length ?? null, orig_ms: Date.now() - t0, fast_ms: fastMs, ...(same || fast == null ? {} : { only_orig: a.filter((l) => !b.includes(l)).slice(0, 3), only_fast: b.filter((l) => !a.includes(l)).slice(0, 3) }) })}\n`);
}
/** A search exits 1 on no match; any other exit or a kill means the corpus was not read, and says so. */
export async function shSearch(c, cmd, args, opts = {}) {
  try {
    // fastsearch: ASCII word boundaries in ripgrep, re-checked against the Unicode pattern (rg-fast.mjs); same lines
    if (c.env?.ASK_RG_ASCII_WB === '1' && cmd === c.rg && !c.rev) {
      const t0 = Date.now(), fast = await fastRg((cm, ar) => sh(c, cm, ar, opts), cmd, args), fastMs = Date.now() - t0;
      if (c.env.ASK_RG_FAST_VERIFY) await verifyFast(c, cmd, args, opts, fast, fastMs);
      if (fast != null) return fast;
    }
    return await sh(c, cmd, args, opts);
  } catch (e) {
    if (e && e.code === 1 && !e.killed && !e.signal) return '';
    if (e && e.code === 'ENOENT') throw new Error(`SEARCH BINARY MISSING: ${cmd} could not be started (ENOENT); install ripgrep or set TOPHAT_RIPGREP`);
    const why = e.killed || e.signal ? `killed after ${opts.timeout || c.grepMs}ms; raise ASK_GREP_MS` : String(e.stderr || e.message).split('\n')[0].slice(0, 100);
    throw new Error(`${cmd} could not read this corpus: ${why}`);
  }
}
/** Ripgrep output sorted by (file order or path, line number), so ties rank the same every run. */
export function sortGrep(lines, files = null) {
  const key = (l) => {
    if (files) { const i = files.findIndex((f) => l.startsWith(f + ':')); return [i < 0 ? files.length : i, '', 0]; }
    const m = /^([^:]*):(\d+):/.exec(l);
    return [0, m ? m[1] : l, m ? Number(m[2]) : 0];
  };
  return lines.map((l, i) => ({ l, i, k: key(l) }))
    .sort((a, b) => a.k[0] - b.k[0] || (a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : 0) || a.k[2] - b.k[2] || a.i - b.i).map((x) => x.l);
}
/** Lines a streaming command produced before a deadline; the child group is killed at the deadline. */
export function boundedLines(cmd, args, { ms = 4000, cwd } = {}) {
  return new Promise((resolve) => {
    const lines = []; let buf = ''; let done = false;
    const finish = (r) => { if (!done) { done = true; if (buf) lines.push(buf); resolve({ lines, ...r }); } };
    let child;
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], detached: true }); } catch (e) { return finish({ cut: null, error: String(e.message).slice(0, 120) }); }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; const p = buf.split('\n'); buf = p.pop() ?? ''; for (const x of p) if (x) lines.push(x); });
    child.on('error', (e) => finish({ cut: null, error: String(e.message).slice(0, 120) }));
    child.on('close', () => { clearTimeout(t); finish({ cut: null, error: null }); });
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} child.stdout.destroy(); child.unref(); finish({ cut: ms, error: null }); }, ms);
    t.unref();
  });
}
const ageDays = (ms, now) => Math.floor((now - ms) / 86400000);
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
const tilde = (c, p) => p.replace(c.home + '/', '~/');
/** Rows dated after as_of are dropped; a row with no date is kept (counted in coverage). */
/** The literal terms c.rxAny alternates over (query.mjs builds it as their bounded() forms). */
const anyLits = (c) => (c.words.length ? c.words : [c.q]);
const notAfter = (c, line) => !c.asOfMs || !(rowTime(line) > c.asOfMs);

// ---- repository search (knowledge root, or a commit with ASK_REV) ---------------
function excludes(c) {
  if (c._excl) return c._excl;
  let txt = ''; try { txt = readFileSync(join(c.repo, '.rgignore'), 'utf8'); } catch {}
  return (c._excl = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => `:(exclude)${l.replace(/\/$/, '/**')}`));
}
const needRoot = (c) => { if (!c.repo) throw new Error('no knowledgeRoot configured for this corpus'); };
async function grepRepo(c, pattern, paths, extra = []) {
  needRoot(c);
  if (c.rev) return (await shSearch(c, 'git', ['grep', '-I', '-n', '-i', '-E', pattern, c.rev, '--', ...paths, ...excludes(c)], { cwd: c.repo })).split('\n').filter(Boolean).map((l) => l.replace(c.rev + ':', ''));
  return sortGrep((await shSearch(c, c.rg, ['-i', '--no-heading', '-n', ...extra, pattern, ...paths], { cwd: c.repo })).split('\n').filter(Boolean));
}
const readRepo = (c, p) => (c.rev ? sh(c, 'git', ['show', `${c.rev}:${p}`], { cwd: c.repo }).catch(() => '') : readFile(join(c.repo, p), 'utf8').catch(() => ''));
async function lsGraphs(c) {
  if (c.rev) return (await shSearch(c, 'git', ['ls-tree', '-r', '--name-only', c.rev, '--', 'knowledge/memory/graphs/*.md'], { cwd: c.repo })).split('\n').filter(Boolean);
  try { return readdirSync(join(c.repo, 'knowledge/memory/graphs')).filter((f) => f.endsWith('.md')).sort().map((f) => `knowledge/memory/graphs/${f}`); } catch { return []; }
}

/** Files grouped from grep lines, ranked by coverage, spread over directories, quoted twice. */
function fileBlock(c, lines, { maxLen = Infinity } = {}) {
  const { score, snippet, scoreW } = c.m, byFile = new Map();
  for (const line of lines) {
    const p = /^([^:]+):(\d+):(.*)$/.exec(line); if (!p) continue;
    const [, f, n, text] = p;
    if (text.length > maxLen) continue;
    const e = byFile.get(f) || { f, hits: [], s: 0 };
    e.hits.push({ t: `${n}: ${snippet(text.trim(), 220)}`, s: score(text), raw: text });
    e.s = Math.max(e.s, score(text)); byFile.set(f, e);
  }
  const { kw, ranked } = rankFiles([...byFile.values()], c.m, { lines: (e) => e.hits.map((h) => h.raw), weights: c.termIdf });
  for (const e of ranked) for (const h of e.hits) h.s = scoreW(h.raw, kw);
  return spreadDirs(ranked, { window: c.cap }).slice(0, c.cap).map((e, i) => {
    const n = i < c.topFiles ? c.topQuotes : 2;
    const quotes = c.diverse ? diverseQuotes(e.hits, c.m, kw, n) : e.hits.slice().sort((a, b) => b.s - a.s).slice(0, n);
    return `${e.f}\n    ${quotes.map((h) => h.t).join('\n    ')}`;
  });
}

export async function knowledge(c) {
  const lines = await grepRepo(c, c.rxAny, ['knowledge'], ['-m', '40', '--glob', '!knowledge/memory/stream.md', '--glob', '!knowledge/memory/findings.md', '-t', 'md']);
  return fileBlock(c, c.rev ? lines.filter((l) => /\.md:/.test(l) && !/knowledge\/memory\/(stream|findings)\.md:/.test(l)) : lines);
}

const META = /^(id|title|keywords|workspace|type|status|recorded|confidence|superseded_by|refs):/;
// Parsed finding/claim blocks per file version (mtime, size), kept by the long-lived search worker: splitting 6 MB of
// markdown was a fixed cost of every query. At a commit (ASK_REV) they are parsed fresh.
const blockCache = new Map();
async function findingBlocks(c, f) {
  const parse = (text) => {
    const out = [];
    for (const b of text ? text.split(/\n(?=---\nid:|## 01[A-Z0-9]{6,})/) : []) {
      const id = /^---\nid:\s*(\S+)/.exec(b)?.[1] || /^## (01[A-Z0-9]{6,})/.exec(b)?.[1];
      if (id) out.push({ f, id, b, low: b.toLowerCase() });
    }
    return out;
  };
  if (c.rev) return parse(await readRepo(c, f));
  const p = join(c.repo, f);
  let key; try { const st = statSync(p); key = `${st.mtimeMs}|${st.size}`; } catch { return []; }
  const hit = blockCache.get(p);
  if (hit?.key === key) return hit.blocks;
  const blocks = parse(await readRepo(c, f));
  blockCache.set(p, { key, blocks });
  return blocks;
}
/** Findings and typed claims are keyword-tagged blocks: score the block, quote the best line per term. */
export async function findings(c) {
  needRoot(c);
  const { words, RX, rx, score, snippet, idfOver } = c.m, blocks = [];
  for (const f of ['knowledge/memory/findings.md', ...(await lsGraphs(c))]) blocks.push(...await findingBlocks(c, f));
  // A block whose lowercased text lacks an ASCII term cannot match that term's /i regex (bounded() only adds
  // boundaries), so the regex runs only where the substring is: same scores, a fraction of the 0.4 s of regex work.
  const low = words.map((w) => (/^[\x00-\x7f]+$/.test(w) ? w.toLowerCase() : null));
  const may = (x, t) => { const l = low[words.indexOf(t)]; return l == null || x.low.includes(l); };
  const wts = idfOver(blocks.map((x) => x.b), (i, t) => may(blocks[i], t));
  const meanW = words.length ? words.reduce((a, t) => a + wts.get(t), 0) / words.length : 1;
  const scored = [];
  for (const [order, x] of blocks.entries()) {
    if (words.length && !words.some((w) => may(x, w))) continue;   // s stays 0: no term, so neither bonus either
    const head = x.b.slice(0, 700);
    const subject = [/\nindex_name:\s*(.+)/.exec(x.b)?.[1] || '', /\*\*([^*]{2,60})\*\*/.exec(x.b)?.[1] || '', /\ntitle:\s*(.+)/.exec(x.b)?.[1] || '', x.id].join(' ');
    let s = 0;
    for (const w of words) { const re = RX.get(w), wt = wts.get(w); if (re.test(head)) s += 3 * wt; else if (re.test(x.b)) s += wt; }
    if (words.length > 1 && words.every((w) => RX.get(w).test(x.b))) s += 10 * meanW;
    if (words.every((w) => RX.get(w).test(subject))) s += 50 * meanW;
    if (s > 0) scored.push({ ...x, s, order });
  }
  const out = scored.sort((a, b) => b.s - a.s || a.order - b.order).slice(0, c.full ? 12 : 6).map((x) => {
    const title = (/\ntitle:\s*(.+)/.exec(x.b)?.[1] || /^## 01[A-Z0-9]+\s*[—-]\s*(.+)/.exec(x.b)?.[1] || x.id).slice(0, 150);
    const lines = x.b.split('\n').map((l) => l.trim()).filter((l) => l && !META.test(l));
    const chosen = new Map();
    for (const w of words) {
      const re = rx(w), cand = lines.filter((l) => re.test(l)).sort((a, b) => score(b) - score(a));
      if (cand[0]) chosen.set(cand[0], true);
      const lean = cand.slice(1).find((l) => score(l) < score(cand[0]));
      if (lean) chosen.set(lean, true);
    }
    for (const l of lines.sort((a, b) => score(b) - score(a))) { if (chosen.size >= 8) break; if (score(l) > 0) chosen.set(l, true); }
    return `${x.f}  [${x.id}]\n    ${title}\n${[...chosen.keys()].slice(0, 9).map((l) => '      ' + snippet(l)).join('\n')}`;
  });
  return c.graphHops ? out.concat(['[graph] adjacency walk is not available in this runtime; ASK_GRAPH_HOPS ignored']) : out;
}

/** The operating manual answers in paragraphs, not lines. */
export async function manual(c) {
  // no path left means none to read: ripgrep given no path reads its stdin, an open pipe here, until ASK_GREP_MS kills it
  const paths = c.cfg.docsPaths.filter((p) => c.rev || existsSync(join(c.repo, p)));
  if (!paths.length) return [];
  const lines = await grepRepo(c, c.rxAny, paths);
  const hits = c.rank(lines).slice(0, c.cap);
  const files = [...new Set(hits.map((h) => (/^([^:]+):/.exec(h) || [])[1]).filter(Boolean))];
  const texts = new Map(await Promise.all(files.map(async (f) => [f, (await readRepo(c, f)).split('\n')])));
  return paragraphHits(hits, c.m, (f) => texts.get(f) || null).slice(0, c.docCap);
}

export async function claudeMemory(c) {
  const dir = c.cfg.claudeMemoryDir;
  if (!dir || !existsSync(dir)) return [];
  const out = sortGrep((await shSearch(c, c.rg, ['-i', '--no-heading', '-n', c.rxAny, dir])).split('\n').filter(Boolean));
  return c.rank(out).slice(0, c.cap).map((l) => c.m.snippet(tilde(c, l), 260));
}

export async function code(c) {
  needRoot(c);
  const extra = ['-m', '40', ...c.cfg.codeGlobs.flatMap((g) => ['--glob', g])];
  const paths = c.cfg.codePaths.filter((d) => c.rev || existsSync(join(c.repo, d)));
  return paths.length ? fileBlock(c, await grepRepo(c, c.rxAny, paths, extra), { maxLen: 400 }) : [];
}

export async function streamMd(c) {
  return c.rank(await grepRepo(c, c.rxAny, ['knowledge/memory/stream.md'])).slice(0, c.cap).map((l) => c.m.snippet(l, 300));
}

export async function chats(c) {
  const f = c.cfg.chatsIndex, seen = new Set();
  const out = await shSearch(c, c.rg, ['-i', '--no-heading', c.words.length ? c.rxAny : esc(c.q), f]);
  const rows = out.split('\n').filter(Boolean).filter((l) => !c.asOfMs || !(Date.parse(l.slice(0, 10)) > c.asOfMs));
  return c.rank(rows).slice(0, c.cap * 4).filter((l) => { const t = l.split('\t')[2]; if (seen.has(t)) return false; seen.add(t); return true; })
    .slice(0, c.cap).map((l) => { const [day, who, title, uuid, text] = l.split('\t'); return `${day} | ${who === 'A' ? c.owner : 'Claude'} | ${title}  [${uuid}]\n      ${c.m.snippet(text || '', 260)}`; });
}

// ---- messages -------------------------------------------------------------------
const IM_SELECT = `SELECT datetime(m.date/1000000000 + 978307200,'unixepoch','localtime') AS at,
  CASE WHEN m.is_from_me = 1 THEN 'me' ELSE COALESCE(h.id,'unknown') END AS who,
  COALESCE(NULLIF(c.display_name,''), (SELECT group_concat(h2.id, ',') FROM chat_handle_join chj2 JOIN handle h2 ON h2.ROWID = chj2.handle_id WHERE chj2.chat_id = c.ROWID), c.chat_identifier, '') AS chat,
  replace(replace(COALESCE(m.text,''),char(9),' '),char(10),' ') AS text,
  CASE WHEN COALESCE(m.text,'') = '' THEN hex(m.attributedBody) ELSE '' END AS blob
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id`;
export { IM_SELECT };
/** Last ten digits for a phone, lowercase for an address. */
export function normalizeHandle(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.includes('@')) return v;
  const d = v.replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
/** One iMessage TSV row `at, who, chat, text`, or null when no body can be recovered. */
export function imRow({ at, who, chat, text, blob }, names = new Map(), { ownerLabel = 'me' } = {}) {
  const body = text || decodeAttributedBody(blob);
  if (!String(body).trim()) return null;
  const label = (h) => names.get(normalizeHandle(h)) || h;
  const chatLabel = String(chat).includes(',') ? `group: ${String(chat).split(',').map(label).slice(0, 4).join(', ')}` : label(chat);
  return [at, who === 'me' ? ownerLabel : label(who), chatLabel, String(body).replace(/[\t\r\n]+/g, ' ')].join('\t');
}
function handles(c) {
  if (c._names) return c._names;
  try { c._names = new Map(Object.entries(JSON.parse(readFileSync(join(c.cfg.streamsDir, 'handles.json'), 'utf8')))); } catch { c._names = new Map(); }
  return c._names;
}
const labels = (c) => (c._labels ??= privateLabelSet(handles(c), c.registry));
function withheld(c, source, line) {
  if (!withholdRow(source, line, { labels: labels(c), registry: c.registry, sources: c.cfg.communicationSources })) return false;
  c.withheld[source] = (c.withheld[source] || 0) + 1;
  return true;
}

/** Contact names printed once in a legend and referred to by first name; groups shortened member by member. */
function nameShortener() {
  const shortOf = new Map(), claimed = new Map(), legend = [];
  const shorten = (full) => {
    const name = String(full || '');
    if (shortOf.has(name)) return shortOf.get(name);
    const first = name.replace(/\s*\([^)]*\)\s*$/, '').trim().split(/\s+/)[0] || name;
    const short = first.length >= 3 && name.length > first.length + 3 && !/^[+\d]/.test(first) ? first : name;
    const taken = claimed.get(short), use = short === name || !taken || taken === name ? short : name;
    if (use !== name) { claimed.set(use, name); legend.push(`${use} = ${name}`); }
    shortOf.set(name, use); return use;
  };
  const members = (list) => {
    const out = []; let depth = 0, cur = '';
    for (const ch of list) {
      if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  };
  const chat = (s) => { const m = /^group:\s*(.*)$/.exec(String(s || '')); return m ? `group: ${members(m[1]).map(shorten).join(', ')}` : shorten(s); };
  return { shorten, chat, legend };
}

/** History from the index TSV plus the last two days live from chat.db (ending at as_of). */
export async function imessage(c) {
  const idx = join(c.cfg.streamsDir, 'imessage.tsv'), warn = [];
  const chatDb = c.cfg.chatDb;
  let liveError = chatDb && existsSync(chatDb) ? null : 'chat.db not present';
  const live = [];
  if (!liveError && c.words.length && c.liveFrom < c.now) {
    let db;
    try {
      db = new DatabaseSync(chatDb, { readOnly: true });
      const toApple = (ms) => (Math.floor(ms / 1000) - 978307200) * 1e9;
      const rows = db.prepare(`${IM_SELECT} WHERE m.date > ? AND m.date <= ? ORDER BY m.date DESC, m.ROWID DESC`).all(toApple(c.liveFrom), toApple(c.now) + 1e9);
      for (const r of rows) {
        const row = imRow(r, handles(c), { ownerLabel: c.owner });
        if (!row || withheld(c, 'imessage', row)) continue;
        if (c.words.every((w) => row.toLowerCase().includes(w.toLowerCase()))) live.push(row);
        if (live.length >= c.cap) break;
      }
    } catch (e) { liveError = String(e.message).replace(/\s+/g, ' ').slice(0, 110); } finally { try { db?.close(); } catch {} }
  } else if (!liveError && c.liveFrom >= c.now) liveError = 'as_of is older than the live window';
  let histError = '';
  const hist = existsSync(idx) ? await shSearch(c, c.rg, ['-i', '--no-heading', '-m', '600', c.rxAny, idx]).catch((e) => { histError = e.message; return ''; }) : '';
  if (histError) warn.push(`!! imessage history index unreadable (${histError}); last two days only`);
  if (liveError && liveError !== 'as_of is older than the live window') {
    const built = mtime(idx) ? new Date(mtime(idx)).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'unknown';
    warn.push(`!! live chat.db unreadable (${liveError}); history only, nothing since the index build at ${built}`);
  }
  if (!histError && existsSync(idx) && !c.asOfMs) {
    const hours = Math.floor((c.now - mtime(idx)) / 3600000);
    if (hours > 48) warn.push(`!! imessage history index was built ${Math.floor(hours / 24)}d ago and the live read only covers 2 days, so nothing said in between is searchable; ${c.hint}`);
  }
  const names = nameShortener(), seen = new Set();
  const rows = c.rank([...live, ...hist.split('\n')].filter(Boolean).filter((l) => notAfter(c, l) && !withheld(c, 'imessage', l)))
    .filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; }).slice(0, c.cap).map((l) => {
      const p = l.split('\t'), who = names.shorten(p[1]), where = names.chat(p[2]);
      return `${where === who || where === `group: ${who}` ? `${p[0]} | ${who}` : `${p[0]} | ${who} | ${where}`}\n      ${c.m.snippet(p.slice(3).join(' '), 260)}`;
    });
  return warn.concat(names.legend.length ? [`[ask] names: ${names.legend.join('; ')}`] : [], rows);
}

/** Notes about stream freshness, emitted when the block is defined (watermark, else file mtime). */
export function streamNotes(c, sources) {
  let state = {};
  try { state = JSON.parse(readFileSync(join(c.cfg.streamsDir, '.state.json'), 'utf8')); } catch {}
  return sources.map((name) => {
    const file = join(c.cfg.streamsDir, `${name}.tsv`);
    if (!existsSync(file)) return `${name}: historical index unavailable`;
    const stamp = Date.parse(state[name]) || mtime(file);
    return `${name}: historical index checked ${new Date(stamp).toISOString()}; cached, not a live source check`;
  });
}
export async function streams(c, sources) {
  const files = sources.map((n) => join(c.cfg.streamsDir, `${n}.tsv`)).filter((f) => existsSync(f));
  if (!files.length) return [];
  const out = sortGrep((await shSearch(c, c.rg, ['-i', '--no-heading', '-H', '-m', '600', c.rxAny, ...files])).split('\n').filter(Boolean), files);
  const allowed = out.filter((l) => {
    const m = /^([^:]+):(.*)$/.exec(l);
    return !m || (notAfter(c, m[2]) && !withheld(c, basename(m[1], '.tsv'), m[2]));
  });
  return c.rank(allowed).slice(0, c.cap).map((l) => {
    const m = /^([^:]+):(.*)$/.exec(l); if (!m) return c.m.snippet(l, 260);
    const [ts, who, text] = m[2].split('\t');
    return `${basename(m[1], '.tsv')} | ${ts} | ${who}\n      ${c.m.snippet(text || '', 260)}`;
  });
}

// ---- who: people by what they are attached to -----------------------------------
// Parsed once per file version (mtime, size): 5.5 MB of JSON, read twice a query (the stale note and the block).
let peopleCache = null;
export function loadPeople(indexDir) {
  const p = join(indexDir, 'people.json');
  try {
    const st = statSync(p), key = `${p}|${st.mtimeMs}|${st.size}`;
    if (peopleCache?.key !== key) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      peopleCache = { key, value: j.version !== 1 || !Array.isArray(j.people) ? null : { ...j, builtAt: j.builtAt || new Date(st.mtimeMs).toISOString() } };
    }
    return peopleCache.value;
  } catch { return null; }
}
export const FIELD_WEIGHT = { identity: 2.5, docs: 2, subjects: 1.2, snippets: 0.7 };
export function fieldsOf(p) {
  return { identity: [p.name, p.address, p.handle, p.domain].filter(Boolean).join(' ').replace(/[^A-Za-z0-9]+/g, ' '),
    docs: p.docs.join(' ').replace(/[^A-Za-z0-9]+/g, ' '), subjects: p.subjects.join(' ; '), snippets: p.snippets.join(' ; ') };
}
/** Field-weighted term matches, x(1 + 0.5 per extra term), bulk x0.25, recency boost; ties by identity. */
export function rankPeople(people, m, { weights = null, max = 4, now = Date.now() } = {}) {
  const { words, RX } = m;
  if (!words.length) return [];
  const w = (t) => (weights && weights.get(t) > 0 ? weights.get(t) : 1), scored = [];
  for (const person of people) {
    let score = 0; const matched = {}, covered = new Set();
    for (const [field, text] of Object.entries(fieldsOf(person))) {
      if (!text) continue;
      for (const t of words) if (RX.get(t).test(text)) { score += FIELD_WEIGHT[field] * w(t); covered.add(t); (matched[field] ||= []).push(t); }
      for (const [a, b] of m.phrases || []) if (new RegExp(`${a}[\\W_]{0,3}${b}`, 'i').test(text)) score += FIELD_WEIGHT[field] * (w(a) + w(b));
    }
    if (!score) continue;
    score *= 1 + 0.5 * (covered.size - 1);
    if (person.bulkRatio >= 0.5) score *= 0.25;
    const last = Date.parse(person.last || '') || 0;
    if (last) score *= 1 + 0.6 * Math.exp(-Math.max(0, (now - last) / 86400000) / 180);
    scored.push({ person, score, matched, covered: covered.size, key: `${person.address || ''}\0${person.handle || ''}\0${person.name || ''}` });
  }
  return scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, max);
}

export async function who(c) {
  const idx = loadPeople(c.cfg.indexDir);
  if (!idx) return [`[ask] no people index at ${c.cfg.indexDir}/people.json, so no question about a person by description can be answered; ${c.hint} --only people`];
  const ranked = rankPeople(idx.people.filter((p) => !c.registry.identify(p.address || p.handle || p.name)), c.m, { weights: c.termIdf, max: c.whoMax * 4, now: c.now });
  const keep = ranked.filter((r) => r.covered >= Math.min(2, c.words.length)).slice(0, c.whoMax);
  const rows = [];
  for (const { person } of keep) {
    const label = person.address ? `<${person.address}>` : (person.handle || '');
    const name = [person.name === label || person.name === person.handle ? '' : person.name, label].filter(Boolean).join(' ');
    const when = person.last ? `${person.n} message${person.n === 1 ? '' : 's'}, last ${String(person.last).slice(0, 16).replace('T', ' ')}` : '';
    const lines = [];
    if (person.subjects.length) lines.push(`subjects: ${person.subjects.slice(0, 3).join(' ; ')}`);
    const said = person.snippets.filter((t) => /[\p{L}\p{N}]/u.test(t)).slice(0, 2);
    if (said.length) lines.push(`said: ${said.join(' ; ')}`);
    if (person.docs.length) lines.push(`filed: ${rankLines(person.docs, c.m, { full: true }).slice(0, 6).join(' ; ')}${person.docs.length > 3 ? ` (+${person.docs.length - 3} more)` : ''}`);
    const org = person.domain?.replace(/equip$/, '');
    if (org && org.length >= 5) {
      const files = (c.cfg.streams.email || []).map((n) => join(c.cfg.streamsDir, `${n}.tsv`)).filter(existsSync);
      const ev = files.length ? await shSearch(c, c.rg, ['-i', '--with-filename', '-F', org, ...files]).catch(() => '') : '';
      const recent = ev.split('\n').filter(Boolean).filter((l) => { const m = /^(.*?\.tsv):(.*)$/.exec(l); return m && notAfter(c, m[2]) && !withheld(c, basename(m[1], '.tsv'), m[2]); })
        .map((l) => l.replace(/^.*?\.tsv:/, '')).sort().reverse().slice(0, 4);
      for (const row of recent) lines.push(`source evidence (not task status): ${row.slice(0, 1100)}`);
    }
    for (const w of openWork(c, person)) lines.push(`inferred work (verify shared task status): ${w}`);
    const stream = person.streams[0];
    if (person.address && stream) lines.push(`-> rg -F -i -m 4 '${person.address}' '${join(c.cfg.streamsDir, `${stream}.tsv`)}' | cut -c1-3000`);
    else if (person.handle && stream) lines.push(`-> rg -F -m 6 '${person.handle}' '${join(c.cfg.streamsDir, `${stream}.tsv`)}' | cut -c1-600`);
    rows.push([`${name}  [${person.streams.join(',') || person.kind}]  ${when}`, ...lines].join('\n      '));
  }
  return rows;
}
/** Read-only inferred work naming the person; evidence, never the shared task store. */
function openWork(c, person) {
  const file = c.cfg.workDb;
  const keys = [person.name, person.domain].filter((k) => k && String(k).length >= 4).map((k) => `%${String(k).toLowerCase()}%`);
  if (!file || !existsSync(file) || !keys.length) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const where = keys.map(() => '(lower(title) LIKE ? OR lower(body) LIKE ?)').join(' OR ');
    return db.prepare(`SELECT status || ': ' || substr(title,1,110) AS t FROM work WHERE status='todo' AND (${where}) ORDER BY rowid LIMIT 3`).all(...keys.flatMap((k) => [k, k])).map((r) => r.t);
  } catch { return []; } finally { try { db?.close(); } catch {} }
}

// ---- filenames ---------------------------------------------------------------------
export function scorePath(path, words) {
  const base = basename(path).toLowerCase(), full = path.toLowerCase();
  let score = 0, covered = 0;
  for (const w of words) {
    const t = String(w).toLowerCase();
    if (!t || !full.includes(t)) continue;
    covered++; score += base.includes(t) ? 3 : 1;
    if (new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`).test(base)) score += 2;
  }
  if (!covered) return 0;
  return covered === words.length && words.length > 1 ? score + 4 * words.length : score;
}
export function searchRows(rows, words, { limit = 20, now = Date.now() } = {}) {
  const out = [];
  for (const row of rows) {
    const tab = row.indexOf('\t'), path = tab === -1 ? row : row.slice(0, tab), parts = tab === -1 ? [] : row.slice(tab + 1).split('\t');
    const s = scorePath(path, words); if (!s) continue;
    const mt = Number(parts[0] || 0) * 1000;
    out.push({ path, mtime: mt, size: Number(parts[1] || 0), score: s + 1.5 * Math.exp(-Math.max(0, (now - mt) / 86400000) / 365) });
  }
  return out.sort((a, b) => b.score - a.score || b.mtime - a.mtime || (a.path < b.path ? -1 : 1)).slice(0, limit);
}
async function eachLine(file, fn) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line && fn(line) === false) { rl.close(); break; }
}
const ASCII_TERM = /^[\x20-\x7e]+$/;
/** eachLine over only the lines holding one of `literals` (case-insensitive), found by ripgrep in its own process, or
 * false when that cannot be proved the same (no rg, a non-ASCII or empty literal) and the caller should scan. Why: the
 * document index is 509 MB and the filename index 15 MB; read through readline on the search worker's thread they cost
 * 1.2 s per tier (documents runs four), 3 to 6 s a query, and blocked every other corpus on that thread. ripgrep finds
 * the same candidate lines in about 60 ms. Same lines: every caller's own test (a JS regex with /i, or
 * toLowerCase().includes) can only pass on a line containing one of its literal terms, and for ASCII literals ripgrep's
 * -i folding is a superset of JS's; each line is split the way readline splits (\n, \r\n, lone \r) and handed over in
 * file order, empty pieces skipped, so the callback sees exactly the lines eachLine would have given it that can match.
 * -a: a NUL byte must not make ripgrep stop at "binary file matches".
 */
export function eachMatchingLine(rg, file, literals, fn) {
  const lits = [...new Set((literals || []).map(String))];
  if (!rg || !lits.length || !lits.every((l) => ASCII_TERM.test(l))) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child, stopped = false, failed = false;
    const take = (raw) => {
      for (const piece of raw.split(/\r\n|\r|\n/)) {
        if (stopped || !piece) continue;
        if (fn(piece) === false) { stopped = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }
    };
    try { child = spawn(rg, ['-a', '-i', '-F', '--no-heading', '--no-filename', '--no-line-number', '--color', 'never', ...lits.flatMap((l) => ['-e', l]), '--', file], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve(false); }
    child.stdout.setEncoding('utf8');
    // a document row can be megabytes: look for the newline in the new chunk only, so a long row is not rescanned
    // (and its rope flattened) once per 64 KB chunk
    let parts = [];
    child.stdout.on('data', (d) => {
      if (stopped) return;
      const nl = d.lastIndexOf('\n');
      if (nl < 0) { parts.push(d); return; }
      parts.push(d.slice(0, nl));
      const ready = parts.join(''); parts = [d.slice(nl + 1)];
      for (const line of ready.split('\n')) { if (stopped) break; take(line); }
    });
    child.on('error', () => { failed = true; });
    child.on('close', (code) => {
      if (failed || (!stopped && code !== 0 && code !== 1)) return resolve(false);
      if (!stopped) { const tail = parts.join(''); if (tail) take(tail); }
      resolve(true);
    });
  });
}
export async function filenames(c) {
  const p = join(c.cfg.indexDir, 'files.tsv');
  if (!existsSync(p)) return [`[ask] no filename index at ${p}; ${c.hint} --only files`];
  if (!c.words.length) return [];
  // scorePath keeps only a row whose lowercased path holds a term, so ripgrep's literal prefilter drops nothing it keeps
  let rows = [];
  if (!(await eachMatchingLine(c.rg, p, c.words, (l) => { rows.push(l); }))) { rows = []; await eachLine(p, (l) => { rows.push(l); }); }
  return searchRows(rows, c.words, { limit: c.full ? 24 : 8, now: c.now }).map((h) => `${tilde(c, h.path)}  (${new Date(h.mtime).toISOString().slice(0, 10)}, ${Math.round(h.size / 1024)}KB)`);
}

export async function journal(c) {
  const out = (await shSearch(c, c.rg, ['-i', '--no-heading', '-m', '600', c.rxAny, c.cfg.journalIndex])).split('\n').filter(Boolean).filter((l) => notAfter(c, l));
  return c.rank(out).slice(0, c.cap).map((l) => {
    const [iso, time, source, file, heading, text] = l.split('\t');
    if (text === undefined) return c.m.snippet(l, 260);
    return `${source} | ${time ? `${iso.slice(0, 10)} ${time}` : iso.slice(0, 10)} | ${basename(file || '')}${heading ? ` — ${heading}` : ''}\n      ${c.m.snippet(String(text).replace(/\\n/g, ' ').replace(/\\t/g, ' '), 260)}`;
  });
}

// ---- headspaces: findable, never quotable ------------------------------------------
export function parseHeadspaces(text) {
  const lines = String(text).split('\n'); let meta = {}, start = 0;
  if (lines[0]?.startsWith('#')) { try { meta = JSON.parse(lines[0].slice(1)); } catch {} start = 1; }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i], a = l.indexOf('\t'), b = l.indexOf('\t', a + 1);
    if (a > 0 && b > 0) rows.push({ iso: l.slice(0, a), words: Number(l.slice(a + 1, b)) || 0, body: l.slice(b + 1) });
  }
  return { meta, rows };
}
/** The publication boundary: a date, a size, a match count and the command that opens it. Never body text. */
export async function headspaces(c) {
  let text; try { text = await readFile(c.cfg.headspacesIndex, 'utf8'); } catch { return [`[ask] headspaces index missing; ${c.hint} --only headspaces`]; }
  const { meta, rows } = parseHeadspaces(text);
  const at = Date.parse(meta?.built || '') || mtime(c.cfg.headspacesIndex);
  if (at && ageDays(at, c.now) >= 3) c.lateNotes.push(`headspaces index is ${ageDays(at, c.now)}d old; ${c.hint} --only headspaces`);
  const started = Date.now(), hits = []; let scanned = 0, cut = false;
  for (const row of rows) {
    if (scanned % 64 === 0 && Date.now() - started >= c.hsMs) { cut = true; break; }
    scanned++;
    if (c.asOfMs && Date.parse(row.iso) > c.asOfMs) continue;
    const n = c.m.score(row.body);
    if (n > 0) hits.push({ iso: row.iso, words: row.words, terms: n });
  }
  hits.sort((a, b) => b.terms - a.terms || b.iso.localeCompare(a.iso) || b.words - a.words);
  const out = cut ? [`[ask] headspaces CUT after ${scanned} of ${rows.length} entries at ${c.hsMs}ms; raise ASK_HEADSPACES_MS`] : [];
  return out.concat(hits.slice(0, c.cap).map((h) => `Headspaces | ${h.iso} | ${h.words} words | ${h.terms} term${h.terms === 1 ? '' : 's'} matched\n      read it with: ${c.cfg.headspaces.readCommand} ${h.iso.slice(0, 10)}`));
}

// ---- documents: contracts walk, the local text index, Spotlight ----------------------
export const DOC_EXT = /\.(pdf|docx?|pages|key|numbers|xlsx?|pptx?|csv|rtf|txt|md|eml)$/i;
export const NL = '␟';
export function spotSkipFor(home, extra = []) {
  return [join(home, 'Library/Caches'), join(home, 'Library/Application Support'), join(home, 'Library/Containers'), join(home, 'Library/Group Containers'),
    join(home, 'Library/Metadata'), join(home, 'Library/Mail'), join(home, '.claude'), join(home, '.codex'), '/Volumes/', '/private/',
    join(home, 'projects'), '/node_modules/', '/.git/', ...extra];
}
export const isDataless = (p) => { try { const s = statSync(p); return s.size > 0 && s.blocks === 0; } catch { return false; } };
/** Rows of docs.tsv (`path, mtime, size, text`) matching `rxAny`, in file order, capped. */
export async function searchDocs(rxAny, { tsv, cap = 400, literals = null, rg = null } = {}) {
  if (!tsv || !existsSync(tsv)) return { hits: [], cut: false };
  const re = new RegExp(rxAny, 'i');
  let hits = [], cut = false;
  const visit = (line) => {
    if (!re.test(line)) return true;
    if (hits.length >= cap) { cut = true; return false; }
    const i1 = line.indexOf('\t'), i3 = line.indexOf('\t', line.indexOf('\t', i1 + 1) + 1), text = line.slice(i3 + 1);
    if (secretExportName(line.slice(0, i1))) return true;   // a password export never answers (secret-file.mjs)
    hits.push({ path: line.slice(0, i1), text, inText: re.test(text) });
    return true;
  };
  // `literals`: the terms rxAny was built from (bounded() of each), so any line it matches holds one of them. One
  // ripgrep per pattern, not one over the union of a query's tiers: a sparse tier beside a dense one would make the
  // union read every candidate line to the end (measured 0.4 to 1.3 s against 50 to 110 ms per tier).
  if (literals && rg && await eachMatchingLine(rg, tsv, literals, visit)) return { hits, cut };
  hits = []; cut = false;   // ripgrep could not answer (or failed part way): the full scan, from the start
  await eachLine(tsv, visit);
  return { hits, cut };
}

export async function contracts(c) {
  const root = c.cfg.contractsRoot;
  const walk = await boundedLines('find', [root, '-type', 'f', '-not', '-path', '*/.git/*'], { ms: c.contractsMs });
  const re = new RegExp(c.rxAny, 'i');
  let names = walk.lines.filter((p) => re.test(p)).sort();
  const warn = [];
  if (walk.cut || walk.error) {
    const recovered = (await searchDocs(c.rxAny, { tsv: c.cfg.docsIndex, literals: anyLits(c), rg: c.rg }).catch(() => ({ hits: [] }))).hits.map((h) => h.path).filter((p) => p.startsWith(root + '/'));
    const had = names.length; names = [...new Set([...names, ...recovered])].sort();
    const added = names.length - had;
    warn.push(walk.error ? `[ask] contracts walk failed (${walk.error}); ${added} name(s) recovered from the local document index`
      : `[ask] contracts walk CUT at ${walk.cut}ms after ${walk.lines.length} names, so this list is partial: the iCloud tree was cold and \`find\` blocks per file on the provider. ${added} name(s) came from the local document index, which holds documents only; raise ASK_CONTRACTS_MS or rerun now the walk has warmed it`);
  }
  const chosen = rankedWithTotal(names, c.m, c.cap, { full: c.full, adjust: c.adjust });
  if (chosen.cut) warn.push(`[ask] contracts: showing ${chosen.shown} of ${chosen.ranked} ranked matches from ${chosen.matched} filename(s) the query hit; raise ASK_FULL=1 for more`);
  return chosen.lines.map((p) => p.replace(root + '/', '')).concat(warn);
}

const budgeted = (p, ms) => Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(null), ms); t.unref?.(); })]);
async function docLine(c, p) {
  const ext = (p.split('.').pop() || '').toLowerCase(), opts = { timeout: 1500, maxBuffer: 8 << 20 };
  try { if (statSync(p).size > 12 << 20) return ''; } catch { return ''; }
  let text = '';
  try {
    if (ext === 'pdf') text = await sh(c, 'pdftotext', ['-q', '-l', '12', p, '-'], opts);
    else if (['docx', 'doc', 'rtf', 'pages'].includes(ext)) text = await sh(c, 'textutil', ['-convert', 'txt', '-stdout', p], opts);
    else if (['txt', 'md', 'csv', 'eml'].includes(ext)) text = (await readFile(p, 'utf8')).slice(0, 400000);
  } catch { return ''; }
  return bestDocLines(text, c.m, { money: c.money });
}
async function spotlight(c) {
  if (c.noSpotlight) return { paths: [], off: true };
  const skip = spotSkipFor(c.home, [...c.cfg.spotlightSkip, ...(c.repo ? [c.repo] : [])]);
  const filter = (out) => out.split('\n').filter(Boolean).filter((p) => DOC_EXT.test(p) && !secretExportName(p) && !skip.some((s) => p.startsWith(s) || p.includes(s))).sort();
  const partial = [];
  const work = (async () => {
    const tiers = spotlightTiers({ words: c.words, bySpec: c.bySpec, wholePhrase: c.picked.terms.length === c.rawWords });
    const [runs, health] = await Promise.all([
      Promise.all(tiers.map((t) => budgeted(sh(c, 'mdfind', [t], { timeout: 6000 }).catch(() => '').then(filter), c.tierMs))),
      budgeted(sh(c, 'mdfind', ['-onlyin', c.home, '-count', "kMDItemContentType == 'public.folder'"], { timeout: 3000 }).then((o) => Number(o.trim())).catch(() => NaN), c.tierMs)
        .then((n) => (!Number.isFinite(n) ? 'unknown' : n > 0 ? 'alive' : 'dead')),
    ]);
    const { broad, paths } = winningTier(tiers, runs.map((r) => r || []));
    partial.push(...paths.slice(0, 4));
    return { paths, broad, tiersCut: runs.filter((r) => r === null).length, tiersRun: tiers.length, health };
  })();
  return (await budgeted(work, c.spotMs)) || { paths: partial, cut: c.spotMs };
}
// When nothing matched, harvest the names that travel with the rarest term in
// the curated corpora and search for those (the owner's own method).
const REPO_WORDS = new Set('tophat knowledge memory findings stream graphs claims refs claude codex node src tools https http gmail com www file from with that this entry index msg mail users projects library documents icloud mobile retrieval keywords workspace status type'.split(' '));
async function widen(c) {
  if (!c.repo) return { paths: [], note: null };
  const src = ['knowledge/memory/indexes', 'knowledge/memory/graphs', 'knowledge/memory/findings.md'].map((p) => join(c.repo, p)).filter((f) => existsSync(f));
  if (!src.length) return { paths: [], note: null };
  const out = await sh(c, c.rg, ['-i', '--no-heading', '-o', '-m', '40', '--max-columns', '400', `.{0,60}${bounded(c.bySpec[0] || c.q)}.{0,60}`, ...src], { timeout: 1500 }).catch(() => '');
  const freq = new Map();
  for (const { term: w } of tokenize(sortGrep(out.split('\n')).join('\n').replace(/\S*\/\S*/g, ' '))) {
    if (w.length < 4 || w.length > 20 || /[\p{N}]/u.test(w) || c.words.some((t) => t.toLowerCase() === w) || STOP.has(w) || REPO_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const cands = [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([w]) => w);
  if (!cands.length) return { paths: [], note: null };
  const local = (await searchDocs(cands.map(bounded).join('|'), { tsv: c.cfg.docsIndex, literals: cands, rg: c.rg }).catch(() => ({ hits: [] }))).hits.filter((h) => h.inText).map((h) => h.path);
  const skip = spotSkipFor(c.home, c.cfg.spotlightSkip);
  const more = c.noSpotlight ? [] : await Promise.all(cands.map((w) => sh(c, 'mdfind', [w], { timeout: 4000 }).catch(() => '')
    .then((o) => o.split('\n').filter((p) => p && DOC_EXT.test(p) && !secretExportName(p) && !skip.some((s) => p.startsWith(s) || p.includes(s))).sort())));
  const paths = [...new Set([...local, ...more.flat()])];
  return { paths, note: paths.length ? `[ask] nothing matched ${JSON.stringify(c.words.join(' '))} inside a document; widened to ${JSON.stringify(cands.join(', '))}, which travel with those terms in his messages` : null };
}
const LIFECYCLE = /^(.*)\/(superseded drafts|working|in progress|drafts)\//;
function operative(paths) {
  const out = [];
  for (const p of paths) {
    const m = LIFECYCLE.exec(p); if (!m) continue;
    try { for (const f of readdirSync(join(m[1], 'signed')).sort()) if (DOC_EXT.test(f)) out.push(join(m[1], 'signed', f)); } catch {}
  }
  return out;
}

export async function documents(c) {
  const lits = new Map([[c.rxAny, anyLits(c)]]);
  for (const w of c.bySpec.slice(0, 3)) if (!lits.has(bounded(w))) lits.set(bounded(w), [w]);
  const tiers = [...lits.keys()];
  const [sets, spot] = await Promise.all([Promise.all(tiers.map((t) => searchDocs(t, { tsv: c.cfg.docsIndex, literals: lits.get(t), rg: c.rg }).catch(() => ({ hits: [], cut: false })))), spotlight(c)]);
  const merged = new Map();
  for (const h of sets.flatMap((s) => s.hits)) { const prior = merged.get(h.path); merged.set(h.path, { ...h, inText: Boolean(h.inText || prior?.inText) }); }
  const localHits = [...merged.values()], cutTiers = tiers.filter((_, i) => sets[i].cut);
  const withText = specificTier(localHits.filter((h) => h.inText && h.text), c.bySpec, c.m.rx);
  const indexed = new Map([...localHits.map((h) => [h.path, { ...h, text: '' }]), ...withText.map((h) => [h.path, h])]);
  const origin = new Map(), note = (src) => (p) => { if (!origin.has(p)) origin.set(p, src); };
  withText.map((h) => h.path).forEach(note('index'));
  operative(withText.map((h) => h.path)).forEach(note('filed'));
  localHits.filter((h) => !h.inText).map((h) => h.path).forEach(note('index'));
  (spot.paths || []).forEach(note('spotlight'));
  let candidates = [...origin.keys()];
  const widened = [];
  if (!candidates.length) { const w = await widen(c); candidates = w.paths; w.paths.forEach(note('widened')); if (w.note) widened.push(w.note); }
  const filed = c.cfg.filedRoots;
  const rankPath = (p) => c.words.filter((w) => c.m.rx(w).test(basename(p))).length * 4 + (filed.some((r) => p.startsWith(r)) ? 3 : 0) + (/\/signed\//.test(p) ? 2 : 0) - (/superseded|\/working\//.test(p) ? 1 : 0);
  const scored = [], needRead = [];
  for (const p of candidates) {
    const hit = indexed.get(p);
    if (hit && hit.text) scored.push({ p, l: bestDocLines(hit.text.split(NL).join('\n'), c.m, { money: c.money }), src: 'index' });
    else needRead.push(p);
  }
  const pool = needRead.sort((a, b) => rankPath(b) - rankPath(a) || (a < b ? -1 : 1)).slice(0, spot.broad ? 10 : (c.full ? 12 : 6));
  const read = await Promise.all(pool.map(async (p) => ({ p, l: await docLine(c, p), src: origin.get(p) || 'spotlight' })));
  const all = [...scored, ...read], dw = c.m.idfOver(all.map((x) => x.l)), ds = (x) => docScore(c.m, dw, basename(x.p), x.l);
  const shown = all.sort((a, b) => ds(b) - ds(a) || rankPath(b.p) - rankPath(a.p) || (a.p < b.p ? -1 : 1)).slice(0, c.full ? 12 : 6);
  const out = shown.map(({ p, l }) => `${tilde(c, p)}${l ? '' : isDataless(p) ? '  [dataless: name and size are local, bytes are still in iCloud; brctl download it]' : '  [no text extracted]'}${l ? '\n      ' + l : ''}`);
  const said = spot.off ? null : spotlightNote({ health: spot.health || 'unknown', cut: spot.cut, paths: spot.paths?.length || 0, tiersCut: spot.tiersCut, tiersRun: spot.tiersRun, tierMs: c.tierMs, localAnswered: withText.length > 0 });
  if (said) out.push(said);
  if (cutTiers.length) out.push(`[ask] the local document index cut ${cutTiers.length} of its ${cutTiers.length === 1 ? 'tier' : 'tiers'} at its row cap, so this list is partial; narrow the terms`);
  if (shown.length) {
    const by = (s) => shown.filter((x) => x.src === s).length;
    out.push(`[ask] ${by('index')} from the local document index, ${by('spotlight')} from spotlight${by('filed') ? `, ${by('filed')} as the signed copy of a matched draft` : ''}${by('widened') ? `, ${by('widened')} from the widened search` : ''}`);
  }
  return out.concat(widened);
}

// ---- web: a prefetched answer waiting on disk, never fetched here ------------------
const normQ = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function matchAnswer(terms, { dir, maxAgeMs = 3600000, now = Date.now() } = {}) {
  const want = new Set(terms.filter(Boolean));
  if (!want.size) return null;
  let names = []; try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return null; }
  let best = null;
  for (const name of names.slice(0, 40)) {
    let rec; try { rec = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    const age = now - (rec.cachedAt || 0); if (age > maxAgeMs) continue;
    const have = new Set(normQ(rec.query).split(' ').filter(Boolean));
    let shared = 0; for (const w of want) if (have.has(w)) shared++;
    const ratio = shared / Math.min(want.size, have.size || 1);
    if (ratio >= 0.5 && (!best || ratio > best.ratio || (ratio === best.ratio && age < best.ageMs))) best = { ...rec, ageMs: age, ratio };
  }
  return best;
}
export async function web(c) {
  const hit = matchAnswer(c.words, { dir: c.cfg.webCacheDir, maxAgeMs: Number(c.env.TOPHAT_WEB_CACHE_TTL_MS || 3600000), now: c.now });
  if (!hit) return [];
  if (hit.error) return [`[web] the background search for ${JSON.stringify(hit.query)} failed: ${hit.error}`];
  if (!hit.answer) return [`[web] the background search for ${JSON.stringify(hit.query)} found nothing; rerun the slow web search`];
  return [`${hit.answer}`, `    asked: ${hit.query}  (${Math.round(hit.ageMs / 1000)}s ago, ${hit.agree} independent site${hit.agree === 1 ? '' : 's'}, confidence ${hit.confidence})`,
    ...(hit.conflicts?.length ? [`    conflicts: ${hit.conflicts.join('; ')}`] : []), ...(hit.sources || []).slice(0, 3).map((u) => `    ${u}`),
    hit.verify === 'optional' ? '    -> corroborated; open a source above before quoting a figure' : `    -> NOT corroborated (${hit.verify}); verify with a slow web search for ${JSON.stringify(hit.query)}`];
}
