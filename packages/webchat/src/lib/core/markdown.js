

import { foldVideoRuns, mediaKind, remoteImageUrl, richBlock } from './rich-content.js';
import { isRemoteImage, segmentPaths, wholePath } from './paths.js';
import { highlightHtml } from './highlight.js';
import { displayMath, renderMath, segmentMath } from './math.js';

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pathSpan(segment) {
  const attrs = `data-path="${escapeHtml(segment.path)}"${segment.line ? ` data-line="${segment.line}"` : ''}`;
  return `<button type="button" class="md-path" ${attrs}>${escapeHtml(segment.text)}</button>`;
}

function linkify(text) {
  return segmentPaths(text)
    .map((segment) => (segment.type === 'path' ? pathSpan(segment) : escapeHtml(segment.text)))
    .join('');
}

export function renderInline(line) {
  const parts = String(line).split(/(`[^`]*`?)/u);
  return parts
    .map((part) => {
      if (part.startsWith('`')) {
        const body = part.replace(/^`|`$/gu, '');
        // A path with spaces in backticks is one link, not the fragment after its last space.
        const whole = wholePath(body);
        if (whole && whole.text === body.trim()) return `<code>${escapeHtml(body.slice(0, body.indexOf(whole.text)))}${pathSpan(whole)}${escapeHtml(body.slice(body.indexOf(whole.text) + whole.text.length))}</code>`;
        const segments = segmentPaths(body);
        const inner = segments.some((s) => s.type === 'path')
          ? segments.map((s) => (s.type === 'path' ? pathSpan(s) : escapeHtml(s.text))).join('')
          : escapeHtml(body);
        return `<code>${inner}</code>`;
      }
      
      
      
      
      return segmentMath(part)
        .map((segment) => (segment.type === 'math'
          ? renderMath(segment.value, { display: segment.display })
          : inlineProse(segment.value)))
        .join('');
    })
    .join('');
}


// Markdown links and images inside a line, taken out before anything else touches the text so the
// path linker cannot cut their targets up: `[name](path with spaces.md)`, `[x](<a b/c.md>)`,
// `![alt](https://cdn/x.jpg)` mid-sentence. Each becomes a placeholder, and the rendered HTML goes
// back in at the end, so bold and italics around a link still pair up.
const INLINE_LINK = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)/gu;

function attr(value) {
  return escapeHtml(value);
}

function localFileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}&raw=1`;
}

function renderLink(bang, label, rawTarget) {
  const target = rawTarget.replace(/^<|>$/gu, '').trim();
  const remote = /^https?:\/\//iu.test(target);
  if (bang) {
    if (!remote && /^[a-z][a-z\d+.-]*:/iu.test(target)) return null;
    const src = remote ? remoteImageUrl(target) : localFileUrl(target);
    const kind = remote ? 'image' : mediaKind(target);
    if (kind !== 'image') return `<button type="button" class="md-path md-named" data-path="${attr(target)}">${escapeHtml(label || target)}</button>`;
    return `<button type="button" class="md-path md-inline-image" data-path="${attr(target)}"><img src="${attr(src)}" alt="${attr(label)}" loading="lazy" /></button>`;
  }
  if (remote) {
    const quick = isRemoteImage(target) ? ` class="md-path md-named" data-path="${attr(target)}"` : '';
    return `<a href="${attr(target)}" target="_blank" rel="noreferrer noopener"${quick}>${escapeHtml(label)}</a>`;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|#)/iu.test(target)) return null;
  const located = target.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/u);
  const line = located[2] ? ` data-line="${located[2]}"` : '';
  return `<button type="button" class="md-path md-named" data-path="${attr(located[1])}"${line}>${escapeHtml(label || target)}</button>`;
}

function inlineProse(part) {
  const held = [];
  const text = String(part).replace(INLINE_LINK, (whole, bang, label, target) => {
    const html = renderLink(bang, label, target);
    if (html === null) return whole;
    held.push(html);
    return `\u0001${held.length - 1}\u0002`;
  });
  return linkify(text)
        .replace(/(^|\W)\*\*([^*]+)\*\*/gu, '$1<strong>$2</strong>')
        .replace(/(^|\W)__([^_]+)__/gu, '$1<strong>$2</strong>')
        .replace(/(^|\W)\*([^*\n]+)\*/gu, '$1<em>$2</em>')
        // A URL may follow <strong>/<em> from the passes above, so a bolded link still links.
        .replace(/(^|\s|<(?:strong|em)>)(https?:\/\/[^\s<\u0001]+)/gu, (whole, lead, url) => {
          const clean = url.replace(/[.,;:!?)]+$/u, '');
          const rest = url.slice(clean.length);
          const quick = isRemoteImage(clean.replaceAll('&amp;', '&')) ? ` class="md-path md-named" data-path="${clean}"` : '';
          return `${lead}<a href="${clean}" target="_blank" rel="noreferrer noopener"${quick}>${clean}</a>${rest}`;
        })
        .replace(/\u0001(\d+)\u0002/gu, (whole, index) => held[Number(index)] ?? '');
}

export function splitBlocks(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let buffer = [];
  let fence = null;

  const flush = () => {
    while (buffer.length && buffer.at(-1).trim() === '') buffer.pop();
    if (buffer.length) blocks.push(buffer.join('\n'));
    buffer = [];
  };

  
  
  
  
  
  let math = null;
  const mathOpen = (line) => {
    const body = line.trim();
    if (body.startsWith('$$')) return body.length > 2 && body.endsWith('$$') ? null : '$$';
    if (body.startsWith('\\[')) return body.endsWith('\\]') ? null : '\\]';
    return null;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```|~~~)(.*)$/u);
    if (fence) {
      buffer.push(line);
      if (fenceMatch && fenceMatch[1] === fence) { flush(); fence = null; }
      continue;
    }
    if (math) {
      buffer.push(line);
      if (line.trim().endsWith(math)) { flush(); math = null; }
      continue;
    }
    if (fenceMatch) { flush(); fence = fenceMatch[1]; buffer.push(line); continue; }
    if (/^\s*(?:\$\$|\\\[)/u.test(line)) {
      flush();
      buffer.push(line);
      math = mathOpen(line);
      if (!math) flush();
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    // An image on a line of its own is its own block, wherever it sits: right after a bold lead-in line
    // ("**Husarion ROSbot XL**\n![...](/path.jpg)"), after a sentence, between list items. It used to
    // join the paragraph above it, which made the block no longer exactly one image, so richBlock
    // declined it and the inline pass printed the markup with the path as a code-style link. Flush-left
    // only, so an indented continuation inside a list item stays in its item.
    if (/^(?:!\[|<video\b)/iu.test(line) && richBlock(line.trimEnd())) { flush(); blocks.push(line.trimEnd()); continue; }
    
    
    
    
    if (/^\s{0,3}#{1,6}\s/u.test(line)) { flush(); blocks.push(line); continue; }
    
    if (buffer.length && /^\s*(?:[-*+]|\d+[.)])\s+/u.test(line) && !/^\s*(?:[-*+]|\d+[.)])\s+/u.test(buffer[0])) flush();
    
    
    
    
    
    
    if (buffer.length && /^\s*>/u.test(line) && !/^\s*>/u.test(buffer[0])) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

const MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+/u;

function renderItem(text) {
  const box = text.match(/^\[( |x|X)\]\s+/u);
  if (!box) return `<li>${renderInline(text)}</li>`;
  const done = box[1].toLowerCase() === 'x';
  return `<li class="md-task${done ? ' md-done' : ''}">`
    + `<span class="md-box" aria-hidden="true">${done ? '✓' : ''}</span>`
    + `<span>${renderInline(text.slice(box[0].length))}</span></li>`;
}

function renderList(lines, ordered) {
  const base = (lines[0].match(MARKER) || ['', ''])[1].length;
  const items = [];
  for (const line of lines) {
    const m = line.match(MARKER);
    if (m && m[1].length <= base) items.push({ text: line.slice(m[0].length), children: [] });
    else if (items.length) items.at(-1).children.push(line.replace(new RegExp(`^\\s{0,${base + 2}}`, 'u'), ''));
    else items.push({ text: line.trim(), children: [] });
  }
  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((item) => {
    const child = item.children.length && MARKER.test(item.children[0])
      ? renderList(item.children, /^\s*\d/u.test(item.children[0]))
      : '';
    const text = child ? item.text : [item.text, ...item.children.map((l) => l.trim())].join('\n');
    return renderItem(text).replace(/<\/li>$/u, `${child}</li>`);
  }).join('');
  return `<${tag}>${body}</${tag}>`;
}


const LANG_ALIAS = {
  js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', svelte: 'js', mjs: 'js', cjs: 'js',
  json: 'json', py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
  css: 'css', scss: 'css', sql: 'sql', html: 'html', xml: 'html', yml: 'sh', yaml: 'sh', toml: 'sh'
};

export function renderBlock(block) {
  const lines = block.split('\n');
  const fence = lines[0].match(/^\s*(?:```|~~~)(.*)$/u);
  if (fence) {
    const lang = fence[1].trim().split(/\s+/u)[0] || '';
    const closed = lines.length > 1 && /^\s*(?:```|~~~)\s*$/u.test(lines.at(-1));
    const body = lines.slice(1, closed ? -1 : undefined).join('\n');
    
    
    
    const inner = lang ? highlightHtml(body, LANG_ALIAS[lang.toLowerCase()] || null) : escapeHtml(body);
    return `<pre class="md-code${closed ? '' : ' md-code-open'}"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><button type="button" class="md-copy" data-copy aria-label="Copy code" title="Copy"><svg class="md-copy-i" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg><svg class="md-copy-ok" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></button><code>${inner}</code></pre>`;
  }
  
  
  
  const math = displayMath(block);
  if (math) {
    return math.closed
      ? `<div class="md-math-block">${renderMath(math.tex, { display: true })}</div>`
      : `<div class="md-math-block md-math-open"><span class="md-math-raw">${escapeHtml(block.trim())}</span></div>`;
  }
  const heading = lines[0].match(/^(#{1,6})\s+(.*)$/u);
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    return `<h${level}>${renderInline(heading[2])}</h${level}>`;
  }
  if (lines.every((line) => /^\s*\|.*\|\s*$/u.test(line)) && lines.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[1])) {
    const row = (line, tag) => `<tr>${line.trim().slice(1, -1).split('|').map((cell) => `<${tag}>${renderInline(cell.trim())}</${tag}>`).join('')}</tr>`;
    return `<table><thead>${row(lines[0], 'th')}</thead><tbody>${lines.slice(2).map((line) => row(line, 'td')).join('')}</tbody></table>`;
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (lines.every((line) => /^\s*>/u.test(line))) {
    const inner = lines.map((line) => line.replace(/^\s*>[ \t]?/u, '')).join('\n');
    return `<blockquote>${splitBlocks(inner).map((part) => renderBlock(part)).join('')}</blockquote>`;
  }
  if (/^\s*[-*+]\s+/u.test(lines[0])) return renderList(lines, false);
  if (/^\s*\d+[.)]\s+/u.test(lines[0])) return renderList(lines, true);
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(block)) return '<hr />';
  if (heading) return lines.map((line) => `<p>${renderInline(line)}</p>`).join('');
  return `<p>${softBreaks(renderInline(lines.join('\n')))}</p>`;
}

// A single newline inside a paragraph is a line break the author typed, not a space: HTML would
// otherwise collapse it and run a sign-off into the line above. Inline markup is rendered first so
// a span that crosses the break keeps its tags.
function softBreaks(html) {
  return html.replace(/\n/gu, '<br />');
}

// <details> / <summary> blocks: a collapsible section whose body is ordinary markdown (widgets and
// figures included), written flush-left on lines of their own:
//   <details>            (or <details open>)
//   <summary>**1. Memory**</summary>
//   ...any blocks...
//   </details>
// They nest, and an unclosed one (a reply still streaming) shows what has arrived. The summary is
// inline markdown; the body is compiled like a message, so a widget inside stays a live widget.
const DETAILS_OPEN = /^<details(\s+open)?\s*>\s*$/iu;
const DETAILS_SUMMARY = /^<summary>(.*)<\/summary>\s*$/iu;
const DETAILS_CLOSE = /^<\/details>\s*$/iu;

function detailsTokens(blocks) {
  const tokens = [];
  for (const block of blocks) {
    if (/^\s*(?:```|~~~|\$\$|\\\[)/u.test(block) || !/^<\/?(?:details|summary)\b/imu.test(block)) { tokens.push({ text: block }); continue; }
    let run = [];
    const flush = () => { if (run.length) tokens.push({ text: run.join('\n') }); run = []; };
    for (const line of block.split('\n')) {
      let m;
      if ((m = line.match(DETAILS_OPEN))) { flush(); tokens.push({ open: Boolean(m[1]) }); }
      else if ((m = line.match(DETAILS_SUMMARY))) { flush(); tokens.push({ summary: m[1] }); }
      else if (DETAILS_CLOSE.test(line)) { flush(); tokens.push({ close: true }); }
      else run.push(line);
    }
    flush();
  }
  return tokens;
}

function compileLeaves(blocks, cache, prefix) {
  // Adjacent video embeds become one gallery player; its key stays the first block's so the player
  // (and what is playing) survives the next embed streaming in.
  return foldVideoRuns(blocks.map((block, index) => {
    let html = cache.get(block);
    if (html === undefined) {
      html = renderBlock(block);
      cache.set(block, html);
    }
    return { key: `${prefix}${index}:${block.length}`, html, rich: richBlock(block) };
  }));
}

export function compileMarkdown(text, cache = new Map()) {
  const blocks = splitBlocks(text);
  if (!blocks.some((b) => /^<details\b/imu.test(b))) return compileLeaves(blocks, cache, '');
  const root = { items: [], pending: [], prefix: '' };
  const stack = [root];
  const settle = (node) => { if (node.pending.length) { node.items.push(...compileLeaves(node.pending, cache, `${node.prefix}${node.items.length}.`)); node.pending = []; } };
  for (const token of detailsTokens(blocks)) {
    const top = stack.at(-1);
    if ('text' in token) { top.pending.push(token.text); continue; }
    if ('open' in token) {
      settle(top);
      const node = { key: `${top.prefix}d${top.items.length}`, details: true, open: token.open, summary: '', items: [], pending: [] };
      node.prefix = node.key + '/';
      top.items.push(node); stack.push(node); continue;
    }
    if ('summary' in token) { if (stack.length > 1 && !top.summary && !top.items.length && !top.pending.length) top.summary = renderInline(token.summary); else top.pending.push(`<summary>${token.summary}</summary>`); continue; }
    if (stack.length > 1) { settle(top); stack.pop(); } // a stray </details> outside any section is dropped
  }
  for (const node of stack) settle(node);
  const finish = (items) => items.map((it) => (it.details ? { key: it.key, details: true, open: it.open, summary: it.summary || 'Details', children: finish(it.items) } : it));
  return finish(root.items);
}

/** Every leaf block of a compiled message, details bodies included, in reading order. */
export function flatBlocks(blocks) {
  return blocks.flatMap((b) => (b.details ? flatBlocks(b.children) : [b]));
}

export function createMarkdownCache() {
  const cache = new Map();
  return {
    compile: (text) => compileMarkdown(text, cache),
    get size() { return cache.size; }
  };
}
