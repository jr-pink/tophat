

import katex from 'katex';

const escapeHtml = (text) => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export function renderMath(tex, { display = false } = {}) {
  const source = display ? `$$${tex}$$` : `$${tex}$`;
  try {
    const html = katex.renderToString(String(tex), {
      displayMode: display,
      // A parse error renders the source in a muted ink, never KaTeX's red; streaming never gets
      // here half-written because segmentMath only hands over a closed delimiter.
      throwOnError: false,
      errorColor: 'var(--ink-faint, #8a8578)',
      strict: false,
      
      
      trust: false,
      output: 'htmlAndMathml'
    });
    
    
    
    // Always a span, display math included (CSS makes .md-math-display a block): a <div> inside a
    // <p> makes the HTML parser close the paragraph early, which strands the text after the
    // equation and leaves an empty <p></p> behind it.
    const tag = 'span';
    return `<${tag} class="md-math${display ? ' md-math-display' : ''}" data-tex="${escapeHtml(tex)}">${html}</${tag}>`;
  } catch {
    return `<span class="md-math-raw">${escapeHtml(source)}</span>`;
  }
}

export function segmentMath(text) {
  const body = String(text ?? '');
  const out = [];
  let buffer = '';
  let at = 0;

  const flush = () => { if (buffer) { out.push({ type: 'text', value: buffer }); buffer = ''; } };
  const take = (value, display) => { flush(); out.push({ type: 'math', value, display }); };
  // Display math is a block, so the line breaks and spaces around it would only become a blank
  // line or a stray space at a line edge; punctuation written right after the closing delimiter
  // moves inside the equation so it sits at its right edge instead of alone on the next line.
  const takeDisplay = (tex, after) => {
    buffer = buffer.replace(/[ \t]*\n?[ \t]*$/u, '');
    const punct = displayPunctuation(body.slice(after));
    take(withPunctuation(tex, punct), true);
    const next = after + punct.length;
    const gap = body.slice(next).match(/^[ \t]*\n?[ \t]*/u)[0];
    return next + gap.length;
  };

  while (at < body.length) {
    const two = body.slice(at, at + 2);

    if (two === '\\$') { buffer += '$'; at += 2; continue; }

    if (two === '\\[' || two === '\\(') {
      const close = two === '\\[' ? '\\]' : '\\)';
      const end = body.indexOf(close, at + 2);
      if (end !== -1) {
        if (two === '\\[') at = takeDisplay(body.slice(at + 2, end).trim(), end + 2);
        else { take(body.slice(at + 2, end).trim(), false); at = end + 2; }
        continue;
      }
    }

    if (two === '$$') {
      const end = body.indexOf('$$', at + 2);
      if (end !== -1) { at = takeDisplay(body.slice(at + 2, end).trim(), end + 2); continue; }
    }

    if (body[at] === '$') {
      const end = closingDollar(body, at);
      if (end !== -1) { take(body.slice(at + 1, end).trim(), false); at = end + 1; continue; }
    }

    buffer += body[at];
    at += 1;
  }

  flush();
  return out;
}

function closingDollar(body, start) {
  const next = body[start + 1];
  if (!next || /[\s$]/u.test(next)) return -1;
  for (let at = start + 1; at < body.length; at += 1) {
    const ch = body[at];
    if (ch === '\n') return -1;
    if (ch === '\\') { at += 1; continue; }
    if (ch !== '$') continue;
    // A dollar after a space cannot close; it is the next opener ("pay $50 for $x^2$"), so this
    // one was a price and the scan restarts there.
    if (/\s/u.test(body[at - 1])) return -1;
    if (/\d/u.test(body[at + 1] || '')) continue;
    return at;
  }
  return -1;
}

// Sentence punctuation written straight after a display equation ("$$E = mc^2$$." or "$$x$$)."),
// with no space between: typeset convention puts it inside the display, at the equation's edge.
const DISPLAY_PUNCT = /^[)\]"'\u2019\u201d]*[.,;:?!][.,;:?!)\]"'\u2019\u201d]*/u;

export function displayPunctuation(rest) {
  return String(rest ?? '').match(DISPLAY_PUNCT)?.[0] ?? '';
}

export function withPunctuation(tex, punct) {
  if (!punct) return tex;
  const escaped = punct.replace(/[\\{}]/gu, (ch) => `\\${ch}`);
  return `${tex}\\text{${escaped}}`;
}

export function displayMath(block) {
  const trimmed = String(block).trim();
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]']]) {
    if (!trimmed.startsWith(open)) continue;
    // A block that is one equation plus its closing punctuation ("$$x$$.") is still one equation.
    const tail = trimmed.match(/[.,;:?!)\]"'\u2019\u201d]+$/u)?.[0] ?? '';
    let cut = '';
    for (let i = 0; i < tail.length && !cut; i += 1) {
      const candidate = tail.slice(i);
      const rest = trimmed.slice(0, -candidate.length);
      if (rest.endsWith(close) && rest.length >= open.length + close.length && displayPunctuation(candidate) === candidate) cut = candidate;
    }
    const body = cut ? trimmed.slice(0, -cut.length) : trimmed;
    const closed = body.length >= open.length + close.length && body.endsWith(close);
    
    
    
    if (closed && body.slice(open.length, -close.length).includes(close)) return null;
    return { tex: closed ? withPunctuation(body.slice(open.length, -close.length).trim(), cut) : body.slice(open.length), closed };
  }
  return null;
}

// Paragraphs for pages with no markdown renderer (the public share page): blank-line separated
// prose, and fenced code kept whole (blank lines included) and flagged so no math touches it.
export function textBlocks(text) {
  const out = [];
  let fence = null;
  let lines = [];
  const prose = () => {
    for (const para of lines.join('\n').split(/\n{2,}/u)) if (para.trim()) out.push({ code: false, text: para.trim() });
    lines = [];
  };
  for (const line of String(text ?? '').split('\n')) {
    const marker = line.match(/^\s*(```|~~~)/u)?.[1];
    if (fence) {
      lines.push(line);
      if (marker === fence) { out.push({ code: true, text: lines.join('\n') }); lines = []; fence = null; }
      continue;
    }
    if (marker) { prose(); fence = marker; lines = [line]; continue; }
    lines.push(line);
  }
  if (fence) out.push({ code: true, text: lines.join('\n') });
  else prose();
  return out;
}

// One prose paragraph to HTML: backtick spans stay literal, closed math delimiters render, the
// rest is escaped.
export function mathInline(text) {
  return String(text).split(/(`[^`\n]*`)/u).map((part) => (part.startsWith('`') && part.length > 1 && part.endsWith('`')
    ? escapeHtml(part)
    : segmentMath(part).map((s) => (s.type === 'math' ? renderMath(s.value, { display: s.display }) : escapeHtml(s.value))).join('')
  )).join('');
}
