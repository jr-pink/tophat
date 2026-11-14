// The UI check of `tophat update`: does the staged release's webchat still render, compared with the release running now?
//
// Both trees boot a scratch server (an empty state dir, a spare loopback port, sign-in off, a model URL that answers nothing), so the
// owner's data is never read and the two render the same empty app. Every main route must answer 200 with the SvelteKit app shell and
// every /_app/ asset it names must load (a half-copied build is the commonest broken UI). With Chrome present (the same headless
// Chrome the demo tests use, or TOPHAT_UPDATE_CHROME), each route is also loaded over CDP in both: a blank page, an uncaught error or
// console error the current release does not have, or a screenshot whose pixels differ from the current release's by more than
// DIFF_FLAG is a problem. The pixel diff only flags: an intended redesign upstream also differs, which the fixer judges (--accept-ui).
// Limits: empty state only (no chats, documents or notes are seeded), signed-out flows are not exercised, one 1280x800 viewport.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { componentDir, pointedBuild } from './start.mjs';

export const ROUTES = ['/', '/reader', '/notes'];
export const DIFF_FLAG = 0.25; // share of pixels; two renders of one release differ by well under 1% (caret, clock), a broken layout by most of the screen
const CHROMES = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer().on('error', rej).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function until(fn, ms, what) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250); } }

export const findChrome = (env = process.env) => [env.TOPHAT_UPDATE_CHROME, ...CHROMES].find((p) => p && existsSync(p)) ?? null;

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG (what Chrome's captureScreenshot writes): { width, height, bpp, data }. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, depth = 0, type = 0, lace = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; lace = data[12]; }
    else if (kind === 'IDAT') idat.push(data); else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || lace || ![2, 6].includes(type)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${lace})`);
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1), row = y * stride, up = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[up + x] : 0, c = y && x >= bpp ? px[up + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { width: w, height: h, bpp, data: px };
}

/** Share of pixels that differ visibly (any channel by more than 24); 1 when the sizes differ. */
export function pixelDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0;
  for (let i = 0, j = 0; i < a.data.length; i += a.bpp, j += b.bpp) if (Math.abs(a.data[i] - b.data[j]) > 24 || Math.abs(a.data[i + 1] - b.data[j + 1]) > 24 || Math.abs(a.data[i + 2] - b.data[j + 2]) > 24) n++;
  return n / (a.width * a.height);
}

/** Share of (sampled) pixels in the commonest colour: near 1 is a blank screen. */
export function flatness(img) {
  const counts = new Map(); let total = 0, top = 0;
  for (let i = 0; i < img.data.length; i += img.bpp * 7) { const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]; const v = (counts.get(k) || 0) + 1; counts.set(k, v); if (v > top) top = v; total++; }
  return total ? top / total : 1;
}

/** Boot one scratch webchat from `tree` serving `build`: { base, stop, log }. */
export async function bootScratch({ tree, build, c, dir, name }) {
  const port = await freePort(), cfg = path.join(dir, name), state = path.join(cfg, 'state');
  mkdirSync(path.join(cfg, 'secrets'), { recursive: true });
  writeFileSync(path.join(cfg, 'secrets', 'model-key'), 'scratch');
  const file = path.join(cfg, 'instance.json');
  // Only keys every tophat release knows, so the current release's own instance.mjs accepts the file too.
  writeFileSync(file, JSON.stringify({ name: c.name, owner: { label: c.owner.label }, components: c.components, ports: { webchat: port },
    paths: { state, config: cfg, workspace: path.join(cfg, 'workspace'), secrets: path.join(cfg, 'secrets') }, webchat: { build },
    models: { chat: { model: c.models.chat?.model || 'scratch', baseUrl: 'http://127.0.0.1:9', credential: { file: path.join(cfg, 'secrets', 'model-key') } } },
    runner: { env: { WEBCHAT_AUTH_DISABLED: '1', TOPHAT_RUNNER_AGENTS: '0' } } }, null, 1));
  const log = path.join(dir, `${name}.log`), fd = openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(tree, 'packages/deploy/bin/tophat-deploy.mjs'), 'start', '--config', file],
    { cwd: tree, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', fd, fd] });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { try { child.kill('SIGTERM'); } catch { /* gone */ } await sleep(500); try { child.kill('SIGKILL'); } catch { /* gone */ } };
  try { await until(async () => (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).ok, 90_000, `${name} /api/health`); }
  catch (e) { await stop(); throw new Error(`${e.message}; log ${log}:\n${readFileSync(log, 'utf8').slice(-1500)}`); }
  return { base, stop, log };
}

/** A route over plain HTTP: 200, the app shell, and every /_app/ asset it names loads. */
async function httpRoute(base, route) {
  const r = await fetch(base + route, { signal: AbortSignal.timeout(15_000) });
  const html = await r.text();
  // Asset references are relative to the page (`./_app/...`, `../_app/...`) or absolute: resolve each against the route.
  const assets = [...new Set([...html.matchAll(/["'(]((?:\.\.?\/)*\/?_app\/[^"')\s]+)/g)].map((m) => new URL(m[1], base + route).pathname))];
  const missing = [];
  for (const a of assets) { const x = await fetch(base + a, { signal: AbortSignal.timeout(15_000) }).catch(() => null); if (!x?.ok) missing.push(a); }
  return { status: r.status, shell: /_app\//.test(html), assets: assets.length, missing };
}

/** One CDP connection to a headless Chrome. */
async function chromeSession(chrome, dir) {
  const port = await freePort();
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'chrome-profile')}`, '--no-first-run', '--hide-scrollbars', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  const url = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl, 20_000, 'chrome');
  const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const pending = new Map(), listeners = new Set();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else for (const l of listeners) l(m); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  /** Load one URL in a fresh context: { errors, text, nodes, png }. */
  async function shot(url) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => send(m, p, sessionId), errors = [];
    let loaded = false;
    const l = (m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.loadEventFired') loaded = true;
      if (m.method === 'Runtime.exceptionThrown') errors.push(`uncaught: ${m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text}`.split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.split('\n')[0]);
    };
    listeners.add(l);
    try {
      await S('Page.enable'); await S('Runtime.enable');
      await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await S('Page.navigate', { url });
      await until(() => loaded, 20_000, `load of ${url}`).catch(() => errors.push('page load event never fired'));
      await sleep(2500); // the app hydrates and paints after load
      const { result } = await S('Runtime.evaluate', { expression: '({ text: (document.body?.innerText || "").trim().length, nodes: document.querySelectorAll("body *").length })', returnByValue: true });
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      return { errors, ...result.value, png: Buffer.from(data, 'base64') };
    } finally { listeners.delete(l); await send('Target.closeTarget', { targetId }).catch(() => {}); await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
  }
  return { shot, close: () => { try { ws.close(); } catch { /* gone */ } try { proc.kill('SIGKILL'); } catch { /* gone */ } } };
}

// Errors compared across releases without their hashed file names, line numbers and ids.
const norm = (e) => e.replace(/_app\/immutable\/[^\s'")]+/g, 'ASSET').replace(/\d+/g, 'N');

/**
 * The check. { c, staging (the staged tree, its webchat built into packages/webchat/build), root (the live tree), dir (for logs and screenshots) }.
 * Returns { ok, mode: 'screenshots' | 'http', routes, problems, shots, log }.
 */
export async function uiCheck({ c, staging, root, dir, routes = ROUTES, chrome = findChrome() }) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const problems = [], rows = [], servers = [];
  const liveWebchat = componentDir('webchat', { root });
  const liveBuild = liveWebchat && (pointedBuild(liveWebchat) ?? (existsSync(path.join(liveWebchat, 'build', 'handler.js')) ? path.join(liveWebchat, 'build') : null));
  let browser = null;
  try {
    const next = await bootScratch({ tree: staging, build: path.join(staging, 'packages/webchat/build'), c, dir, name: 'staging' });
    servers.push(next);
    const cur = liveBuild ? await bootScratch({ tree: root, build: liveBuild, c, dir, name: 'current' }).catch((e) => { problems.push(`note: the current release did not boot for comparison (${e.message.split('\n')[0]})`); return null; }) : null;
    if (cur) servers.push(cur);
    if (chrome) browser = await chromeSession(chrome, dir).catch(() => null);
    for (const route of routes) {
      const row = { route, staging: await httpRoute(next.base, route) };
      if (row.staging.status !== 200) problems.push(`${route} answers ${row.staging.status}`);
      else if (!row.staging.shell) problems.push(`${route} is not the app shell (no /_app/ assets in the page)`);
      if (row.staging.missing.length) problems.push(`${route} names assets that do not load: ${row.staging.missing.slice(0, 5).join(', ')}`);
      if (browser) {
        const slug = route === '/' ? 'home' : route.replace(/\W+/g, '-').replace(/^-|-$/g, '');
        const s = await browser.shot(next.base + route), b = cur ? await browser.shot(cur.base + route) : null;
        writeFileSync(path.join(dir, `${slug}.staging.png`), s.png); if (b) writeFileSync(path.join(dir, `${slug}.current.png`), b.png);
        const img = decodePng(s.png), base = b && decodePng(b.png);
        row.shot = { errors: s.errors, text: s.text, nodes: s.nodes, flat: Number(flatness(img).toFixed(4)) };
        const blank = (x, im) => (x.text === 0 && x.nodes < 15) || flatness(im) > 0.995;
        if (blank(s, img) && !(b && blank(b, base))) problems.push(`${route} renders blank`);
        const known = new Set((b?.errors || []).map(norm));
        const fresh = s.errors.filter((e) => !known.has(norm(e)));
        if (fresh.length) problems.push(`${route} has errors the current release does not: ${fresh.slice(0, 3).join(' | ')}`);
        if (base) { row.diff = Number(pixelDiff(img, base).toFixed(4)); if (row.diff > DIFF_FLAG) problems.push(`looks different: ${route} differs from the current release in ${Math.round(row.diff * 100)}% of pixels (${slug}.staging.png beside ${slug}.current.png)`); }
      }
      rows.push(row);
    }
  } catch (e) { problems.push(`the staged webchat did not serve: ${e.message}`); }
  finally { browser?.close(); for (const s of servers) await s.stop(); }
  const real = problems.filter((p) => !p.startsWith('note:'));
  return { ok: !real.length, mode: browser ? 'screenshots' : 'http', chrome: chrome ?? null, routes: rows, problems: real, notes: problems.filter((p) => p.startsWith('note:')), shots: browser ? dir : null, log: path.join(dir, 'staging.log') };
}
