

const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;


export const SPOKEN_CAP = 1_100;

export function spokenText(markdown, { cap = SPOKEN_CAP } = {}) {
  if (!markdown) return '';
  let out = String(markdown);

  
  
  
  let blocks = 0;
  out = out.replace(CODE_FENCE, () => {
    blocks += 1;
    return ' \x00CODE\x00 ';
  });

  out = out
    
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    
    .replace(/\bhttps?:\/\/\S+/g, 'a link')
    
    .replace(/`([^`]+)`/g, '$1')
    
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    
    
    .replace(/^#{1,6}\s*(.+)$/gm, '$1.')
    
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    
    .replace(/^\|.*\|\s*$/gm, '\x00TABLE\x00')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-=]{3,}\s*$/gm, '');

  let tables = 0;
  out = out.replace(/(\x00TABLE\x00\s*)+/g, () => {
    tables += 1;
    return ' \x00T\x00 ';
  });

  out = out
    .replace(/\x00CODE\x00/g, blocks === 1 ? 'There is a code block on screen.' : 'There is code on screen.')
    .replace(/\x00T\x00/g, tables === 1 ? 'There is a table on screen.' : 'There are tables on screen.')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    
    
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length <= cap) return out;
  
  
  const head = out.slice(0, cap);
  const at = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  const kept = at > cap * 0.4 ? head.slice(0, at + 1) : head;
  return `${kept.trim()} The rest is on screen.`;
}

export function speechChunks(text, { max = 220 } = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  
  
  
  const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“])/);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length > max) {
      if (current) { chunks.push(current); current = ''; }
      
      
      let rest = piece;
      while (rest.length > max) {
        const window = rest.slice(0, max);
        const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '));
        const cut = at > max * 0.5 ? at + 1 : max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= max) current = `${current} ${piece}`;
    else { chunks.push(current); current = piece; }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function replyFromItems(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (!item) continue;
    
    
    
    if (item.agentId) continue;
    if (item.type === 'user') break;
    if (item.type === 'assistant' && item.text) out.unshift(item.text);
  }
  return out.join('\n\n').trim();
}
