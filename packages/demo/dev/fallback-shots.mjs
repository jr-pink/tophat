#!/usr/bin/env node
// Looks at the server-down page the way a visitor meets it: 1440 and 390 px wide, light and dark, the boxes collapsed, one box expanded
// (its proof frame loaded), and the memory charts. Reports horizontal overflow and console errors per shot.
//   node packages/demo/dev/fallback-shots.mjs --url https://tophat.md/__dead/x --out DIR [--box runner]
// Needs Google Chrome (headless, its own profile, closed at the end); no other dependency.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const url = args.url || (console.error('--url URL'), process.exit(2));
const out = args.out || (console.error('--out DIR'), process.exit(2));
const expand = String(args.box || 'runner,mac').split(',');
mkdirSync(out, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(path.join(os.tmpdir(), 'fallback-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
// never leak the browser: kill it on every exit path (throw, process.exit, SIGTERM from `timeout`, Ctrl-C)
const reapChrome = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
process.once('exit', reapChrome);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { reapChrome(); process.kill(process.pid, sig); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); ws = new WebSocket(t.webSocketDebuggerUrl); } catch { await sleep(250); } }
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const wait = new Map(); const logs = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '')); else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text + ' ' + (m.params.entry.url || '')); });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('shot', name + '.png');
};
const rectOf = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+scrollX),y:Math.round(r.y+scrollY),width:Math.round(r.width),height:Math.round(r.height)}})()`);
const pad = (r, p = 12) => ({ x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p });

for (const [wname, width, height] of [['desk', 1440, 900], ['mob', 390, 844]]) {
  for (const scheme of ['light', 'dark']) {
    const tag = `${wname}-${scheme}`;
    if (args.only && !String(args.only).split(',').includes(tag)) continue;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: wname === 'mob' ? 2 : 1, mobile: wname === 'mob' });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await send('Page.navigate', { url }); await sleep(2500);
    logs.length = 0;
    const over = await ev('document.documentElement.scrollWidth-innerWidth');
    console.log(tag, 'horizontal overflow px:', over, 'boxes:', await ev('document.querySelectorAll("details.box").length'));
    await shot(`${tag}-1-collapsed`, { x: 0, y: 0, width, height: Math.min(height * 1.6, await ev('document.documentElement.scrollHeight')) });
    for (const b of expand) {
      await ev(`document.querySelectorAll('details.box').forEach(d=>d.open=d.id===${JSON.stringify(b)});document.getElementById(${JSON.stringify(b)}).scrollIntoView()`); await sleep(500);
      await ev(`document.querySelector('#${b} iframe').scrollIntoView({block:'center'})`); await sleep(5000);
      await shot(`${tag}-2-expanded-${b}`, pad(await rectOf(`#${b}`), 8));
      // the frame as the visitor sees it: a plain viewport capture, no beyond-viewport resize
      const vr = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(out, `${tag}-2-view-${b}.png`), Buffer.from(vr.result.data, 'base64'));
    }
    await ev(`document.querySelectorAll('details.box').forEach(d=>d.open=d.id==='memory');document.getElementById('memory').scrollIntoView()`); await sleep(500); await ev(`document.querySelector('#memory iframe').scrollIntoView({block:'center'})`); await sleep(5000);
    await shot(`${tag}-3-memory-open`, pad(await rectOf('#memory'), 8));
    const charts = await ev('document.querySelectorAll(".chart").length');
    for (let i = 0; i < charts; i++) {
      const r = await ev(`(()=>{const r=document.querySelectorAll('.chart')[${i}].getBoundingClientRect();return {x:Math.round(r.x+scrollX),y:Math.round(r.y+scrollY),width:Math.round(r.width),height:Math.round(r.height)}})()`);
      await shot(`${tag}-4-chart-${i + 1}`, pad(r, 8));
    }
    console.log(tag, 'errors:', logs.length ? logs.join(' | ') : 'none');
  }
}
ws.close(); proc.kill(); await sleep(800); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
