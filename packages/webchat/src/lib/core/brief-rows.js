

import { renderBlock, renderInline, splitBlocks } from './markdown.js';
import { lineKey } from './stamps.js';

const MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;

function taskHtml(text) {
  const box = text.match(/^\[( |x|X)\]\s+/u);
  if (!box) return { html: renderInline(text), done: null };
  const done = box[1].toLowerCase() === 'x';
  return { html: renderInline(text.slice(box[0].length)), done };
}

function depthOf(indent) {
  return Math.min(3, Math.floor(indent.length / 2));
}

export function briefRows(markdown) {
  const rows = [];
  
  
  
  
  
  const seen = new Map();
  const unique = (key) => {
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key} #${count}`;
  };
  for (const block of splitBlocks(String(markdown ?? ''))) {
    const lines = block.split('\n');
    if (!MARKER.test(lines[0]) || /^\s*(?:```|~~~)/u.test(lines[0])) {
      rows.push({ key: unique(lineKey(lines[0])), kind: 'block', depth: 0, text: block, html: renderBlock(block), done: null });
      continue;
    }
    let current = null;
    for (const line of lines) {
      const marker = line.match(MARKER);
      if (marker) {
        if (current) rows.push(current);
        const body = line.slice(marker[0].length);
        const { html, done } = taskHtml(body);
        current = { key: unique(lineKey(line)), kind: 'item', depth: depthOf(marker[1]), text: body, html, done };
      } else if (current) {
        
        
        current.text += `\n${line.trim()}`;
        current.html += ` ${renderInline(line.trim())}`;
      } else {
        rows.push({ key: unique(lineKey(line)), kind: 'block', depth: 0, text: line, html: renderBlock(line), done: null });
      }
    }
    if (current) rows.push(current);
  }
  return rows;
}

export function threadIdFor(date, block) {
  return `brief-${date}-${block}`;
}

export function threadId(date, key) {
  let hash = 0x811c9dc5;
  for (const char of String(key)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let second = 0x9e3779b9;
  for (const char of String(key)) {
    second = Math.imul(second ^ char.charCodeAt(0), 0x85ebca6b) >>> 0;
  }
  return `brief-${date}-${hash.toString(36)}${second.toString(36)}`;
}

export function threadPrompt({ date, row, comment }) {
  return [
    `From the ${date} morning brief:`,
    '',
    `> ${String(row.text).replace(/^\[[ xX]\]\s*/u, '').split('\n').join('\n> ')}`,
    '',
    `User: ${comment}`,
    '',
    'Act on that. If it is already done, record it and take it off the open loops rather than redoing it.'
  ].join('\n');
}

export function threadTitle(row) {
  const text = String(row.text).replace(/\s+/gu, ' ').replace(/^\[[ xX]\]\s*/u, '').trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text || 'Brief item';
}
