

import { segmentPaths } from './paths.js';

const URL = /\bhttps?:\/\/[^\s<>"'`\\]+/giu;

const TRAILING = /[.,;:!?)\]}'"]+$/u;

const MAX_TEXT = 60_000;
const MAX_REFS = 300;

export function segmentRefs(text, { maxText = MAX_TEXT, maxRefs = MAX_REFS } = {}) {
  if (typeof text !== 'string' || !text) return [];

  
  let head = text;
  let tail = '';
  if (text.length > maxText) {
    const newline = text.lastIndexOf('\n', maxText);
    const cut = newline === -1 ? maxText : newline + 1;
    head = text.slice(0, cut);
    tail = text.slice(cut);
  }

  const out = [];
  let refs = 0;
  const push = (segment) => {
    if (segment.type !== 'text' && refs >= maxRefs) {
      push({ type: 'text', text: segment.text });
      return;
    }
    if (segment.type === 'text') {
      if (!segment.text) return;
      
      
      const last = out.at(-1);
      if (last?.type === 'text') { last.text += segment.text; return; }
      out.push({ type: 'text', text: segment.text });
      return;
    }
    refs += 1;
    out.push(segment);
  };

  let at = 0;
  for (const match of head.matchAll(URL)) {
    const url = match[0].replace(TRAILING, '');
    if (!url || match.index < at) continue;
    if (match.index > at) for (const segment of segmentPaths(head.slice(at, match.index))) push(segment);
    push({ type: 'url', url, text: url });
    at = match.index + url.length;
  }
  if (at < head.length) for (const segment of segmentPaths(head.slice(at))) push(segment);
  if (tail) push({ type: 'text', text: tail });
  return out;
}

export function summarySegments({ tool, input = {}, display = '' } = {}) {
  const url = typeof input.url === 'string' ? input.url : null;
  if (url && display.includes(url)) return [{ type: 'url', url, text: display }];
  // The summary may render the url shortened (host and last segment); keep that text and the real link behind it.
  if (url) return [{ type: 'url', url, text: display || url }];

  const file = input.file_path || input.notebook_path;
  if (typeof file === 'string' && file) {
    
    
    return hasFilename(file) ? [{ type: 'path', path: file, line: null, text: display || file }] : [{ type: 'text', text: display || file }];
  }
  
  
  // A path shortened from the left ("…/webchat/src/lib/server/runner.js") cannot be found again by the path
  // scanner, so the ref is taken from the input and the shortened text is what it shows.
  const path = typeof input.path === 'string' ? input.path : null;
  if (path && display && !display.includes(path) && hasFilename(path)) return [{ type: 'path', path, line: null, text: display }];

  if (tool === 'Grep' || tool === 'Glob') return [{ type: 'text', text: display }];
  return segmentRefs(display);
}

function hasFilename(path) {
  const base = String(path).split('/').pop() || '';
  return base.includes('.');
}
