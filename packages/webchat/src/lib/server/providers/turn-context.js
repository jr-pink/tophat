import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The retrieval command is the instance's own (runner.env TOPHAT_CONTEXT_CLI, run as `node CLI context --query TEXT`);
// the product ships none, so an instance that names none gets no retrieved context rather than a failure notice per turn.
const cli = '';

/**
 * Four megabytes. The render bounds itself at 240KiB through `contextOutput`
 * and its document block at 64KiB again inside that, so this is not the
 * instrument that keeps the payload small; it is headroom, because an
 * `execFile` over its buffer fails the whole retrieval rather than truncating
 * it, and a ceiling one section away from the render's own is a cliff nothing
 * reports until a turn arrives with no context at all.
 */
const MAX_BUFFER_BYTES = Number(process.env.TOPHAT_CONTEXT_MAX_BUFFER || 4 * 1024 * 1024);

/** Thirty seconds. The latency is the defect; this stops it costing the turn its
 * whole context while that is fixed, and the same measurement is what has to
 * move it back down.
 */
const TIMEOUT_MS = Number(process.env.TOPHAT_CONTEXT_TIMEOUT_MS || 30000);
export function retrieveTurnContext(prompt, { cwd, previousPrompt = '', run = execFile } = {}) {
  if (prompt.startsWith('/') || !process.env.TOPHAT_CONTEXT_CLI) return Promise.resolve('');
  return new Promise((resolve) => {
    run(process.execPath, [process.env.TOPHAT_CONTEXT_CLI || cli, 'context', '--query', [previousPrompt, prompt].filter(Boolean).join('\n')], {
      cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env }
    }, (error, stdout) => {
      if (error) {
        // Record the failure class, never the command (which contains the
        // owner's question) or source output. Otherwise a bad path, a full
        // output buffer and a timeout all look like missing knowledge.
        console.error('[turn-context] retrieval failed', {code: error.code, signal: error.signal,
          killed: error.killed, outputBytes: Buffer.byteLength(stdout || '')});
        resolve('<tophat-retrieval-status>Retrieval failed or timed out; context freshness is unknown. Check the source before relying on prior thread state.</tophat-retrieval-status>');
      }
      else resolve(String(stdout || ''));
    });
  });
}
