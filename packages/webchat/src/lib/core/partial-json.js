

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function decodeFrom(raw, start) {
  let out = '';
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') return { text: out, closed: true };
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    if (next === undefined) return { text: out, closed: false }; 
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) return { text: out, closed: false };
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ESCAPES[next] ?? next;
    i += 1;
  }
  return { text: out, closed: false };
}

export function partialJsonString(raw, key) {
  if (typeof raw !== 'string' || !raw) return null;
  const marker = `"${key}"`;
  let from = 0;
  for (;;) {
    const at = raw.indexOf(marker, from);
    if (at === -1) return null;
    let i = at + marker.length;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (raw[i] !== ':') { from = at + 1; continue; }
    i += 1;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length) return { text: '', closed: false };
    if (raw[i] !== '"') { from = at + 1; continue; }
    return decodeFrom(raw, i + 1);
  }
}

export function tryParseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function parseWhenClosed(raw) {
  if (typeof raw !== 'string') return null;
  let end = raw.length - 1;
  while (end >= 0) {
    const ch = raw[end];
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') break;
    end -= 1;
  }
  if (end < 0) return null;
  const last = raw[end];
  if (last !== '}' && last !== ']') return null;
  return tryParseJson(raw);
}

export const STREAMING_FIELD = Object.freeze({
  Write: 'content',
  Edit: 'new_string',
  NotebookEdit: 'new_source',
  Bash: 'command',
  Task: 'prompt',
  Agent: 'prompt'
});

export function streamingPreview(tool, rawInput) {
  const field = STREAMING_FIELD[tool];
  if (!field) return null;
  const found = partialJsonString(rawInput, field);
  return found ? { field, ...found } : null;
}

export function targetPath(input, rawInput) {
  const settled = input?.file_path || input?.notebook_path;
  if (typeof settled === 'string' && settled) return settled;
  for (const key of ['file_path', 'notebook_path']) {
    const found = partialJsonString(rawInput, key);
    
    
    
    
    if (found?.closed && found.text) return found.text;
  }
  return '';
}
