// A faithful port of Python 3.9 argparse's matching (the algorithm, not the API), so the rev6 CLIs accept and
// reject exactly what the Python tools did: option classification with unique-prefix abbreviation, the
// regex positional matcher (an `?` positional matches empty and is consumed before an option), `--`,
// mutually exclusive groups, subparsers that swallow the rest, string defaults type-converted, and help.
// Spec: {prog, description, epilog, options:[{flags, dest, nargs:0|1, type, default, choices, help}],
//        positionals:[{dest, nargs: null|'?'|'*'|'+'|'PARSER', type, default, choices, help, sub:{name: spec}}],
//        exclusive:[[dest, ...]]}. Errors: ParseError; -h: HelpExit with the text.
// Never: echo an argument value in an error message (callers scrub with scrubMessage).
export class ParseError extends Error {}
export class HelpExit extends Error { constructor(text) { super('help'); this.text = text; } }

export function pyInt(s) {
  const t = String(s).trim();
  if (!/^[+-]?\d(_?\d)*$/.test(t)) return undefined;
  return Number(t.replace(/_/g, ''));
}
export function pyFloat(s) {
  const t = String(s).trim().replace(/_/g, (m, i, all) => (/\d/.test(all[i - 1] || '') && /\d/.test(all[i + 1] || '') ? '' : '#'));
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
  return Number(t);
}
const convert = (a, v) => {
  if (!a.type) return v;
  const out = a.type === 'int' ? pyInt(v) : pyFloat(v);
  if (out === undefined) throw new ParseError(`argument ${name(a)}: invalid ${a.type} value: '${v}'`);
  return out;
};
const check = (a, v) => {
  const choices = a.choices || (a.sub && Object.keys(a.sub));
  if (choices && !choices.includes(v)) throw new ParseError(`argument ${name(a)}: invalid choice: '${v}' (choose from ${choices.map((c) => `'${c}'`).join(', ')})`);
};
const name = (a) => (a.flags ? a.flags.join('/') : a.sub ? '{' + Object.keys(a.sub).join(',') + '}' : a.dest);
const PAT = { null: '(-*A-*)', '?': '(-*A?-*)', '*': '(-*[A-]*)', '+': '(-*A[A-]*)', PARSER: '(-*A[-AO]*)' };
const nargsPattern = (a) => (a.flags ? (a.nargs === 0 ? '()' : '(A)') : PAT[a.nargs ?? null]);

function defaults(spec, ns) {
  for (const a of [...spec.options, ...spec.positionals]) if (!(a.dest in ns)) ns[a.dest] = a.default !== undefined ? a.default : a.nargs === 0 ? false : null;
}

export function parse(spec, args, ns = {}) {
  const extras = parseKnown(spec, [...args], ns);
  if (extras.length) throw new ParseError(`unrecognized arguments: ${extras.join(' ')}`);
  return ns;
}

function parseKnown(spec, args, ns) {
  defaults(spec, ns);
  const table = new Map();
  for (const o of [{ flags: ['-h', '--help'], dest: '__help', nargs: 0, help: 'show this help message and exit' }, ...spec.options]) for (const f of o.flags) table.set(f, o);
  const parseOptional = (a) => {
    if (!a || a[0] !== '-') return null;
    if (table.has(a)) return [table.get(a), a, null];
    if (a.length === 1) return null;
    if (a.includes('=')) { const i = a.indexOf('='), os = a.slice(0, i); if (table.has(os)) return [table.get(os), os, a.slice(i + 1)]; }
    const tuples = [];
    if (a[1] === '-') {
      const [prefix, explicit] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
      for (const [os, act] of table) if (os.startsWith(prefix)) tuples.push([act, os, explicit]);
    } else {
      for (const [os, act] of table) {
        if (os === a.slice(0, 2)) tuples.push([act, os, a.slice(2)]);
        else if (os.startsWith(a)) tuples.push([act, os, null]);
      }
    }
    if (tuples.length > 1) throw new ParseError(`ambiguous option: ${a} could match ${tuples.map((t) => t[1]).join(', ')}`);
    if (tuples.length === 1) return tuples[0];
    if (/^-\d+$|^-\d*\.\d+$/.test(a)) return null;
    if (a.includes(' ')) return null;
    return [null, a, null];
  };
  const optAt = new Map();
  let pattern = '', dd = false;
  args.forEach((a, i) => {
    if (dd) pattern += 'A';
    else if (a === '--') { pattern += '-'; dd = true; }
    else { const t = parseOptional(a); if (t) { optAt.set(i, t); pattern += 'O'; } else pattern += 'A'; }
  });
  const positionals = [...spec.positionals], extras = [], seen = new Set(), nonDefault = new Set();
  const conflicts = new Map();
  for (const g of spec.exclusive || []) for (const d of g) conflicts.set(d, g.filter((x) => x !== d));

  const take = (a, strs, os) => {
    seen.add(a);
    if (a.nargs !== 'PARSER') { const i = strs.indexOf('--'); if (i >= 0) strs = [...strs.slice(0, i), ...strs.slice(i + 1)]; }
    let value, isDefault = false;
    if (a.dest === '__help') throw new HelpExit(helpText(spec));
    if (a.flags && a.nargs === 0) value = true;
    else if (!strs.length && a.nargs === '?') { value = a.default ?? null; isDefault = true; if (typeof value === 'string') { value = convert(a, value); check(a, value); } }
    else if (!strs.length && a.nargs === '*' && !a.flags) { value = a.default ?? []; isDefault = a.default !== undefined && a.default !== null; check(a, value); }
    else if (strs.length === 1 && (a.nargs === undefined || a.nargs === null || a.nargs === '?' || a.nargs === 1)) { value = convert(a, strs[0]); check(a, value); }
    else if (a.nargs === 'PARSER') {
      check(a, strs[0]);
      ns[a.dest] = strs[0];
      const subns = {};
      const more = parseKnown(a.sub[strs[0]], strs.slice(1), subns);
      Object.assign(ns, subns);
      extras.push(...more);
      return;
    } else { value = strs.map((s) => convert(a, s)); value.forEach((v) => check(a, v)); }
    if (!isDefault) {
      nonDefault.add(a.dest);
      for (const c of conflicts.get(a.dest) || []) if (nonDefault.has(c)) throw new ParseError(`argument ${name(a)}: not allowed with argument --${c.replace(/_/g, '-')}`);
    }
    ns[a.dest] = value;
  };
  const consumePositionals = (start) => {
    const sel = pattern.slice(start);
    let counts = [];
    for (let i = positionals.length; i > 0; i--) {
      const m = new RegExp('^' + positionals.slice(0, i).map(nargsPattern).join('')).exec(sel);
      if (m) { counts = m.slice(1).map((g) => g.length); break; }
    }
    counts.forEach((n, k) => { take(positionals[k], args.slice(start, start + n)); start += n; });
    positionals.splice(0, counts.length);
    return start;
  };
  const consumeOptional = (start) => {
    let [act, os, explicit] = optAt.get(start);
    const tuples = [];
    let stop;
    for (;;) {
      if (!act) { extras.push(args[start]); return start + 1; }
      if (explicit !== null) {
        const count = act.nargs === 0 ? 0 : 1;
        if (count === 0 && os[1] !== '-') {
          tuples.push([act, [], os]);
          const next = os[0] + explicit[0];
          const rest = explicit.slice(1) || null;
          if (table.has(next)) { act = table.get(next); os = next; explicit = rest; }
          else throw new ParseError(`argument ${name(act)}: ignored explicit argument '${explicit}'`);
        } else if (count === 1) { stop = start + 1; tuples.push([act, [explicit], os]); break; }
        else throw new ParseError(`argument ${name(act)}: ignored explicit argument '${explicit}'`);
      } else {
        const m = new RegExp('^' + nargsPattern(act)).exec(pattern.slice(start + 1));
        if (!m) throw new ParseError(`argument ${name(act)}: expected one argument`);
        const n = m[1].length;
        stop = start + 1 + n;
        tuples.push([act, args.slice(start + 1, stop), os]);
        break;
      }
    }
    for (const [a, s, o] of tuples) take(a, s, o);
    return stop;
  };
  const optIdx = [...optAt.keys()];
  const maxOpt = optIdx.length ? Math.max(...optIdx) : -1;
  let start = 0;
  while (start <= maxOpt) {
    const next = Math.min(...optIdx.filter((i) => i >= start));
    if (start !== next) {
      const end = consumePositionals(start);
      if (end > start) { start = end; continue; }
      start = end;
    }
    if (!optAt.has(start)) { extras.push(...args.slice(start, next)); start = next; }
    start = consumeOptional(start);
  }
  const stop = consumePositionals(start);
  extras.push(...args.slice(stop));
  const required = [...spec.options, ...spec.positionals].filter((a) => !seen.has(a) && (a.required || (!a.flags && (a.nargs == null || a.nargs === '+' || (a.nargs === '*' && a.default === undefined)))));
  if (required.length) throw new ParseError(`the following arguments are required: ${required.map(name).join(', ')}`);
  for (const a of [...spec.options, ...spec.positionals]) if (!seen.has(a) && typeof a.default === 'string' && ns[a.dest] === a.default) ns[a.dest] = convert(a, a.default);
  return extras;
}

export function helpText(spec) {
  const opts = spec.options.map((o) => `  ${o.flags.join(', ')}${o.nargs === 0 ? '' : ` ${o.metavar || o.dest.toUpperCase()}`}${o.help ? `\n        ${o.help}` : ''}`);
  const pos = spec.positionals.map((p) => `  ${p.sub ? `{${Object.keys(p.sub).join(',')}}` : p.dest}${p.help ? `\n        ${p.help}` : ''}`);
  const usage = `usage: ${spec.prog} [-h] ${spec.options.map((o) => `[${o.flags[0]}${o.nargs === 0 ? '' : ` ${o.metavar || o.dest.toUpperCase()}`}]`).join(' ')} ${spec.positionals.map((p) => (p.nargs === '?' || p.nargs === '*' ? `[${p.dest}]` : p.sub ? '{...}' : p.dest)).join(' ')}`;
  return [usage, spec.description && `\n${spec.description}`, pos.length && `\npositional arguments:\n${pos.join('\n')}`,
    `\noptional arguments:\n  -h, --help\n        show this help message and exit${opts.length ? '\n' + opts.join('\n') : ''}`, spec.epilog && `\n${spec.epilog}`].filter(Boolean).join('\n') + '\n';
}

/** argparse echoes values in its errors; replace every value (the Python tool's scrub_argparse_message). */
export function scrubMessage(message, close = []) {
  let m = /^unrecognized arguments: ([\s\S]*)$/.exec(message);
  if (m) {
    const tokens = m[1].split(' '), options = tokens.filter((t) => /^--?[A-Za-z][A-Za-z0-9-]*$/.test(t)), others = tokens.length - options.length;
    let out = 'unrecognized arguments:';
    if (options.length) out += ` unknown option(s) ${[...new Set(options)].sort().join(', ')};`;
    if (others) out += ` ${others} extra value(s) not shown`;
    return out.replace(/;$/, '');
  }
  m = /^(argument [^:]*): invalid choice: '[\s\S]*?' \(choose from ([\s\S]*)\)$/.exec(message);
  if (m) {
    const choices = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const raw = /invalid choice: '([\s\S]*?)' \(choose from/.exec(message)[1];
    const near = closeMatches(raw, choices);
    return `${m[1]}: invalid choice (value not shown)${near.length ? `; did you mean: ${near.join(', ')}` : `; choose from: ${choices.join(', ')}`}`;
  }
  m = /^(argument [^:]*): (invalid .*? value|expected .*?|ignored explicit argument): [\s\S]*$/.exec(message);
  if (m) return `${m[1]}: ${m[2]} (value not shown)`;
  m = /^ambiguous option: ([\s\S]*?) could match ([\s\S]*)$/.exec(message);
  if (m) return `ambiguous option (value not shown) could match ${m[2]}`;
  return message.replace(/'[^']*'/g, '<arg>');
}
function closeMatches(word, choices, n = 3, cutoff = 0.5) {
  const ratio = (a, b) => { // difflib-like: 2*matches/(len a + len b) over the longest common subsequence
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return (2 * dp[a.length][b.length]) / (a.length + b.length || 1);
  };
  return choices.map((c) => [ratio(word, c), c]).filter(([r]) => r >= cutoff).sort((x, y) => y[0] - x[0]).slice(0, n).map(([, c]) => c);
}
