// The fast-model header proxy. The webchat's chat titles and folder routing call an OpenAI-compatible
// `<models.fast.baseUrl>/chat/completions` with only a bearer key. A key scoped to an organisation (Anthropic) is refused
// without its workspace id in a header, which those calls cannot add. This listens on loopback, forwards the request
// untouched to the upstream and adds the header; the key is the caller's own bearer, the workspace id is read from its
// credential reference on every request, and neither is logged. Nothing else is forwarded: one POST path, one upstream.
import http from 'node:http';
import { loadInstance, resolveRef } from './instance.mjs';

const MAX_BODY = 1024 * 1024;

export function createFastProxy({ upstream, workspace, fetchImpl = fetch, timeoutMs = 60_000 }) {
  return http.createServer((req, res) => {
    const done = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || !/^\/(v1\/)?chat\/completions$/.test(req.url.split('?')[0])) return done(404, { error: 'not found' });
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > MAX_BODY) { done(413, { error: 'too large' }); req.destroy(); } else chunks.push(d); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const ws = workspace();
        if (!ws) return done(502, { error: 'fast model workspace id unreadable' });
        const r = await fetchImpl(`${upstream.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '', 'anthropic-workspace-id': ws }, body: Buffer.concat(chunks) });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { done(502, { error: `upstream: ${String(e?.message || e).slice(0, 120)}` }); }
    });
  });
}

/** Run the proxy for an instance file until the process ends. */
export function runFastProxy(configFile) {
  const c = loadInstance(configFile), fast = c.models.fast;
  if (!fast?.workspace || !fast.baseUrl) throw new Error('fast-proxy: the instance file needs models.fast.baseUrl and models.fast.workspace');
  const server = createFastProxy({ upstream: fast.baseUrl, workspace: () => resolveRef(fast.workspace, { keyringDir: c.paths.secrets }) });
  server.listen(Number(c.ports.fastProxy), '127.0.0.1');
  return server;
}
