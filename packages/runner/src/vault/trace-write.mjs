// One writer for the model-bridge traces (TOPHAT_RUNNER_TRACE_DIR): one
// {input, result} JSON file per call, scrubbed of every exact vault value
// before it touches the disk and written owner-only.
//
// Why: the traces hold the exact request, and a request is assembled from
// retrieved text. the runner's tool-result scrub never covered this file, and
// the files were written 0644. The trace is for inspecting packets, which a
// `[redacted:VAULT-ID]` placeholder does not hurt.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedSecretIndex } from './secret-index.mjs';

/** The text a trace file would hold, redacted. `secrets` is a secret index (createSecretIndex) or null to skip. */
export function traceBody(input, result, secrets) {
  const text = JSON.stringify({ input, result }, null, 1);
  if (!secrets) return { text, hits: [] };
  return secrets.redact(text);
}

/** Write one trace file into `dir`; returns its path, or null when no dir. Never throws. */
export function writeTrace(dir, input, result, { secrets, label = 'trace', now = new Date(), pid = process.pid, env = process.env } = {}) {
  if (!dir) return null;
  try {
    const index = secrets === undefined ? sharedSecretIndex(env) : secrets;
    const { text } = traceBody(input, result, index);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-${pid}.json`);
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  } catch (error) {
    process.stderr.write(`[${label}] trace not written (${error.code || 'error'})\n`);
    return null;
  }
}
