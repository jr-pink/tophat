// The vault-value scrub for text a model wrote, on its way into a store.
//
// Every writer of model-authored text (rev5/pull.mjs ledger append, rev5/goals.mjs,
// rev5/waits.mjs, rev5/tasks.mjs taskRequest, rev5/tools.mjs memoryCli and job rows,
// rev5/agents.mjs subagent rows) runs its value through scrubForStore first.
//
// Same matcher and placeholder as the tool-result scrub (src/vault/secret-index.mjs):
// each exact value becomes `[redacted:VAULT-ID]`, which still tells a later reader
// which entry to fill with `--secret-from`. Nothing here prints a value.
import { sharedSecretIndex } from './secret-index.mjs';

/**
 * Deep-scrub a JSON-shaped value: every string leaf through index.redact.
 * A `thinking` block whose text changed loses its signature, because the API
 * refuses a thinking block whose text no longer matches it; rev5/pull.mjs
 * buildMessages already drops unsigned thinking blocks on the way out.
 * Returns {value, hits}; `value` is the input itself when nothing matched.
 */
export function scrubDeep(value, index) {
  const hits = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!node) return node;
      const out = index.redact(node);
      if (!out.hits.length) return node;
      for (const id of out.hits) hits.add(id);
      return out.text;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => { const v = walk(item); if (v !== item) changed = true; return v; });
      return changed ? next : node;
    }
    if (node && typeof node === 'object') {
      let changed = false;
      const next = {};
      for (const [k, v] of Object.entries(node)) { const w = walk(v); if (w !== v) changed = true; next[k] = w; }
      if (!changed) return node;
      if (next.type === 'thinking' && 'signature' in next && next.thinking !== node.thinking) delete next.signature;
      return next;
    }
    return node;
  };
  const out = walk(value);
  return { value: out, hits: [...hits] };
}

/**
 * Scrub `value` (a string or a JSON-shaped object) for a store write. `secrets`
 * is a secret index, null to skip, or undefined for the process-wide one
 * (off with TOPHAT_REDACT_SECRETS=0). Never throws: a matcher that fails leaves
 * the value as it was and says so on stderr, because losing the owner's record
 * to a scrub error is worse than the leak it guards against, which the
 * backfill (scripts/redact-vault-values.mjs) can still clean.
 */
export function scrubForStore(value, { secrets, env = process.env, label = 'store' } = {}) {
  let index;
  try { index = secrets === undefined ? sharedSecretIndex(env) : secrets; } catch { index = null; }
  if (!index || value === null || value === undefined) return { value, hits: [] };
  try { return scrubDeep(value, index); }
  catch (error) {
    process.stderr.write(`[${label}] vault scrub failed (${String(error?.message || error).split('\n')[0].slice(0, 120)}); written unscrubbed\n`);
    return { value, hits: [] };
  }
}

/** A JSON text scrubbed leaf by leaf (thinking signatures handled); a text that is not JSON is redacted whole. */
export function scrubJsonText(text, index) {
  if (typeof text !== 'string' || !text) return { text, hits: [] };
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed !== undefined) {
      const { value, hits } = scrubDeep(parsed, index);
      if (!hits.length) return index.redact(text);   // a value only in a key, say
      // keep the file's own layout: pretty JSON stays pretty
      const pretty = /\n\s/.test(text.slice(0, 200));
      const out = JSON.stringify(value, null, pretty ? 1 : undefined);
      // a value sitting in a key, say, survives a leaf walk: then the whole text is redacted as well
      const rest = index.redact(out);
      return { text: rest.text, hits: [...new Set([...hits, ...rest.hits])] };
    }
  }
  return index.redact(text);
}
