// Publish one file as a quicklook artifact. The answer is /view/<ulid>/<entry>,
// which hooks.server.js serves to anyone with the link: the ULID is the whole
// credential, so what this route refuses is what never reaches the internet.
//
// "Is this a credential store" has one owner, src/vault/publish-guard.mjs over
// src/vault/secret-file.mjs. The refusal message is unchanged: a caller cannot
// tell a credential store from a path outside the publishable roots, and does
// not need to.
import { json, error } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { locateAny, withinWorkRoots } from '$lib/server/files.js';
import { DEFAULT_CWD } from '$lib/server/app.js';
import { publishRefusal } from '../../../../../runner/src/vault/publish-guard.mjs';

const HEAD_BYTES = 4096;

// Enough of the file to read a header row, never the file: this runs before a
// 100 MB publish and must not pull the bytes into memory to decide.
async function head(file) {
  let handle;
  try { handle = await open(file, 'r'); } catch { return null; }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function POST({ request }) {
  const input = await request.json();
  if (input.publish !== true) error(400, 'Explicit publish required');
  const file = await locateAny(input.path, DEFAULT_CWD);
  if (!file || file.directory || file.size > 100_000_000) error(400, 'Choose a file under 100 MB');
  const home = homedir();
  const allowed = withinWorkRoots(file.path)
    || [path.join(home, 'Documents'), path.join(home, 'Downloads')].some((root) => file.path.startsWith(root + '/'));
  // The head is only read for a file that would otherwise be published.
  if (!allowed || publishRefusal(file.path, await head(file.path))) error(403, 'This file cannot be published here');
  const publisher = process.env.TOPHAT_QUICKLOOK_PUBLISH || '';
  if (!publisher) error(501, 'publishing is not configured on this instance');
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [publisher, file.path],
    { timeout: 30000 }
  );
  const published = new URL(stdout.trim());
  return json({ url: '/view' + published.pathname }, { status: 201 });
}
