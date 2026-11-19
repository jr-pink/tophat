#!/usr/bin/env node
// Looks at the demo's widgets the way the chat embeds them: srcdoc iframe, sandbox="allow-scripts", the webchat's own widgetDocument()
// wrapper (CSP included), 420 px tall. For each widget x width x colour scheme it saves a screenshot and reports console errors,
// CSP violations and overflow (anything that scrolls past its own box or sticks out of the frame).
//   node packages/demo/dev/widget-shots.mjs --out DIR [--widgets a,b] [--widths 700,360] [--height 420] [--snapshot FILE] [--steps]
// `--steps` also takes the interaction shots a widget lists in its `data-shots` attribute (a ";" list of "name|selector|action", selector a CSS selector or @x_y in frame pixels).
// Needs Google Chrome (headless, its own profile, closed at the end); no other dependency.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { widgetDocument } from '../../webchat/src/lib/core/rich-content.js';
import { buildGraph } from '../widgets/build-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDGETS = path.join(HERE, '..', 'widgets');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const out = args.out || (console.error('--out DIR'), process.exit(2));
const widths = String(args.widths || '700,360').split(',').map(Number);
const height = Number(args.height || 420);
const all = ['memory-graph', 'memory-bench', 'runner-qol', 'mac-desktop', 'connectors', 'sharing', 'local'];
const which = args.widgets ? String(args.widgets).split(',') : all;
mkdirSync(out, { recursive: true });

if (args.snapshot) buildGraph({ snapshot: args.snapshot });

// what runs inside the frame, before the widget: reports errors and answers geometry queries; nothing else
const HOOK = `<script>
(()=>{const send=m=>parent.postMessage(m,'*');
addEventListener('error',e=>send({err:String(e.message)}));
addEventListener('unhandledrejection',e=>send({err:'rejection '+e.reason}));
addEventListener('securitypolicyviolation',e=>send({err:'csp '+e.violatedDirective+' '+e.blockedURI}));
const ce=console.error;console.error=(...a)=>{send({err:'console.error '+a.join(' ')});ce.apply(console,a)};
addEventListener('message',e=>{const d=e.data||{};
 if(d.q){const el=document.querySelector(d.q);const r=el&&el.getBoundingClientRect();send({id:d.id,rect:r&&{x:r.x,y:r.y,w:r.width,h:r.height}})}
 if(d.dump){send({id:d.id,dump:[...document.querySelectorAll(d.dump)].slice(0,4).map(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return {tag:e.tagName+'.'+e.className,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),display:c.display,clamp:c.webkitLineClamp,font:c.fontSize,text:e.textContent.slice(0,40)}})})}
 if(d.over){const bad=[];const W=innerWidth,H=innerHeight;
  const de=document.documentElement;if(de.scrollWidth>W+1)bad.push('page scrollWidth '+de.scrollWidth+'>'+W);if(de.scrollHeight>H+1)bad.push('page scrollHeight '+de.scrollHeight+'>'+H);
  const vis=el=>{let r=el.getBoundingClientRect(),l=r.left,t=r.top,rt=r.right,b=r.bottom;for(let a=el.parentElement;a&&a!==document.documentElement;a=a.parentElement){const o=getComputedStyle(a);if(o.overflowX!=='visible'||o.overflowY!=='visible'){const q=a.getBoundingClientRect();if(o.overflowX!=='visible'){l=Math.max(l,q.left);rt=Math.min(rt,q.right)}if(o.overflowY!=='visible'){t=Math.max(t,q.top);b=Math.min(b,q.bottom)}}}return rt>l&&b>t?{l,t,r:rt,b}:null};
  for(const el of document.querySelectorAll('body *')){const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')continue;if(el.closest('svg')&&el.tagName!=='svg')continue;const v=vis(el);if(!v)continue;
   if(v.r>W+1||v.l<-1||v.b>H+1||v.t<-1)bad.push('outside '+el.tagName+'.'+(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)+' '+Math.round(v.l)+','+Math.round(v.t)+' '+Math.round(v.r)+','+Math.round(v.b));
   if(el.children.length===0&&el.scrollWidth>el.clientWidth+1&&cs.overflowX==='visible'&&el.clientWidth>0&&!el.closest('svg')&&!el.hasAttribute('data-clip'))bad.push('text overflow '+el.tagName+'.'+el.className+' '+el.scrollWidth+'>'+el.clientWidth)}
  send({id:d.id,over:bad.slice(0,12)})}
});})();
</script>`;

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(path.join(os.tmpdir(), 'widget-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
// never leak the browser: kill it on every exit path (throw, process.exit, SIGTERM from `timeout`, Ctrl-C)
const reapChrome = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
process.once('exit', reapChrome);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { reapChrome(); process.kill(process.pid, sig); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return new WebSocket(j.webSocketDebuggerUrl); } catch { await sleep(250); }
  }
  throw new Error('chrome did not start');
}
const ws = await connect();
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(), listeners = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else listeners.forEach((f) => f(m)); });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const report = [];
const tag0 = (n, w, s) => `${n}-${w}-${s}`;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  let frameMsgs = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') frameMsgs.push('exception ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) frameMsgs.push('console.' + m.params.type + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.bindingCalled') frameMsgs.push(m.params.payload);
  });
  await S('Runtime.addBinding', { name: 'toNode' });
  const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  for (const name of which) {
    const file = path.join(WIDGETS, name + '.html');
    const html = readFileSync(file, 'utf8');
    const doc = widgetDocument(html).replace('<body>', '<body>' + HOOK);
    for (const scheme of ['light', 'dark']) for (const w of widths) {
      await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await S('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: 2, mobile: false });
      frameMsgs = [];
      const page = `<!doctype html><meta charset=utf-8><body style="margin:0;background:${scheme === 'dark' ? '#1d1d1d' : '#fff'}"><iframe id=f sandbox="allow-scripts" style="display:block;border:0;width:${w}px;height:${height}px" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><script>
window.__m=[];addEventListener('message',e=>{window.__m.push(e.data)});
window.ask=(m)=>new Promise(r=>{const id=Math.random();m.id=id;const f=e=>{if(e.data&&e.data.id===id){removeEventListener('message',f);r(e.data)}};addEventListener('message',f);document.getElementById('f').contentWindow.postMessage(m,'*')});
</script>`;
      await S('Page.navigate', { url: 'about:blank' });
      const { frameTree } = await S('Page.getFrameTree');
      await S('Page.setDocumentContent', { frameId: frameTree.frame.id, html: page });
      await sleep(Number(args.settle || 1800));
      const errs = await ev('window.__m.filter(m=>m&&m.err).map(m=>m.err)');
      if (args.dump) console.log(tag0(name, w, scheme), JSON.stringify((await ev(`ask({dump:${JSON.stringify(args.dump)}})`)).dump));
      const over = await ev("ask({over:1}).then(r=>r.over)");
      const tag = `${name}-${w}-${scheme}`;
      const shot = async (suffix = '') => { const { data } = await S('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height, scale: 1 } }); writeFileSync(path.join(out, `${tag}${suffix}.png`), Buffer.from(data, 'base64')); };
      await shot();
      const steps = [];
      if (args.steps) {
        const m = /data-shots="([^"]*)"/.exec(html);
        for (const s of (m ? m[1].split(';').filter(Boolean) : [])) {
          const [sname, sel, act] = s.split('|');
          const r = sel.startsWith('@') ? { x: +sel.slice(1).split('_')[0], y: +sel.slice(1).split('_')[1], w: 0, h: 0 } : (await ev(`ask({q:${JSON.stringify(sel)}})`)).rect;
          if (!r) { steps.push(`${sname}: no ${sel}`); continue; }
          const x = r.x + r.w / 2, y = r.y + r.h / 2;
          await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          if (act === 'click') { await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
          await sleep(Number(args.stepSettle || 900));
          await shot('-' + sname);
          steps.push(`${sname}: ok`);
          const o2 = await ev('ask({over:1}).then(r=>r.over)'); if (o2.length) over.push(...o2.map((x) => `[${sname}] ${x}`));
        }
      }
      report.push({ tag, errors: [...errs, ...frameMsgs], overflow: over, steps });
    }
  }
} finally {
  ws.close(); proc.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true });
}
let bad = 0;
for (const r of report) { const ok = !r.errors.length && !r.overflow.length; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.tag}${r.steps.length ? '  [' + r.steps.join('; ') + ']' : ''}`); for (const e of [...r.errors, ...r.overflow]) console.log('       ' + e); }
process.exit(bad ? 1 : 0);
