
import { partialJsonString } from './partial-json.js';

const MAX = 200;

// The same webchat serves the rev5 runner and the claude / codex / kimi CLI providers, so the map
// carries both vocabularies: rev5's snake_case tools and the CLI's capitalised ones.
const ICONS = {
  // rev5
  shell: 'bash',
  job_status: 'clock', job_wait: 'clock', job_cancel: 'clock',
  read_file: 'read', read_document: 'read',
  write_file: 'write',
  list_files: 'folder',
  search_files: 'grep',
  memory_search: 'memory', memory_read: 'memory', memory_apply: 'memory',
  source_search: 'search',
  web_search: 'web', web_open: 'web', web_find: 'web',
  mail_search: 'mail', mail_read: 'mail', mail_send: 'mail',
  messages_recent: 'message',
  Agent: 'agent', agent_send: 'agent', agent_list: 'agent', agent_wait: 'agent', agent_cancel: 'agent',
  // claude / codex CLI
  Read: 'read', Write: 'write', Edit: 'write', NotebookEdit: 'write',
  Bash: 'bash', Grep: 'grep', Glob: 'grep',
  WebFetch: 'web', WebSearch: 'web', Task: 'agent',
  TodoWrite: 'write'
};

// Families that are named by prefix rather than one by one.
const PREFIX_ICONS = [
  ['browser_', 'web'],
  ['credential_', 'key'],
  ['memory_', 'memory'],
  ['mail_', 'mail'],
  ['agent_', 'agent'],
  ['job_', 'clock'],
  ['web_', 'web']
];

export function toolIcon(tool) {
  const name = typeof tool === 'string' ? tool : '';
  if (ICONS[name]) return ICONS[name];
  for (const [prefix, icon] of PREFIX_ICONS) if (name.startsWith(prefix)) return icon;
  return 'tool';
}

// ── safety ───────────────────────────────────────────────────────────────────────────────────────
// The header is the one part of a tool call that is on screen whether or not the card is open, so
// anything that looks like a credential is replaced before it can be rendered. The patterns are
// deliberately shape-based (known token prefixes, a value behind a secret-ish name) rather than
// "long random string", so a git sha or a hash in a path survives.
const REDACTED = '[redacted]';
const SECRETS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{12,}/gu,
  /\bAIza[0-9A-Za-z_-]{20,}/gu,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/gu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/giu
];
const SECRET_NAMED = /\b([A-Za-z_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|authorization|auth[_-]?key)[A-Za-z_-]*\s*[=:]\s*)(["']?)[^\s"',;)}]{3,}\2?/giu;

function safe(text) {
  let out = String(text);
  out = out.replace(SECRET_NAMED, (_m, name) => `${name}${REDACTED}`);
  for (const pattern of SECRETS) out = out.replace(pattern, REDACTED);
  return out;
}

// ── small formatters ─────────────────────────────────────────────────────────────────────────────
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}

function cap(text, max = MAX) {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function join(parts) {
  return parts.filter(Boolean).join(' · ');
}

const PATH_MAX = 44;

// A path is read from the right: the file and the directories immediately over it say which file is
// meant, the /Users/<name>/projects prefix never does. Whole segments are dropped from the left
// until what is left fits, so the result is stable for the same input.
function shortenPath(path, max = PATH_MAX) {
  const text = String(path);
  if (text.length <= max) return text;
  const trailing = text.endsWith('/') ? '/' : '';
  const parts = text.replace(/\/+$/u, '').split('/').filter(Boolean);
  if (!parts.length) return cap(text, max);
  // /Users/<name> is one unit: a path never usefully begins with the account name.
  if (parts[0] === 'Users' && parts.length > 2) parts.splice(0, 2, `Users/${parts[1]}`);
  let out = parts.at(-1);
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}/${out}`;
    if (candidate.length + 2 > max) break;
    out = candidate;
  }
  return `…/${out}${trailing}`;
}

// Hosts carry the meaning in a URL, so a long one keeps its host and its last segment.
function shortenUrl(url, max = PATH_MAX + 12) {
  const text = String(url);
  if (text.length <= max) return text;
  const match = /^([a-z]+:\/\/)?([^/?#]+)(\/[^?#]*)?/iu.exec(text);
  if (!match) return cap(text, max);
  const host = match[2].replace(/^www\./u, '');
  const segments = (match[3] || '').split('/').filter(Boolean);
  const last = segments.at(-1) || '';
  const head = segments.length > 1 ? `${host}/…/` : `${host}/`;
  return cap(`${head}${last}`, max);
}

// host + path, with the scheme and the www. dropped: "kogenbudo.org/the-essence-of-martial-arts/".
function hostAndPath(url) {
  const text = clean(url);
  if (!text) return '';
  const match = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?/iu.exec(text);
  if (!match) return cap(text, PATH_MAX);
  const host = match[2].replace(/^www\./u, '');
  const path = match[3] || '';
  const query = match[4] ? '?…' : '';
  const whole = `${host}${path}${query}`;
  if (whole.length <= PATH_MAX + 12) return whole;
  return shortenUrl(whole, PATH_MAX + 12);
}

function fileName(path) {
  const parts = String(path).replace(/\/+$/u, '').split('/');
  return parts.at(-1) || String(path);
}

function bytes(count) {
  if (!Number.isFinite(count) || count < 0) return '';
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function byteLength(text) {
  if (typeof text !== 'string') return null;
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

// ── the shell chain ──────────────────────────────────────────────────────────────────────────────
// the owner's ask: a chained command truncated to its head reads the same on every card. So the
// header shows the *shape* of the command — every stage of the chain, each one down to its program
// and its most identifying argument.
const SEP = ' › ';
const STAGE_SOFT = 44; // a stage longer than this is compressed to its operative parts
const STAGE_HARD = 56; // and is never rendered longer than this
const HEREDOC_OPEN = '\u0000<<';
const HEREDOC_CLOSE = '\u0000';

const KEYWORD_DROP = new Set(['done', 'fi', 'esac', 'else', 'elif', ';;', 'end']);
const KEYWORD_SKIP = new Set(['do', 'then', 'time', 'exec', 'command', 'nohup']);
// Inside a chain there is no room for a full path, and the tail of one is what names the file.
const TOKEN_PATH_MAX = 24;
// For these the first bare argument is the pattern or the program text, which says more than the
// file it is run over — `grep -E '^not ok'`, not `grep pull.test.mjs`.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'jq', 'perl']);

/**
 * Split a command into its pipeline / list stages. Quotes, escapes, $( ) and backticks hold
 * together, so a `&&` inside a string is not an operator; a heredoc swallows its body and leaves a
 * marker with the line count behind.
 */
function splitStages(command) {
  const text = String(command);
  const stages = [];
  let buf = '';
  let heredocs = [];
  const pending = [];
  let quote = null;
  let depth = 0;
  let i = 0;

  const flush = () => {
    const stage = buf.trim();
    if (stage) stages.push({ text: stage, heredocs });
    buf = '';
    heredocs = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { buf += ch + (text[i + 1] ?? ''); i += 2; continue; }
      if (ch === quote) quote = null;
      buf += ch; i += 1; continue;
    }
    if (ch === '\\') {
      if (text[i + 1] === '\n') { buf += ' '; i += 2; continue; }
      buf += ch + (text[i + 1] ?? ''); i += 2; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; buf += ch; i += 1; continue; }
    if (ch === '$' && text[i + 1] === '(') { depth += 1; buf += '$('; i += 2; continue; }
    if (ch === '(') { depth += 1; buf += ch; i += 1; continue; }
    if (ch === ')') { if (depth > 0) depth -= 1; buf += ch; i += 1; continue; }
    if (depth > 0) { buf += ch; i += 1; continue; }

    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const open = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w.-]*))/u.exec(text.slice(i));
      if (open) {
        const tag = open[1] || open[2] || open[3];
        pending.push(tag);
        buf += `${HEREDOC_OPEN}${tag}${HEREDOC_CLOSE}`;
        i += open[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      if (pending.length) {
        let rest = text.slice(i + 1);
        while (pending.length) {
          const tag = pending.shift();
          const lines = rest.split('\n');
          let n = 0;
          while (n < lines.length && lines[n].trim() !== tag) n += 1;
          heredocs.push({ tag, lines: n });
          rest = lines.slice(n + 1).join('\n');
        }
        i = text.length - rest.length;
        flush();
        continue;
      }
      flush(); i += 1; continue;
    }
    if (ch === '&' && (text[i + 1] === '>' || /[>0-9]$/u.test(buf))) { buf += ch; i += 1; continue; }
    if (ch === '&' && text[i + 1] === '&') { flush(); i += 2; continue; }
    if (ch === '|' && text[i + 1] === '|') { flush(); i += 2; continue; }
    if (ch === '|' || ch === ';' || ch === '&') { flush(); i += 1; continue; }
    buf += ch; i += 1;
  }
  flush();
  return stages;
}

// Whitespace split that keeps quoted runs (and their quotes, so `grep -E '^not ok'` still reads
// like the command that was run) in one piece.
function splitTokens(text) {
  const tokens = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; buf += ch; continue; }
    if (/\s/u.test(ch)) { if (buf) tokens.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

// Redirections: /dev/null and stderr plumbing are noise, a real output file is not.
function dropRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d*>&\d*-?$/u.test(token)) continue;
    if (/^(?:\d*|&)>>?$/u.test(token)) {
      const target = tokens[i + 1] || '';
      i += 1;
      if (!target || /\/dev\/null$/u.test(target) || token.startsWith('2') || token.startsWith('&')) continue;
      out.push('>', target);
      continue;
    }
    const attached = /^(\d*|&)(>>?)(.+)$/u.exec(token);
    if (attached) {
      if (/\/dev\/null$/u.test(attached[3]) || attached[1] === '2' || attached[1] === '&') continue;
      out.push('>', attached[3]);
      continue;
    }
    if (token === '<') { i += 1; continue; }
    if (/^<[^<]/u.test(token)) continue;
    out.push(token);
  }
  return out;
}

function isHeredoc(token) {
  return token.startsWith(HEREDOC_OPEN);
}

function heredocLabel(token, heredocs) {
  const tag = token.slice(HEREDOC_OPEN.length, -HEREDOC_CLOSE.length);
  const found = heredocs.find((h) => h.tag === tag);
  if (!found?.lines) return `<<${tag}`;
  return `<<${tag} (${found.lines} ${found.lines === 1 ? 'line' : 'lines'})`;
}

function looksLikeUrl(token) {
  return /^["']?[a-z][a-z0-9+.-]*:\/\//iu.test(token);
}

// One token, as short as it can be while still naming what it names.
function shortenToken(token) {
  const quoted = /^(["'])(.*)\1$/u.exec(token);
  if (quoted) {
    const inner = shortenToken(quoted[2]);
    return `${quoted[1]}${inner}${quoted[1]}`;
  }
  if (looksLikeUrl(token)) return shortenUrl(token);
  if (token.includes('/') && token.length > TOKEN_PATH_MAX) return shortenPath(token, TOKEN_PATH_MAX);
  return token;
}

// Which argument identifies the stage: a URL beats a path beats a filename beats a quoted pattern.
function argScore(token, previous) {
  if (isHeredoc(token)) return -1;
  if (token.startsWith('-')) return -1;
  if (looksLikeUrl(token)) return 5;
  if (token.includes('/')) return 4;
  if (/\.[A-Za-z0-9]{1,6}$/u.test(token)) return 3;
  if (/^["'`]/u.test(token)) return 2;
  if (/^[-+]?\d+$/u.test(token)) return 0;
  // A bare word right after a flag is usually that flag's value, not the subject.
  return previous && previous.startsWith('-') ? 0 : 1;
}

function renderStage(stage, hard = STAGE_HARD) {
  let tokens = dropRedirections(splitTokens(stage.text));
  while (tokens.length && KEYWORD_SKIP.has(tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return '';
  if (tokens.length === 1 && KEYWORD_DROP.has(tokens[0])) return '';
  if (tokens[0] === 'set') return '';
  // Leading env assignments say how, not what.
  while (tokens.length > 1 && ASSIGNMENT.test(tokens[0]) && !isHeredoc(tokens[0])) tokens = tokens.slice(1);
  // A stage that is only an assignment (UA="Mozilla/5.0 …") is worth its name and nothing else.
  if (tokens.length === 1 && ASSIGNMENT.test(tokens[0])) return `${tokens[0].split('=')[0]}=…`;

  const parts = tokens.map((token) => (isHeredoc(token) ? heredocLabel(token, stage.heredocs) : shortenToken(token)));
  const whole = parts.join(' ');
  if (whole.length <= STAGE_SOFT) return whole;

  // Too long to show whole: program, the flag that qualifies the argument, the argument.
  const program = parts[0];
  const heredoc = tokens.findIndex(isHeredoc);
  if (heredoc > 0) {
    const label = heredocLabel(tokens[heredoc], stage.heredocs);
    return cap(`${program} ${label}`, hard);
  }
  let best = -1;
  let bestScore = 0;
  const patternFirst = PATTERN_FIRST.has(fileName(tokens[0]));
  for (let i = 1; i < tokens.length; i += 1) {
    const score = argScore(tokens[i], tokens[i - 1]);
    if (score > bestScore) { bestScore = score; best = i; }
    if (patternFirst && score > 0) { best = i; break; }
  }
  if (best === -1) return cap(program, hard);
  // `npx vitest run …` keeps its subcommands: the bare words between the program and its argument.
  const subcommands = [];
  for (let i = 1; i < best && subcommands.length < 2; i += 1) {
    const token = tokens[i];
    if (token.startsWith('-') || token.length > 12 || /[/'"`=]/u.test(token) || /^\d/u.test(token)) continue;
    subcommands.push(token);
  }
  const flag = best > 1 && tokens[best - 1].startsWith('-') && tokens[best - 1].length <= 8 ? `${parts[best - 1]} ` : '';
  return cap([program, ...subcommands, `${flag}${parts[best]}`].join(' '), hard);
}

// A stage narrower than this says nothing, so the chain elides a stage instead of shaving them all.
const MIN_STAGE = 26;

// Last resort before truncating: a path in a stage goes down to its file name, a URL to its host.
function tighten(text, max) {
  if (text.length <= max) return text;
  const smaller = text
    .split(' ')
    .map((token) => {
      if (looksLikeUrl(token)) return shortenUrl(token, Math.max(12, Math.floor(max / 2)));
      if (!token.includes('/')) return token;
      return fileName(token.replace(/^…\//u, ''));
    })
    .join(' ');
  return cap(smaller, max);
}

function shellChain(command, budget) {
  const stages = splitStages(command);
  // A command with one stage may spend the whole line on it; a chain of ten may not.
  const hard = Math.max(STAGE_HARD, Math.floor(budget / Math.max(1, stages.length)));
  // Consecutive identical stages (the same `cd` twice in a chain) say nothing the first did not.
  const rendered = stages
    .map((stage) => renderStage(stage, hard))
    .filter((stage, i, all) => stage && stage !== all[i - 1]);
  if (!rendered.length) return cap(clean(command), budget);

  const whole = rendered.join(SEP);
  if (whole.length <= budget) return whole;

  // It does not fit. Keep as many stages as can still be read at a useful width, tightened (a path
  // down to its file name), and say how many were dropped rather than pretending the chain ended.
  const n = rendered.length;
  for (let keep = n; keep >= 1; keep -= 1) {
    const suffix = keep < n ? `${SEP}+${n - keep} more` : '';
    const per = Math.floor((budget - suffix.length - SEP.length * (keep - 1)) / keep);
    if (per < MIN_STAGE && keep > 1) continue;
    const line = `${rendered.slice(0, keep).map((stage) => tighten(stage, per)).join(SEP)}${suffix}`;
    if (line.length <= budget) return line;
  }
  return cap(rendered[0], budget);
}

function shellSummary(command, fields) {
  const tail = join([
    typeof fields.cwd === 'string' && clean(fields.cwd) ? `in ${shortenPath(clean(fields.cwd))}` : '',
    fields.background ? 'background' : ''
  ]);
  const suffix = tail ? ` · ${tail}` : '';
  return `${shellChain(command, Math.max(40, MAX - suffix.length))}${suffix}`;
}

// ── the header ───────────────────────────────────────────────────────────────────────────────────
/**
 * One line for the card header, naming what the call acts on rather than repeating the tool name.
 * `input` is the settled object once the tool input has parsed; while it is still streaming only
 * `rawInput` exists, so every string field is read through partialJsonString first — that is what
 * gives an Agent launch its description before the brief finishes arriving.
 */
export function toolSummary({ tool, input, rawInput, preview } = {}) {
  const fields = input && typeof input === 'object' ? input : {};
  const raw = (key) => {
    const settled = fields[key];
    if (typeof settled === 'string' && settled) return settled;
    if (typeof settled === 'number' || typeof settled === 'boolean') return String(settled);
    const partial = partialJsonString(rawInput, key);
    return partial?.text || '';
  };
  const str = (key) => clean(raw(key));
  const list = (key) => (Array.isArray(fields[key]) ? fields[key].filter((v) => typeof v === 'string' && v) : []);
  const many = (values) => (values.length > 1 ? `${clean(values[0])} +${values.length - 1} more` : clean(values[0] || ''));

  // A named rule that finds nothing (a list_files with no path, say) still falls through
  // to the generic ladder rather than leaving the header bare.
  const named = derive(tool, { str, raw, list, many, fields, preview });
  const given = input && typeof input === 'object';
  const line = named || fallback(str, fields, preview) || shape(fields, rawInput, given);
  // Shell is the one rule that needs its own newlines, so it is cleaned last; and a heredoc marker
  // that survived an oddly written stage (cat>file<<'EOF') is written out rather than leaked raw.
  const unmarked = line.replace(/\u0000<<([^\u0000]*)\u0000/gu, '<<$1').replace(/\u0000/gu, '');
  return cap(safe(clean(unmarked)));
}

function derive(tool, ctx) {
  const { str, raw, list, many, fields, preview } = ctx;
  switch (tool) {
    case 'shell':
    case 'Bash': {
      const command = raw('command');
      return command ? shellSummary(command, fields) : '';
    }
    case 'job_status':
    case 'job_wait':
    case 'job_cancel':
      return str('job_id') ? `job ${str('job_id')}` : '';
    case 'read_file':
    case 'Read': {
      const path = str('path') || str('file_path');
      if (!path) return '';
      const limit = Number(fields.max_bytes);
      return join([shortenPath(path), Number.isFinite(limit) ? `max ${bytes(limit)}` : '']);
    }
    case 'write_file':
    case 'Write': {
      const path = str('path') || str('file_path');
      if (!path) return '';
      const size = typeof fields.content === 'string' ? byteLength(fields.content) : null;
      return join([shortenPath(path), size === null ? '' : bytes(size)]);
    }
    case 'list_files':
      return str('path') ? shortenPath(str('path')) : '';
    case 'search_files':
      return join([str('pattern'), str('path') && `in ${shortenPath(str('path'))}`]);
    case 'memory_search':
      return join([str('query'), str('kind')]);
    case 'memory_read':
      return [str('kind'), str('id')].filter(Boolean).join(' ');
    case 'memory_apply': {
      const changes = fields.changes && typeof fields.changes === 'object' ? fields.changes : null;
      const counts = changes
        ? Object.entries(changes)
          .filter(([, value]) => Array.isArray(value) && value.length)
          .map(([key, value]) => `${value.length} ${key}`)
          .join(', ')
        : '';
      return join([str('batch_id') && `batch ${str('batch_id')}`, counts]);
    }
    case 'source_search':
      return join([str('query'), str('only')]);
    case 'web_search':
    case 'WebSearch':
      return str('query') || many(list('queries'));
    case 'web_open':
    case 'WebFetch': {
      const one = str('url');
      if (one) return hostAndPath(one);
      const urls = list('urls');
      if (!urls.length) return '';
      return urls.length > 1 ? `${hostAndPath(urls[0])} +${urls.length - 1} more` : hostAndPath(urls[0]);
    }
    case 'web_find':
      return join([str('pattern'), str('url') && `in ${hostAndPath(str('url'))}`]);
    case 'mail_search':
      return [str('account') && `${str('account')}:`, str('query')].filter(Boolean).join(' ');
    case 'mail_read':
      return [str('account') && `${str('account')}:`, str('id') && `message ${str('id')}`].filter(Boolean).join(' ');
    case 'mail_send':
      return [
        [str('account'), str('to') && `→ ${str('to')}`].filter(Boolean).join(' '),
        str('subject')
      ].filter(Boolean).join(': ');
    case 'messages_recent':
      return join([
        str('contact') && `contact ${str('contact')}`,
        str('query'),
        !str('contact') && !str('query') && str('since') ? `since ${str('since')}` : ''
      ]);
    case 'read_document': {
      const path = str('path');
      if (path) return join([fileName(path), str('attachment') && `part ${str('attachment')}`]);
      const id = str('native_id') || str('message_id');
      return join([str('source'), id && `message ${id}`, str('account')]);
    }
    case 'goal_add': {
      const items = list('items');
      if (items.length) return items.length > 1 ? `${clean(items[0])} +${items.length - 1} more` : clean(items[0]);
      return str('item') || str('text') || str('goal');
    }
    case 'goal_close': {
      const ids = list('ids');
      if (ids.length) return `close ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3} more` : ''}`;
      return str('id') ? `close ${str('id')}` : '';
    }
    case 'goal_wait':
      return join([str('id') && `wait ${str('id')}`, str('retry_at') || (str('retry_in_minutes') && `in ${str('retry_in_minutes')} min`)]);
    case 'Agent':
    case 'Task':
      return str('description') || str('prompt');
    case 'agent_send':
    case 'agent_wait':
    case 'agent_cancel': {
      const id = str('agent_id') || many(list('agent_ids'));
      return id ? `agent ${id}` : '';
    }
    default:
      break;
  }

  if (typeof tool === 'string' && tool.startsWith('credential_')) {
    const handle = str('handle');
    return handle ? `handle ${handle}` : (str('lease') && `lease ${str('lease')}`) || '';
  }
  if (typeof tool === 'string' && tool.startsWith('browser_')) {
    const url = str('url');
    return (url && hostAndPath(url)) || str('selector') || str('text') || (str('lease') && `lease ${str('lease')}`) || '';
  }
  return fallback(str, fields, preview);
}

// The generic ladder, for a tool this module has never heard of: whatever it is acting on,
// most specific first, and the first line of whatever it has said so far as a last resort.
function fallback(str, fields, preview) {
  if (str('command')) return shellSummary(str('command'), fields);
  if (typeof fields.file_path === 'string' && fields.file_path) return shortenPath(fields.file_path);
  if (typeof fields.notebook_path === 'string' && fields.notebook_path) return shortenPath(fields.notebook_path);
  if (str('path')) return shortenPath(str('path'));
  if (str('pattern')) return str('pattern');
  if (str('query')) return str('query');
  if (str('url')) return hostAndPath(str('url'));
  if (str('description')) return str('description');
  if (str('id')) return str('id');
  const line = typeof preview?.text === 'string' ? preview.text.split('\n').find((row) => row.trim()) : '';
  return line ? clean(line) : '';
}

// Last resort, so that no card is ever headed by nothing: the shape of the input it was given.
function shape(fields, rawInput, given) {
  const keys = Object.keys(fields);
  if (!keys.length) {
    const partial = typeof rawInput === 'string' ? clean(rawInput) : '';
    if (partial && partial !== '{}') return cap(partial, 60);
    // No input object at all yet: the arguments are still streaming, so say nothing about them
    // rather than claim there are none.
    return given ? 'no arguments' : '…';
  }
  const parts = keys.slice(0, 3).map((key) => `${key}: ${shapeValue(fields[key])}`);
  const rest = keys.length > 3 ? `, +${keys.length - 3} more` : '';
  return `{${parts.join(', ')}${rest}}`;
}

function shapeValue(value) {
  if (typeof value === 'string') return `"${cap(clean(value), 32)}"`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).length}}`;
  return '?';
}
