// Scoped sign-in for the webchat, behind config `scopes.enabled` (default off: a single-owner
// install is unchanged). The decision logic is src/scopes/edge-gate.mjs; this file only reads
// the config once and hands hooks.server.js the gate, or null when scopes are off.
import { loadConfig } from '../../../../runner/src/config.mjs';
import { loadRegistry } from '../../../../runner/src/scopes/registry.mjs';
import { makeScopeGate, registryFromFile } from '../../../../runner/src/scopes/edge-gate.mjs';

let memo;

export function scopeGate() {
  if (memo !== undefined) return memo;
  let cfg = null;
  try {
    cfg = loadConfig().scopes;
  } catch (e) {
    // An explicitly named config file that does not parse must not silently turn sign-in off.
    if (process.env.TOPHAT_CONFIG) throw e;
  }
  if (!cfg?.enabled) return (memo = null);
  if (!cfg.registryFile || !cfg.authBase || !cfg.orgDomain) throw new Error('scopes.enabled needs scopes.registryFile, authBase and orgDomain');
  const registry = registryFromFile(cfg.registryFile);
  registry(); // fail at boot, not on the first request, if the file is unreadable
  loadRegistry(cfg.registryFile); // the default registry other modules (the scope binding) import
  return (memo = makeScopeGate({ authBase: cfg.authBase, orgDomain: cfg.orgDomain, publicBase: cfg.publicBase, cookieName: cfg.cookieName || undefined, registry }));
}
