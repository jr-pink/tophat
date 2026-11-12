// The memory viewer (packages/viewer) served by the demo itself at /graph, reading the demo's published graph snapshot (its own repo docs and
// commit log, never anything private): public and read-only, so an anonymous guest can load it, and frameable by anyone (nothing in it is private or writable; the widget's sandboxed frame is no ancestor 'self' would match). The
// memory-graph widget is an iframe of this page. The widget itself runs sandboxed (opaque origin), so the viewer is also served for that
// case: the snapshot and the layout worker's script answer with CORS `*`, and frame.js starts the worker from a blob when the page's origin is opaque (window.origin is 'null'; location.origin still shows the URL's).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const FRAME_JS = `(()=>{if(window.origin!=='null')return;const W=window.Worker;window.Worker=function(u,o){const x=new XMLHttpRequest();x.open('GET',new URL(u,location.href).href,false);x.send();return new W(URL.createObjectURL(new Blob([x.responseText],{type:'text/javascript'})),o)}})();\n`;

/** A handler (req, res, pathname) -> boolean: true when it answered. `assets` is the built viewer (packages/viewer/assets), `snapshot` the demo's graph snapshot file. */
export function graphRoute({ assets, snapshot }) {
  const file = (name) => path.join(assets, name);
  return (req, res, p) => {
    if (p !== '/graph' && p !== '/graph/' && !p.startsWith('/graph/') && !p.startsWith('/e/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
    const cors = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...cors, ...extra }); res.end(req.method === 'HEAD' ? undefined : body); return true; };
    if (p === '/graph/snapshot.json') return existsSync(snapshot) ? send(200, 'application/json', readFileSync(snapshot), { 'cache-control': 'public, max-age=300' }) : send(404, 'text/plain', 'no snapshot');
    if (p === '/graph/frame.js') return send(200, TYPES['.js'], FRAME_JS, { 'cache-control': 'public, max-age=300' });
    if (p === '/graph' || p === '/graph/' || p.startsWith('/e/')) {
      if (!existsSync(file('index.html'))) return send(404, 'text/plain', 'no viewer bundle');
      const html = readFileSync(file('index.html'), 'utf8')
        .replace('<meta name="th-hub" content="">', '<meta name="th-hub" content=""><meta name="th-public" content="/graph/snapshot.json"><meta name="th-theme" content="auto">')
        .replace('<script src="/graph/libs.js">', '<script src="/graph/frame.js"></script><script src="/graph/libs.js">');
      return send(200, TYPES['.html'], html, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'" });
    }
    const name = p.slice('/graph/'.length);
    if (!/^(app|libs|sim)\.js$/.test(name) || !existsSync(file(name))) return send(404, 'text/plain', 'not found');
    return send(200, TYPES['.js'], readFileSync(file(name)), { 'cache-control': 'public, max-age=300' });
  };
}
