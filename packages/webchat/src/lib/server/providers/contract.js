

import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { kimiAdapter } from './kimi.js';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { kimiAvailable } from './kimi.js';
import { directAdapter, directAvailable } from './direct.js';
import { providerOfModel } from '../../core/providers.js';

const ADAPTERS = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  direct: directAdapter
});

export function adapterFor(settings = {}) {
  const provider = settings.provider || providerOfModel(settings.model);
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`No backend for provider ${provider}`);
  return adapter;
}

export function adapterById(id) {
  return ADAPTERS[id] || null;
}

export function allAdapters() {
  return Object.values(ADAPTERS);
}

export function orphanMarkers() {
  return [...new Set(allAdapters().map((a) => a.orphanMarker).filter(Boolean))];
}

/** Whether an executable is on PATH: a few stat calls, where `which` was a synchronous process spawn. */
function onPath(name, env) {
  const candidates = name.includes('/') ? [name] : String(env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  return candidates.some((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

let cached = null;
export function availableProviders({ env = process.env } = {}) {
  if (cached) return cached;
  const out = ['claude'];
  if (onPath(env.WEBCHAT_CODEX_BIN || 'codex', env)) out.push('codex');
  if (kimiAvailable(env)) out.push('kimi');
  if (directAvailable(env)) out.push('direct');
  cached = out;
  return out;
}


export function forgetAvailability() { cached = null; }
