

const WORD = '[A-Za-z_$][\\w$]*';
const NUMBER = '\\b\\d[\\d_.]*(?:[eE][+-]?\\d+)?\\b';

const KEYWORDS = {
  js: 'const let var function return if else for while do break continue new class extends super this import export from as default async await try catch finally throw typeof instanceof in of delete void yield static get set null undefined true false',
  py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False self async await',
  sh: 'if then else elif fi for while do done case esac function return export local readonly set unset echo cd exit source shift trap',
  sql: 'select from where join left right inner outer on group by order having limit offset insert into values update set delete create table drop alter index as and or not null distinct union all',
  json: 'true false null',
  css: '',
  html: ''
};

const RULES = {
  js: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'] },
  py: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"] },
  sh: { line: ['#'], block: [], quotes: ['"', "'"] },
  css: { line: [], block: [['/*', '*/']], quotes: ['"', "'"] },
  json: { line: [], block: [], quotes: ['"'] },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: ["'"] },
  html: { line: [], block: [['<!--', '-->']], quotes: ['"', "'"] }
};

const BY_EXTENSION = {
  js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', svelte: 'js', json: 'json', jsonl: 'json',
  py: 'py', sh: 'sh', zsh: 'sh', bash: 'sh', css: 'css', scss: 'css', sql: 'sql',
  html: 'html', xml: 'html', svg: 'html', yml: 'sh', yaml: 'sh', toml: 'sh', conf: 'sh', ini: 'sh',
  rs: 'js', go: 'js', c: 'js', h: 'js', cpp: 'js', java: 'js', swift: 'js', rb: 'py', php: 'js'
};

export function languageOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()] || null;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const compiled = new Map();

function scanner(lang) {
  if (compiled.has(lang)) return compiled.get(lang);
  const rules = RULES[lang];
  if (!rules) return null;
  const parts = [];
  for (const [open, close] of rules.block) parts.push(`${escape(open)}[\\s\\S]*?(?:${escape(close)}|$)`);
  for (const marker of rules.line) parts.push(`${escape(marker)}[^\\n]*`);
  for (const quote of rules.quotes) {
    const q = escape(quote);
    parts.push(`${q}(?:\\\\.|[^${q}\\\\\\n])*${q}?`);
  }
  parts.push(NUMBER, WORD);
  const found = { rx: new RegExp(parts.join('|'), 'gu'), rules, words: new Set((KEYWORDS[lang] || '').split(/\s+/u).filter(Boolean)) };
  compiled.set(lang, found);
  return found;
}

function classify(text, { rules, words }) {
  for (const [open] of rules.block) if (text.startsWith(open)) return 'comment';
  for (const marker of rules.line) if (text.startsWith(marker)) return 'comment';
  for (const quote of rules.quotes) if (text.startsWith(quote)) return 'string';
  if (/^\d/u.test(text)) return 'number';
  return words.has(text) ? 'keyword' : 'text';
}

const MAX_HIGHLIGHT = 400_000;

export function tokenize(text, lang) {
  const source = String(text ?? '');
  const found = lang && source.length <= MAX_HIGHLIGHT ? scanner(lang) : null;
  if (!found) return source ? [{ type: 'text', text: source }] : [];

  const out = [];
  let at = 0;
  for (const match of source.matchAll(found.rx)) {
    if (match.index > at) out.push({ type: 'text', text: source.slice(at, match.index) });
    const type = classify(match[0], found);
    out.push({ type, text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < source.length) out.push({ type: 'text', text: source.slice(at) });
  return out;
}

let memoText = null;
let memoLang = null;
let memoLines = null;

export function tokenizeLines(text, lang) {
  if (memoLines && memoText === text && memoLang === lang) return memoLines;
  const lines = [[]];
  for (const token of tokenize(text, lang)) {
    const pieces = token.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece) lines.at(-1).push({ type: token.type, text: piece });
    });
  }
  memoText = text;
  memoLang = lang;
  memoLines = lines;
  return lines;
}

export const warmTokens = (text, lang) => {
  if (typeof text === 'string' && text) tokenizeLines(text, lang);
};

const escapeHtml = (text) => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export function highlightHtml(text, lang) {
  const tokens = tokenize(text, lang);
  return tokens
    .map((token) => (token.type === 'text' ? escapeHtml(token.text) : `<span class="tok-${token.type}">${escapeHtml(token.text)}</span>`))
    .join('');
}

export function mayHoldRef(token) {
  if (token.type === 'keyword' || token.type === 'number') return false;
  return token.text.includes('/') || /\.\w{1,9}\b/u.test(token.text);
}
