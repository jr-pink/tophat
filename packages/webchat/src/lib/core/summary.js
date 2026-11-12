

const SECTION = /(?:^|\n)\s*(?:[-*]\s*)?\**\s*(last|next|blocked)\s*\**\s*(?:[—:-]|—)\s*/iu;

export function sections(text) {
  const found = {};
  let rest = String(text || '');
  let match = rest.match(SECTION);
  while (match) {
    const name = match[1].toLowerCase();
    const start = match.index + match[0].length;
    rest = rest.slice(start);
    const next = rest.match(SECTION);
    found[name] = (next ? rest.slice(0, next.index) : rest).trim();
    match = next;
  }
  return found;
}

// Sidebar previews are plain text: HTML tags (details, summary and any other, a half-cut one at either end included),
// markdown links, code fences, heading and quote markers, emphasis and strikethrough marks are dropped, and runs of
// whitespace collapse to one space.
export function plainText(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ')
    .replace(/<\/?[a-z][^<>]*(?:>|$)/giu, ' ')
    .replace(/(?:^|\s)\/?[a-z][a-z0-9-]*>(?=\s|$)/giu, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/gu, '$1')
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gmu, ' ')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?)/gmu, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, '$2')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]*?\S)\2(?=$|[\s).,;:!?])/gu, '$1$3')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/gu, '$1')
    .replace(/\*\*|~~|`+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

// A preview is cut at a word boundary, never inside a word, and says where text was dropped: a trailing … for a head cut (the start
// of a message), a leading … for a tail cut (the end of a streaming reply).
export function clipHead(text, max = 180) {
  const t = String(text || '');
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  if (/\S/u.test(t[max])) { const at = cut.search(/\s\S*$/u); if (at > 0) cut = cut.slice(0, at); }
  return `${cut.trimEnd()}…`;
}

export function clipTail(text, max = 180) {
  const t = String(text || '');
  if (t.length <= max) return t;
  let cut = t.slice(-max);
  if (/\S/u.test(t[t.length - max - 1])) { const at = cut.search(/\s/u); if (at >= 0 && at < cut.length - 1) cut = cut.slice(at + 1); }
  return `…${cut.trimStart()}`;
}

function tidy(text) {
  return plainText(text);
}

export function summarize(text, { words = 6 } = {}) {
  const found = sections(text);
  const chosen = found.blocked && !/^(nothing|none)\b/iu.test(found.blocked)
    ? `Blocked: ${found.blocked}`
    : found.last || tidy(text);
  return clip(tidy(chosen), words);
}

function clip(text, words) {
  const parts = text.split(' ').filter(Boolean);
  if (parts.length <= words) return text.replace(/[.,;:]+$/u, '');
  return `${parts.slice(0, words).join(' ').replace(/[.,;:]+$/u, '')}…`;
}
