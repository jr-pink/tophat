

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

function tidy(text) {
  return String(text || '').replace(/\s+/gu, ' ').replace(/\*\*/gu, '').trim();
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
