// Derivation providers: a registry of model backends behind one call,
//   complete({ system, user, packet, maxTokens }) -> Promise<{ text, usage: { input_tokens, output_tokens }, model }>
// Built in: 'openai' (any OpenAI-compatible chat completions endpoint: baseUrl, model), 'anthropic' (Messages API),
// 'command' (a local program: the request JSON on stdin, the reply text on stdout), 'stub' (deterministic, no model:
// tests and dry runs). Keys come from the environment variable the config names (apiKeyEnv), never from code or argv.
// Register another: registerProvider('name', (cfg, deps) => ({ complete })).
import { spawn } from 'node:child_process';

const REGISTRY = new Map();
export function registerProvider(name, factory) { REGISTRY.set(name, factory); }
export function providerNames() { return [...REGISTRY.keys()]; }
export function makeProvider(cfg = {}, deps = {}) {
  const f = REGISTRY.get(cfg.provider);
  if (!f) throw new Error(`model.provider must be one of ${providerNames().join(', ')}`);
  return f(cfg, deps);
}
const keyOf = (cfg, env) => { const v = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : null; if (!v) throw new Error(`model.apiKeyEnv must name an environment variable holding the key (${cfg.apiKeyEnv || 'unset'})`); return v; };

registerProvider('openai', (cfg, { fetch: f = fetch, env = process.env } = {}) => ({
  async complete({ system, user, maxTokens }) {
    if (!cfg.model) throw new Error('model.model is required');
    const r = await f(`${(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs ?? 120000),
      headers: { authorization: `Bearer ${keyOf(cfg, env)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`provider http ${r.status}`), { code: `provider-http-${r.status}` });
    return { text: j.choices?.[0]?.message?.content ?? '', usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 }, model: j.model || cfg.model };
  },
}));
registerProvider('anthropic', (cfg, { fetch: f = fetch, env = process.env } = {}) => ({
  async complete({ system, user, maxTokens }) {
    if (!cfg.model) throw new Error('model.model is required');
    const r = await f(`${(cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs ?? 120000),
      headers: { 'x-api-key': keyOf(cfg, env), 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        // A key scoped to an organisation rather than a workspace is refused (HTTP 400) without the workspace id beside it.
        ...(cfg.workspaceEnv && env[cfg.workspaceEnv] ? { 'anthropic-workspace-id': env[cfg.workspaceEnv] } : {}) },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`provider http ${r.status}`), { code: `provider-http-${r.status}` });
    return { text: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0 }, model: j.model || cfg.model };
  },
}));
registerProvider('command', (cfg) => ({
  complete({ system, user, maxTokens }) {
    if (!Array.isArray(cfg.command) || !cfg.command.length) throw new Error('model.command must be [program, ...args]');
    return new Promise((resolve, reject) => {
      const p = spawn(cfg.command[0], cfg.command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve({ text: out, usage: { input_tokens: Math.ceil((system.length + user.length) / 4), output_tokens: Math.ceil(out.length / 4) }, model: cfg.command[0] }) : reject(Object.assign(new Error(`command exited ${code}`), { code: 'provider-command-failed' }))));
      p.stdin.end(JSON.stringify({ system, user, max_tokens: maxTokens }));
    });
  },
}));
/** Deterministic: each record becomes one note about the multi-word capitalized names in it (reusing candidates by name). */
registerProvider('stub', () => ({
  async complete({ packet }) {
    const ents = [], notes = [], byName = new Map(packet.candidates.map((c) => [c.name.toLowerCase(), c.code]));
    for (const r of packet.records) {
      const names = [...new Set((r.text.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g) || []).map((n) => n.replace(/^(The|A|An) /, '')).filter((n) => n.includes(' ')))];
      const refs = names.map((n) => {
        if (!byName.has(n.toLowerCase())) { const ref = `$${ents.length + 1}`; ents.push({ ref, name: n, type: 'topic', aliases: [] }); byName.set(n.toLowerCase(), ref); }
        return byName.get(n.toLowerCase());
      });
      if (refs.length) notes.push({ body: `${r.author ? `${r.author} wrote` : 'A record says'}: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`, entities: refs, sources: [r.code] });
    }
    const text = JSON.stringify({ entities: ents, notes });
    return { text, usage: { input_tokens: 0, output_tokens: 0 }, model: 'stub' };
  },
}));
