// Model routes: where a named model is actually served when that is not the model family's own API with the default
// credential. A route lives in one place, config.json `rev5.modelRoutes`, keyed by the model name every other table
// uses (purposeModels, models.json prices, the push prompt appendix), so moving a model between providers (OpenRouter
// today, a direct OpenAI key tomorrow) is a config edit and nothing else:
//
//   "modelRoutes": { "gpt-6.1-terra": {
//     "wire": "chat-completions" | "responses",   OpenAI-compatible Chat Completions, or the OpenAI Responses API
//     "baseUrl": "https://openrouter.ai/api/v1",  the endpoint root; /chat/completions or /responses is appended
//     "model": "openai/gpt-6.1-terra",            the id the endpoint knows it by (default: the key)
//     "keyFile": "/abs/path/to/key",              a 0600 file holding the bearer key (never the key itself)
//     "body": { "provider": { "zdr": true } },    fields merged into every request body (provider routing, temperature)
//     "maxTokensField": "max_tokens" } }          chat-completions only: the name of the output ceiling field
//
// No route: the model goes where it always went (Anthropic Messages, or OpenAI Responses with the default OpenAI
// credential). A route that is malformed is an error naming the key, never a silent fall-through to another provider.
import { accessSync, constants, readFileSync } from 'node:fs';
import { configFile } from '../base/paths.mjs';

export const ROUTE_WIRES = ['chat-completions', 'responses'];
export class RouteError extends Error { constructor(message) { super(message); this.name = 'RouteError'; } }

function readRoutes(env) {
  let text;
  try { text = readFileSync(env.TOPHAT_CONFIG || configFile({ ...env, TOPHAT_CONFIG: undefined }), 'utf8'); } catch { return {}; }
  try { const t = JSON.parse(text)?.rev5?.modelRoutes; return t && typeof t === 'object' && !Array.isArray(t) ? t : {}; } catch { return {}; }
}

/** The checked route for `model`, or null when the config names none. Tests and callers may pass `routes` directly. */
export function routeFor(model, env = process.env, routes = null) {
  if (!model) return null;
  const table = routes || readRoutes(env), r = table[model];
  if (r === undefined || r === null) return null;
  const where = `config.json rev5.modelRoutes["${model}"]`;
  if (typeof r !== 'object' || Array.isArray(r)) throw new RouteError(`${where} must be an object`);
  if (!ROUTE_WIRES.includes(r.wire)) throw new RouteError(`${where}.wire must be one of ${ROUTE_WIRES.join(', ')}`);
  if (typeof r.baseUrl !== 'string' || !/^https?:\/\//.test(r.baseUrl)) throw new RouteError(`${where}.baseUrl must be an http(s) URL`);
  if (typeof r.keyFile !== 'string' || !r.keyFile.startsWith('/')) throw new RouteError(`${where}.keyFile must be an absolute path to a key file`);
  if (r.body !== undefined && (typeof r.body !== 'object' || r.body === null || Array.isArray(r.body))) throw new RouteError(`${where}.body must be an object`);
  return { name: model, wire: r.wire, baseUrl: r.baseUrl.replace(/\/+$/, ''), model: typeof r.model === 'string' && r.model ? r.model : model,
    keyFile: r.keyFile, body: r.body || {}, maxTokensField: r.maxTokensField || 'max_tokens' };
}

/** routeFor, but a malformed route reads as no route plus the reason (for callers that only ask "is it keyed?"). */
export function routeOrNull(model, env = process.env) { try { return routeFor(model, env); } catch { return null; } }

/** True when the route's key file is readable and not empty. */
export function routeKeyed(route) {
  if (!route) return false;
  try { accessSync(route.keyFile, constants.R_OK); return readFileSync(route.keyFile, 'utf8').trim().length > 0; } catch { return false; }
}

export function routeUrl(route) { return `${route.baseUrl}/${route.wire === 'responses' ? 'responses' : 'chat/completions'}`; }
