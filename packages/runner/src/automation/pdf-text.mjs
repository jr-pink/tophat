import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBinary } from '../core/find-binary.mjs';

// Its own module so a reader of attachments (src/attachments/extract.mjs, which
// rev5/tools.mjs loads into the webchat) does not load the whole mail-automation
// closure to get one pdftotext call. mail-runtime.mjs re-exports it.
const check = (ok, code) => { if (!ok) throw new Error(code); };
const run = promisify(execFile);

/**
 * Where pdftotext is. The search is src/core/find-binary.mjs's, which is the one
 * place that knows a launchd PATH reaches neither Homebrew nor ~/.local/bin.
 * Until this moved, the list here was /opt/homebrew/bin and /usr/local/bin and
 * then the bare name spawned with PATH=/usr/bin:/bin, so on a Mac whose
 * pdftotext is the one in ~/.local/bin (which is where the owner's instructions
 * say it is) every attachment read answered pdf-extractor-unavailable, and a
 * document nobody could read is indistinguishable from a document with no text
 * in it. TOPHAT_PDFTOTEXT still overrides, now only when the path it names
 * exists: an override pointing at a file that is not there falls through to the
 * search rather than guaranteeing an ENOENT.
 */
export const pdftotextPath = (options) => findBinary('pdftotext', { envVar: 'TOPHAT_PDFTOTEXT', ...options });

/** Extract text from PDF bytes in an owner-only temp directory. Never logs content. */
export async function extractPdfText(bytes, { maxBytes = 20000000, timeoutMs = 20000, maxChars = 20000, maxPages = null } = {}) {
  check(Buffer.isBuffer(bytes) && bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'pdf-invalid-bytes');
  check(bytes.length <= maxBytes, 'pdf-too-large');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tophat-pdf-'));
  try {
    await fsp.chmod(directory, 0o700);
    const file = path.join(directory, 'input.pdf');
    await fsp.writeFile(file, bytes, { mode: 0o600 });
    const pages = maxPages == null ? [] : ['-l', String(Math.max(1, Math.min(1000, Math.floor(maxPages))))];
    const { stdout } = await run(pdftotextPath(), ['-layout', ...pages, file, '-'], { timeout: timeoutMs, maxBuffer: 4000000, env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
    return stdout.slice(0, maxChars);
  } catch (e) {
    throw new Error(e?.code === 'ENOENT' ? 'pdf-extractor-unavailable' : 'pdf-extraction-failed');
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}
