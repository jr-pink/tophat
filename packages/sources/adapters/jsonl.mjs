// File drop: every *.jsonl file in config.dir (and its subdirectories one level down, which is where the webhook
// receiver spools), one JSON object per complete line:
//   {"id": "unique-in-source", "text": "...", "time": "ISO-8601", "author"?: "...", "thread"?: "...",
//    "participants"?: [...], "revision"?: "...", "direction"?: "sent"|"received"}
// A partial last line (no newline yet) is left for the next poll. Cursor: {files: {relativePath: byteOffset}}.
// Files are never modified or deleted by the adapter.
import fs from 'node:fs';
import path from 'node:path';
import { fail, hashJson, result } from '../lib/common.mjs';

function listFiles(dir) {
  const out = [];
  let top; try { top = fs.readdirSync(dir, { withFileTypes: true }); } catch { fail('drop-directory-unavailable'); }
  for (const e of top) {
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(e.name);
    else if (e.isDirectory()) { for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.jsonl')) out.push(path.join(e.name, f)); }
  }
  return out.sort();
}

export function lineRecord(obj, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('invalid-record', { where });
  if (typeof obj.id !== 'string' || !obj.id || typeof obj.text !== 'string' || !Number.isFinite(Date.parse(obj.time))) fail('invalid-record', { where });
  return { id: obj.id, text: obj.text, occurredAt: new Date(obj.time).toISOString(), revision: String(obj.revision ?? hashJson(obj)),
    ...(obj.author ? { sender: String(obj.author) } : {}), ...(Array.isArray(obj.participants) ? { participants: obj.participants.map(String) } : {}),
    ...(obj.thread ? { threadId: String(obj.thread) } : {}), metadata: { type: 'jsonl', ...(obj.direction ? { direction: String(obj.direction) } : {}), file: where.file } };
}

export async function poll(source, { cursor = null, maxRecords = 5000 } = {}) {
  const dir = source.config?.dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('absolute-drop-directory-required');
  const files = { ...(cursor?.files || {}) };
  const records = [], bad = [];
  let more = false;
  for (const rel of listFiles(dir)) {
    if (records.length >= maxRecords) { more = true; break; }
    const buf = fs.readFileSync(path.join(dir, rel));
    let off = files[rel] ?? 0;
    while (off < buf.length && records.length < maxRecords) {
      const nl = buf.indexOf(0x0a, off);
      if (nl < 0) break; // partial line: next poll
      const line = buf.subarray(off, nl).toString('utf8').trim();
      const at = off; off = nl + 1;
      if (!line) continue;
      try { records.push(lineRecord(JSON.parse(line), { file: rel, offset: at })); } catch { bad.push({ file: rel, offset: at }); }
    }
    if (off < buf.length && buf.indexOf(0x0a, off) >= 0) more = true;
    files[rel] = off;
  }
  return result(records, { files }, !more, { malformed: bad.length, malformedAt: bad.slice(0, 20) });
}
