#!/usr/bin/env node
// tophat-cdp (rev6): drive the local Chrome over CDP from the shell. Same verbs, flags, output shapes and exit
// codes as tools/tophat-cdp (Python), which tools/README-tophat-cdp.md documents; rev6/tools/README.md lists
// the deliberate differences. `passkey` is forwarded to the Python tool in phase 1.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../lib/cli.mjs';
import { envGet } from '../lib/paths.mjs';
import { HelpExit, ParseError, helpText, parse, scrubMessage } from './argparse.mjs';
import * as K from './browser/kernel.mjs';
import * as S from './browser/secrets.mjs';
import * as Captcha from './captcha.mjs';
import * as CaptchaRun from './captcha-run.mjs';

const X = EXIT_CODES.cdp;
const E = (m, kind) => new K.CdpError(m, kind);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = (s) => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(s);

// ---- Python-compatible JSON (", " and ": " separators, ensure_ascii) -----------------------
export function pyJson(v, { indent = null, sortKeys = false, ascii = true } = {}, depth = 0) {
  const nl = indent === null ? '' : `\n${' '.repeat(indent * (depth + 1))}`, end = indent === null ? '' : `\n${' '.repeat(indent * depth)}`;
  const sep = indent === null ? ', ' : ',';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : String(v);
  if (typeof v === 'string') { const s = JSON.stringify(v); return ascii ? s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : s; }
  const o = { indent, sortKeys, ascii };
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => nl + pyJson(x, o, depth + 1)).join(sep)}${end}]` : '[]';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (sortKeys) keys.sort();
  return keys.length ? `{${keys.map((k) => `${nl}${pyJson(k, o)}: ${pyJson(v[k], o, depth + 1)}`).join(sep)}${end}}` : '{}';
}
const dump = (v, o) => say(pyJson(v, o));

// ---- the command line, declared as data (dests and defaults are argparse's) ------------------
const opt = (flags, o = {}) => {
  flags = [].concat(flags);
  return { flags, dest: o.dest || (flags.find((f) => f.startsWith('--')) || flags[0]).replace(/^-+/, '').replace(/-/g, '_'), nargs: o.flag ? 0 : 1, ...o };
};
const flag = (f, o = {}) => opt(f, { ...o, flag: true });
const pos = (dest, o = {}) => ({ dest, nargs: null, ...o });
const TARGET = pos('target', { help: 'target id, unique id prefix, or url=/url^=/url*=/title*= selector; ambiguity is an error listing every candidate' });
const SOFT = { text: S.TEXT_SOURCE_FLAGS, url: ['--url'], out: ['--out', '--output', '-o'] };
const soft = (dest) => pos(dest, { nargs: '?', default: null, unless: SOFT[dest] });
const TEXT_SOURCES = [flag('--text-stdin'), opt('--text-env', { metavar: 'VAR' }), opt('--text-file', { metavar: 'PATH' }),
  opt('--secret-from', { metavar: 'VAULT_ID[:field]', help: 'SECRET: read from the vault inside this tool; needs --expect-url' }), flag('--secret')];
const FORCE = flag('--force'), NFE = flag('--no-focus-emulation'), BUTTON = opt('--button', { default: 'left', choices: ['left', 'right', 'middle'] });
const LISTING = [opt('--filter'), flag('--json'), flag('--full-url'), opt('--max-url', { type: 'int', default: 160 })];
const v = (help, positionals = [], options = [], extra = {}) => ({ help, positionals, options, ...extra });
// pick among the matches of the FINAL selector segment (light DOM first, then open shadow roots)
const PICK = [opt('--text', { dest: 'pick_text', metavar: 'NEEDLE', default: null, help: 'only matches whose visible text contains NEEDLE (case-insensitive)' }),
  opt('--index', { dest: 'pick_index', metavar: 'N', type: 'int', default: null, help: 'the Nth (0-based) of the remaining matches' })];
const pickOf = (a) => (a.pick_text != null || a.pick_index != null ? { text: a.pick_text ?? null, index: a.pick_index ?? null } : null);

const VERBS = {
  status: v('Print endpoint, browser version, reachability and config source as JSON.'),
  endpoint: v('Print the configured CDP endpoint URL.'),
  targets: v('List targets: id, type, title, url. Touches nothing (plain /json/list).', [], [opt('--filter'), flag('--exact'), flag('--prefix'), flag('--case-sensitive'), opt('--type'), ...LISTING.slice(1)]),
  frames: v('List cross-origin iframe (OOPIF) targets by url; prefer frame-map.', [], LISTING),
  new: v('Create a tab and print its target id (Target.createTarget; /json/new is 405 here).', [pos('url', { nargs: '?', default: 'about:blank' })],
    [opt('--url', { dest: 'url_opt', metavar: 'URL' }), flag('--background'), flag('--new-context'), flag('--new-window'), flag('--json')]),
  window: v('Show or set the OS window bounds (points) of the target\'s window with Browser.setWindowBounds. It persists after the call (Emulation.setDeviceMetricsOverride dies with its session), so open the tab with `new --new-window` first and only that window is resized. Added 2026-11-09 for the narrow-window pane check.', [TARGET], [opt('--width', { type: 'int' }), opt('--height', { type: 'int' }), opt('--left', { type: 'int' }), opt('--top', { type: 'int' }), FORCE]),
  close: v('Close a target.', [TARGET], [FORCE]),
  activate: v('Bring a tab to the front.', [TARGET], [FORCE]),
  navigate: v('Navigate a target to a url (Page.navigate).', [TARGET, soft('url')], [opt('--url', { dest: 'url_opt', metavar: 'URL' }), FORCE]),
  reload: v('Reload a target. --offline S: reload with the network emulated offline for S seconds (this session holds it), then --eval EXPR is evaluated while still offline and printed; the network is restored after. Added 2026-11-08 for the zai2 offline-boot test.', [TARGET], [flag('--ignore-cache'), opt('--offline', { type: 'float' }), opt('--eval', { dest: 'eval_expr' }), FORCE]),
  headers: v('Hold an extra request header on a target for --for seconds (Network.setExtraHTTPHeaders lives only as long as this process), e.g. Cloudflare-Workers-Version-Overrides to test an uploaded Worker version on the real public host. Run it in the background, navigate or reload meanwhile.',
    [TARGET], [opt('--header', { metavar: 'NAME=VALUE', default: null }), opt('--for', { dest: 'hold', type: 'float', default: 300 }), FORCE]),
  dialog: v('Report an open JavaScript dialog, and --accept or --dismiss it.', [TARGET], [flag('--accept'), flag('--dismiss'), opt('--prompt-text', { default: null }),
    opt('--wait', { type: 'float', default: 1.5 }), opt('--timeout', { type: 'float', default: 10.0 }), FORCE], { exclusive: [['accept', 'dismiss']] }),
  info: v('Live url, title, readyState and viewport of a target.', [TARGET]),
  cookies: v("List the cookies the target's url sends (names, domain, flags; never values). --delete REGEX removes matching names (including HttpOnly ones), e.g. a bot-manager cookie that has started 403ing every page.", [TARGET],
    [opt('--delete', { metavar: 'NAME_REGEX', default: null }), flag('--dry-run'), FORCE]),
  eval: v('Runtime.evaluate with returnByValue and awaitPromise. JS from an argument, --file, or stdin.', [TARGET, pos('js', { nargs: '?' })],
    [opt('--file'), flag('--stdin'), opt(['--expr', '--expression', '--js', '--script', '--code', '-e'], { dest: 'js_opt', metavar: 'JS' }),
      opt('--max-chars', { type: 'int', default: null }), flag('--await', { dest: 'await_ok' }), flag('--no-await'), flag('--json'), opt('--timeout', { type: 'float', default: 30.0 })]),
  html: v('outerHTML of a selector (default: the whole document).', [TARGET, pos('selector', { nargs: '?' })], [opt('--max-chars', { type: 'int', default: 200000 })]),
  text: v('innerText of a selector (default: body).', [TARGET, pos('selector', { nargs: '?' })], [opt('--max-chars', { type: 'int', default: 200000 })]),
  screenshot: v('PNG of a target to a file.', [TARGET, soft('out')], [opt(['--out', '--output', '-o'], { dest: 'out_opt', metavar: 'PATH' }), opt('--clip'),
    flag('--full-page'), opt('--scale', { type: 'float', default: 1.0 }), opt('--timeout', { type: 'float', default: 30.0 }), flag('--allow-secret-fields'), opt('--color-scheme', { choices: ['light', 'dark'] })]),
  pdf: v('Print a target to a PDF file (Page.printToPDF). Added 2026-11-02 for gmail-pdf-filer: a portal that shows a document only as a page has no file to download.', [TARGET, pos('out', { help: 'output .pdf path' })], [opt('--timeout', { type: 'float', default: 30.0 })]),
  download: v('Fetch URL inside the tab (its cookies) and write the bytes to OUT; exit 3 on a non-2xx answer or, with --expect-pdf, bytes that do not start with %PDF-. Added 2026-11-02 for gmail-pdf-filer (a statement behind a login is a same-origin GET).', [TARGET, pos('url', { help: 'absolute, or relative to the tab' }), pos('out', { help: 'output path' })], [flag('--expect-pdf'), opt('--timeout', { type: 'float', default: 40.0 })]),
  click: v('Mouse click at x,y in CSS pixels; a frame target is clicked through its embedding page.', [TARGET, pos('x', { type: 'float' }), pos('y', { type: 'float' })],
    [flag('--in-frame'), BUTTON, opt('--clicks', { type: 'int', default: 1 }), opt('--modifiers'), FORCE, NFE]),
  'dom-click': v('Click a selector through the DOM (el.click()); not a trusted click, use tap for that.', [TARGET, pos('selector', { nargs: '?' })],
    [opt('--text', { metavar: 'NEEDLE', default: null }), opt('--index', { type: 'int', default: null }), FORCE]),
  type: v('Insert text at the focused element with Input.insertText.', [TARGET, soft('text')], [...TEXT_SOURCES, flag('--in-frame'), FORCE, NFE]),
  keys: v('Send key events for each key (a character, Enter, Tab, Arrow*, ... with Shift+/Ctrl+/Meta+/Alt+).', [TARGET, pos('keys', { nargs: '*' })],
    [...TEXT_SOURCES, flag('--select-all'), flag('--in-frame'), opt('--delay', { type: 'float', default: 0 }), FORCE, NFE]),
  fill: v("Replace a field's value for real: hit-tested click, selectAll, insertText into the page, readback, page validation check. Exit 7 not under the pointer, 8 verification disagreed.",
    [TARGET, pos('selector', { help: "CSS selector, optionally frame-piercing: 'IFRAME_CSS >>> ELEMENT_CSS'" }), soft('text')],
    [...TEXT_SOURCES, opt('--selector-file', { metavar: 'PATH' }), flag('--append'), flag('--no-click'), flag('--no-scroll'), flag('--no-focus-check'), flag('--allow-error'),
      opt('--settle', { type: 'float', default: 250 }), opt('--input-target'), flag('--dom-value'), FORCE, NFE]),
  clear: v('Empty a field: click, select all, insert nothing, verify empty. Never a Backspace loop.', [TARGET, pos('selector')],
    [flag('--no-click'), flag('--no-scroll'), flag('--no-focus-check'), flag('--allow-error'), opt('--settle', { type: 'float', default: 250 }), FORCE, NFE]),
  upload: v('Attach local files to an <input type=file> with DOM.setFileInputFiles (no file dialog, no drag). Added 2026-10-31 for Mercury Bill Pay (raw websocket scripts before).', [TARGET, pos('selector', { help: 'CSS selector of the file input (default: input[type=file])' }), pos('files', { nargs: '+' })], [opt('--index', { type: 'int', default: 0 }), FORCE]),
  tap: v('Click an element for real: scroll, hit-test, dispatch to the PAGE. Exit 7 if the point does not reach it.', [TARGET, pos('selector')],
    [BUTTON, opt('--clicks', { type: 'int', default: 1 }), flag('--no-scroll'), opt('--settle', { type: 'float', default: 120 }), ...PICK, FORCE, NFE]),
  point: v('Where an element really is, and whether a click would reach it. Exit 7 if not.', [TARGET, pos('selector')], [flag('--no-scroll'), flag('--page-errors'), ...PICK]),
  'frame-map': v('Every iframe in a tab, named by the element that embeds it.', [TARGET], [opt('--depth', { type: 'int', default: 3 }), flag('--json')]),
  'wait-for': v('Poll a target until a condition holds; exit 4 on timeout.', [TARGET], [opt('--selector'), flag('--url-changes'), opt('--url-contains'), opt('--text-contains'),
    opt('--timeout', { type: 'float', default: 30.0 }), opt('--poll', { type: 'float', default: 0.25 })]),
  captcha: v('Solve a captcha in an owned tab through 2Captcha. `captcha solve`: detect reCAPTCHA v2/v3, hCaptcha or Cloudflare Turnstile (a widget, or the Cloudflare challenge page), buy a token, put it in the page and fire its callback (--submit also submits the form when the page had no callback). `captcha detect`: what is on the page, nothing bought. `captcha balance` / `captcha spend`: account balance and the ledger against the caps (no tab needed). Limits come from the "captcha" section of the config file, never from code; a solve that would break one is refused (exit 5) before anything is bought. The token is never printed.',
    [TARGET, pos('what', { choices: ['solve', 'detect', 'balance', 'spend'], help: 'solve | detect | balance | spend' })],
    [opt('--kind', { choices: Captcha.KINDS, default: null, help: 'only this kind (with --sitekey: the kind to buy)' }), opt('--sitekey', { default: null, help: 'skip detection and buy this key (with --kind, default recaptcha_v2)' }),
      opt('--page-url', { default: null, help: 'websiteURL to send (default: the tab url)' }), opt('--index', { type: 'int', default: null, help: 'the Nth detected captcha, visible ones first' }),
      opt('--action', { dest: 'ts_action', default: null, help: 'Turnstile / reCAPTCHA v3 action' }), opt('--min-score', { type: 'float', default: 0.7 }),
      flag('--submit'), flag('--no-inject'), flag('--no-hook'), opt('--settle', { type: 'float', default: 4 }), FORCE]),
  protected: v('Show the target ids that mutating verbs refuse to touch, and whether they are still live.'),
};
const PKJOB = [opt('--job', { metavar: 'NAME' }), flag('--steal'), FORCE];
const sub = (prog, dest, choices) => ({ dest, nargs: 'PARSER', sub: Object.fromEntries(Object.entries(choices).map(([k, s]) => [k, { prog: `${prog} ${k}`, positionals: [], exclusive: [], ...s }])) });
VERBS.passkey = v('Passkeys through a virtual authenticator (phase 1: forwarded to the Python tool).', [sub('tophat-cdp passkey', 'passkey_command', {
  list: { options: [...PKJOB, opt('--rp-id')] }, status: { options: PKJOB }, attach: { options: [...PKJOB, opt('--rp-id'), flag('--no-credentials')] },
  enroll: { options: [...PKJOB, opt('--rp-id', { required: true }), opt('--user-name'), opt('--wait', { type: 'float', default: 0 })] },
  save: { options: [...PKJOB, opt('--rp-id'), opt('--user-name')] }, detach: { options: [...PKJOB, flag('--no-sync')] },
  forget: { options: [opt('--rp-id'), opt('--id')] }, export: { options: [opt('--file', { required: true }), opt('--key-file')] },
  import: { options: [opt('--file', { required: true }), opt('--key-file')] },
  _keeper: { positionals: [pos('name')], options: [opt('--target-id', { required: true }), opt('--rp-id')] } })]);
VERBS.job = v('Own a tab under a name, so concurrent agents stop yanking each other.', [sub('tophat-cdp job', 'job_command', {
  claim: { positionals: [pos('name')], options: [opt('--url'), opt('--target'), flag('--steal'), flag('--new'), flag('--foreground'), flag('--new-context'), flag('--ephemeral'), opt('--expect-url', { metavar: 'PREFIX' })] },
  adopt: { positionals: [pos('name')], options: [opt('--target', { required: true }), flag('--steal'), opt('--expect-url', { metavar: 'PREFIX' })] },
  release: { positionals: [pos('name')], options: [flag('--close')] }, list: { options: [flag('--all'), flag('--keep-stale')] },
  show: { positionals: [pos('name')], options: [] }, sync: { positionals: [pos('name')], options: [] },
  expect: { positionals: [pos('name'), pos('prefix', { nargs: '?' })], options: [flag('--clear')] }, reap: { options: [] } })]);
for (const [name, s] of Object.entries(VERBS)) {
  s.prog = `tophat-cdp ${name}`; s.description = s.help; s.exclusive ||= [];
  if (K.TARGET_VERBS.includes(name)) s.options.push(flag('--steal'), opt('--expect-url', { metavar: 'PREFIX' }));
}
const EPILOG = `SECRETS: never put a secret in argv. Use --secret-from VAULT_ID[:field] (ID:totp = one-time code), or --text-stdin,
--text-env VAR, --text-file PATH (+ --secret). A secret needs --expect-url PREFIX (or a job claimed with one), refuses
chat/mail/AI sites and anything but a focused <input>/<textarea>, and output never carries it.
--job NAME (or --target ID), --steal, --expect-url, --timeout, --json may sit before or after the verb; aliases nav/goto/js/shot/ls.
exit codes: 0 ok, 1 usage, 2 endpoint unreachable, 3 target/JS error, 4 timeout, 5 refused (protected or another job's tab),
6 the tab is not where the job left it / secret refused, 7 not under the pointer (nothing dispatched), 8 verification disagreed.`;
export const SPEC = { prog: 'tophat-cdp', description: 'Control the local Chrome over the DevTools Protocol. Endpoint: $TOPHAT_CDP_ENDPOINT or browserCdp in the tophat config file (TOPHAT_CONFIG, default ~/.config/tophat/config.json); local http only, never guessed.',
  epilog: EPILOG, options: [opt('--job', { metavar: 'NAME' })], positionals: [{ dest: 'command', nargs: 'PARSER', sub: VERBS }], exclusive: [] };

// ---- argv normalisation: the forgiving command line (port of normalize_argv) --------------------
export const VERB_ALIASES = { nav: 'navigate', goto: 'navigate', go: 'navigate', js: 'eval', evaluate: 'eval', ev: 'eval', shot: 'screenshot', ss: 'screenshot', ls: 'targets', tabs: 'targets' };
VERBS.list = VERBS.targets;
const arity = (s, o) => { const a = s && [...s.options, flag(['-h', '--help'])].find((x) => x.flags.includes(o)); return a ? a.nargs : null; };
function scanPositionals(s, tokens) {
  const found = [];
  for (let i = 0; i < tokens.length;) {
    const p = tokens[i];
    if (p === '--') { for (let j = i + 1; j < tokens.length; j++) found.push(j); break; }
    if (p.startsWith('-') && p.length > 1 && !/^-\d/.test(p)) { const ar = arity(s, p.split('=')[0]); i += 1 + (p.includes('=') || ar === null ? 0 : ar); continue; }
    found.push(i++);
  }
  return found;
}
function positionalShape(s, rest) {
  const acts = s.positionals, non = acts[0]?.dest === 'target' ? acts.slice(1) : acts;
  let low = 0, high = 0;
  for (const a of non) {
    if (a.nargs === '+' || a.nargs === '*') { high = Infinity; if (a.nargs === '+') low += 1; continue; }
    high += 1;
    if (a.nargs === null) low += 1;
    else if (a.nargs === '?' && a.unless && !rest.some((t) => a.unless.some((f) => t === f || t.startsWith(`${f}=`)))) low += 1;
  }
  return [low, high];
}
export function verbOf(argv) {
  for (const p of argv) { if (p === '--') return null; if (Object.hasOwn(VERBS, p) || Object.hasOwn(VERB_ALIASES, p)) return VERB_ALIASES[p] || p; }
  return null;
}
/** argparse swallows an optional positional (`navigate TARGET [url]`) with the first positional chunk, so
 *  `navigate job=X --expect-url P URL` died with "unrecognized arguments: 1 extra value" while
 *  `navigate job=X URL` worked.
 *  Put the positionals first and the options after, keeping `--` and everything past it as written.
 */
function positionalsFirst(s, rest) {
  if (rest.includes('--')) return rest;
  const idx = new Set(scanPositionals(s, rest));
  return [...rest.filter((_, i) => idx.has(i)), ...rest.filter((_, i) => !idx.has(i))];
}
/** -> {argv, auto, hint, source}: hint/source are what the Python tool put in TOPHAT_CDP_JOB_HINT/SOURCE. */
export function normalizeArgv(argv, env = process.env, ppid = process.ppid) {
  let at = -1;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--') break; if (Object.hasOwn(VERBS, argv[i]) || Object.hasOwn(VERB_ALIASES, argv[i])) { at = i; break; } }
  if (at < 0) return { argv: [...argv], auto: null };
  const verb = VERB_ALIASES[argv[at]] || argv[at], s = VERBS[verb];
  let name = null, explicit = null;
  const lift = (tokens, allowTarget) => {
    const out = [];
    for (let i = 0; i < tokens.length;) {
      const p = tokens[i];
      if (p === '--') { out.push(...tokens.slice(i)); break; }
      if ((p === '--job' || p === '-j') && i + 1 < tokens.length) { name = tokens[i + 1]; i += 2; continue; }
      if (p.startsWith('--job=')) { name = p.split('=').slice(1).join('='); i += 1; continue; }
      if (allowTarget && verb !== 'job' && verb !== 'passkey') {
        if (p === '--target' && i + 1 < tokens.length) { explicit = tokens[i + 1]; i += 2; continue; }
        if (p.startsWith('--target=')) { explicit = p.split('=').slice(1).join('='); i += 1; continue; }
      }
      out.push(p); i += 1;
    }
    return out;
  };
  const pre = lift(argv.slice(0, at), false);
  let rest = lift(argv.slice(at + 1), true);
  const moved = [], kept = [];
  for (let i = 0; i < pre.length;) {
    const p = pre[i], ar = s && p.startsWith('-') ? arity(s, p.split('=')[0]) : null;
    if (ar !== null) { const n = p.includes('=') ? 1 : 1 + ar; moved.push(...pre.slice(i, i + n)); i += n; } else { kept.push(p); i += 1; }
  }
  if (moved.length) { const stop = rest.includes('--') ? rest.indexOf('--') : rest.length; rest = [...rest.slice(0, stop), ...moved, ...rest.slice(stop)]; }
  let source = name ? 'flag' : null;
  if (name) name = K.sanitizeJobName(name) || name;
  else [name, source] = K.defaultJobName(env, ppid);
  const out = [...kept, verb, ...rest];
  if (!s || verb === 'job') return { argv: out, auto: null };
  if (verb === 'passkey') {   // only subcommands that declare --job get one
    const pk = rest.length && Object.hasOwn(s.positionals[0].sub, rest[0]) ? s.positionals[0].sub[rest[0]] : null;
    return { argv: pk && pk.options.some((o) => o.flags.includes('--job')) ? [...out, '--job', name] : out, auto: null };
  }
  if (!K.TARGET_VERBS.includes(verb)) return { argv: out, auto: null };
  const idx = scanPositionals(s, rest), [low, high] = positionalShape(s, rest), count = idx.length;
  let present = false;
  if (explicit !== null) { rest = [explicit, ...rest]; present = true; } else {
    const first = idx.length ? rest[idx[0]] : null;
    if (count > high) present = true;
    else if (count < low || low === high) present = source === 'flag' ? false : !!(first && K.looksLikeTarget(first) && count > low);
    else present = !!(first && K.looksLikeTarget(first) && count > low);
  }
  if (present) return { argv: [...kept, verb, ...positionalsFirst(s, rest)], auto: null, ...(source === 'flag' ? { hint: name, source: 'flag' } : {}) };
  return { argv: [...kept, verb, `job=${name}`, ...positionalsFirst(s, rest)], auto: name, source: source || 'flag' };
}

// ---- verbs ------------------------------------------------------------------------------------
const targetOpts = (a) => ({ target: a.target, expectUrl: a.expect_url, steal: a.steal, force: a.force, url: a.url, command: a.command, jobSource: a.job_source, jobHint: a.job_hint });
const select = (ep, a, action, o) => K.selectTarget(ep, targetOpts(a), action, { warn, ...o });
const cut = (s, n, note) => (n && s.length > n ? s.slice(0, n) + note(n, s.length) : s);
function printTargets(rows, json, maxUrl = 160) {
  if (json) return dump(rows, { indent: 2 });
  if (!rows.length) return say('(no targets matched)');
  const w = Math.max(...rows.map((r) => r.type.length));
  for (const r of rows) {
    const url = maxUrl && r.url.length > maxUrl ? `${r.url.slice(0, maxUrl)} ...[${r.url.length} chars]` : r.url;
    say(`${r.id}  ${r.type.padEnd(w)}  ${(r.title || '').replace(/\n/g, ' ').slice(0, 48).padEnd(48)}  ${url}`);
  }
}
async function routeToPage(ep, target, a, verb) {
  if (target.type !== 'iframe' || a.in_frame) {
    if (a.in_frame && target.type === 'iframe') warn(`warning: ${target.id} is an iframe (OOPIF) target. Input events there are sometimes accepted and silently ignored (seen on Shopify checkout frames). Verify the result.\n`);
    return target;
  }
  const res = new K.Resolver(ep);
  try { const [page] = await res.frameOffset(target); warn(`note: ${target.id} is a frame; sending ${verb} to its embedding page ${page.id} instead (--in-frame keeps the old behaviour)\n`); return page; } finally { await res.close(); }
}
function selectorOf(a) {
  if (a.selector_file) {
    if (a.selector) throw E('give the selector one way: positional or --selector-file', 'usage');
    try { return fs.readFileSync(a.selector_file, 'utf8').trim(); } catch (e) { throw E(`--selector-file: cannot read ${a.selector_file} (${e.code || e.name})`, 'usage'); }
  }
  if (!a.selector) throw E('this verb needs a CSS selector (positional, or --selector-file PATH)', 'usage');
  return a.selector;
}

async function doFill(ep, a, text, verb, priv = false, secret = false) {
  a.selector = selectorOf(a);
  const { target, job } = await select(ep, a, `${verb} in`);
  if (secret) S.checkSecretDestination(target.url, S.secretExpectation(a, job));
  let sensitive = !!priv;
  if (a.input_target) warn('note: --input-target is obsolete and ignored; fill always types into the embedding page target at hit-tested coordinates\n');
  const res = new K.Resolver(ep), onPw = (v) => S.registerSecret(v);
  try {
    let c = await res.locate(target, a.selector, { scroll: !a.no_scroll });
    const etype = String(c.element?.type || '').toLowerCase();
    if (etype === 'password' || secret) {
      sensitive = true; S.registerSecret(text);
      if (etype === 'password' && !priv) warn('warning: a password went through argv; use --secret-from VAULT_ID so it never enters shell history or a transcript\n');
    }
    if (secret) S.checkSecretElement(c.element, true);
    const show = (x) => (sensitive ? S.placeholder(x) : x);
    if (a.dom_value) {
      const value = await res.domValue(c, text);
      dump({ method: 'dom-value', selector: c.selector, value: show(value), warning: 'DOM value assignment is invisible to React/Shopify state' });
      return X.ok;
    }
    res.requireInView(c);
    c = await res.uncover(target, a.selector, c, { scroll: !a.no_scroll });
    await res.requireHit(c, verb);
    const before = c.element?.value ?? null, framed = c.ownerTargetId !== c.hops[0].targetId && !K.isVirtual(c.ownerTargetId);   // a same-process frame has no socket of its own to click in
    let focusVia = null;
    if (!a.no_click) { focusVia = framed ? 'frame' : 'page'; framed ? await res.clickInOwner(c) : await res.clickAt(c, { focusEmulation: !a.no_focus_emulation }); }
    let [el, walk] = await res.waitFocus(c, a.no_click ? 0 : 600, onPw);
    const focusable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tag);
    if (focusable && !walk.active && !a.no_click) { await res.clickAt(c, { focusEmulation: !a.no_focus_emulation }); focusVia = 'page-retry'; [el, walk] = await res.waitFocus(c, 800, onPw); }
    if (focusable && !walk.active && !a.no_focus_check) {
      throw E(`clicked ${K.pyRepr(c.selector)} at ${Math.round(c.centerX)},${Math.round(c.centerY)} but the page focus is still elsewhere, so typing would land in another field (this is the Shopify failure where the cardholder name went into the card number). Nothing was typed.`, 'verify_failed');
    }
    if (secret) {   // re-check the element and the destination at the last moment
      S.checkSecretElement(el, !!walk.active);
      const fresh = (await K.listTargets(ep)).find((t) => t.id.toUpperCase() === c.hops[0].targetId.toUpperCase());
      S.checkSecretDestination(fresh?.url || target.url, S.secretExpectation(a, job));
    }
    if (secret) {
      const page = (await K.listTargets(ep)).find((t) => t.id.toUpperCase() === c.hops[0].targetId.toUpperCase());
      S.noteSecretFill({ id: c.hops[0].targetId, url: page?.url || target.url }, job, verb, a);
    }
    if (!a.append) await res.selectAll(c);
    await res.insertText(c, text);
    await K.sleep(a.settle);
    [el, walk] = await res.readBack(c, onPw);
    const value = el?.value ?? null;
    const landed = typeof value === 'string' && (a.append ? value.endsWith(text) : value === text);
    const r2 = (n) => Math.round(n * 100) / 100;
    const result = { selector: c.selector, canonicalSelector: c.canonicalSelector, ownerTargetId: c.ownerTargetId, pageTargetId: c.hops[0].targetId,
      x: r2(c.centerX), y: r2(c.centerY), mode: a.append ? 'append' : 'replace', focusVia, before: show(before), value: show(value), verified: landed };
    const errs = a.allow_error ? {} : await res.fieldError(c);
    result.pageMessages = errs.messages || [];
    result.ariaInvalid = errs.ariaInvalid ?? null;
    if (!landed) {
      const appended = typeof value === 'string' && typeof before === 'string' && before && value === before + text;
      dump(result);
      throw E(`typed ${sensitive ? '[redacted]' : K.pyRepr(text)} into ${K.pyRepr(c.selector)} but the element reads back ${sensitive ? '[redacted]' : K.pyRepr(value)}${appended ? '; the text was APPENDED to the old value, so the select-all did not take' : ''}. Nothing about this fill is trustworthy.`, 'verify_failed');
    }
    if (result.pageMessages.length && !a.allow_error) { dump(result); throw E(`the value is in the field but the page shows a validation message for it: ${result.pageMessages.join(' | ')}`, 'verify_failed'); }
    if (String(errs.ariaInvalid || '').toLowerCase() === 'true' && !a.allow_error) { dump(result); throw E('the value is in the field but the page marks it aria-invalid="true"', 'verify_failed'); }
    dump(result);
    return X.ok;
  } finally { await res.close(); }
}

const CMD = {
  async status() { const { endpoint, source } = K.discover(); const { version } = await K.browserSocketUrl(endpoint); dump({ endpoint, browser: version.Browser, reachable: true, source }); },
  async endpoint() { say(K.discover().endpoint); },
  async targets(ep, a) {
    let rows = await K.listTargets(ep);
    if (a.type) { const want = a.type.split(','); rows = rows.filter((r) => want.includes(r.type)); }
    if (a.filter) {
      const needle = a.case_sensitive ? a.filter : a.filter.toLowerCase(), hay = (r) => { const t = `${r.url} ${r.title}`; return a.case_sensitive ? t : t.toLowerCase(); };
      rows = a.exact ? rows.filter((r) => r.url === a.filter) : a.prefix ? rows.filter((r) => r.url.startsWith(a.filter)) : rows.filter((r) => hay(r).includes(needle));
    }
    printTargets(rows, a.json, a.full_url ? 0 : a.max_url);
  },
  async frames(ep, a) {
    let rows = (await K.listTargets(ep)).filter((r) => r.type === 'iframe');
    if (a.filter) rows = rows.filter((r) => r.url.toLowerCase().includes(a.filter.toLowerCase()));
    printTargets(rows, a.json, a.full_url ? 0 : a.max_url);
    if (!a.json && rows.length) warn('note: input into an OOPIF target can be silently dropped; `fill` verifies the result\n');
  },
  async new(ep, a) {
    const url = a.url_opt || a.url;
    const r = await K.withBrowser(ep, async (c) => {
      const p = { url };
      if (a.background) p.background = true;
      if (a.new_window) p.newWindow = true;
      if (a.new_context) p.browserContextId = (await c.send('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
      return c.send('Target.createTarget', p);
    });
    a.json ? dump({ targetId: r.targetId, url }) : say(r.targetId);
  },
  async close(ep, a) {
    const { target, job } = await select(ep, a, 'close');
    const owner = job || K.targetOwner(await K.listTargets(ep), target.id);   // read before the tab goes
    await K.withBrowser(ep, (c) => c.send('Target.closeTarget', { targetId: target.id }));
    if (owner) K.releaseJob(owner.job);
    say(`closed ${target.id} ${target.url.slice(0, 100)}${owner ? ` (released job ${owner.job})` : ''}`);
  },
  async activate(ep, a) { const { target } = await select(ep, a, 'activate'); await K.withBrowser(ep, (c) => c.send('Target.activateTarget', { targetId: target.id })); say(`activated ${target.id}`); },
  async navigate(ep, a) {
    a.url = a.url_opt || a.url;
    if (!a.url) throw E('navigate needs a URL: positional, or --url URL', 'usage');
    const { target, job } = await select(ep, a, 'navigate');
    const r = await K.withTarget(ep, target, async (c) => { const x = await c.send('Page.navigate', { url: a.url }); if (x.errorText) throw E(`navigation failed: ${x.errorText}`); return x; });
    if (job) K.jobNoteUrl(job, a.url);   // the fingerprint is the url the JOB set
    dump({ targetId: target.id, frameId: r.frameId ?? null, url: a.url, job: job ? job.job : null });
  },
  async headers(ep, a) {
    const { target } = await select(ep, a, 'headers');
    const at = String(a.header ?? '').indexOf('=');
    if (at < 1) throw E('headers needs --header NAME=VALUE', 'usage');
    const name = a.header.slice(0, at), value = a.header.slice(at + 1);
    const hold = Math.max(1, Math.min(3600, a.hold));
    await K.withTarget(ep, target, async (c) => {
      await c.send('Network.enable', {});
      await c.send('Network.setExtraHTTPHeaders', { headers: { [name]: value } });
      say(`holding ${name} on ${target.id} for ${hold}s`);
      await new Promise((r) => setTimeout(r, hold * 1000));
    }, hold + 30);
    say(`released ${name} on ${target.id}`);
  },
  async window(ep, a) {
    const { target } = await select(ep, a, 'window');
    const out = await K.withBrowser(ep, async (c) => {
      const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: target.id });
      const bounds = { windowState: 'normal' };
      for (const k of ['width', 'height', 'left', 'top']) if (a[k] != null) bounds[k] = a[k];
      if (Object.keys(bounds).length > 1) await c.send('Browser.setWindowBounds', { windowId, bounds });
      return { targetId: target.id, windowId, ...(await c.send('Browser.getWindowForTarget', { targetId: target.id })) };
    });
    dump(out);
  },
  async reload(ep, a) {
    const { target } = await select(ep, a, 'reload');
    if (!a.offline) { await K.withTarget(ep, target, (c) => c.send('Page.reload', { ignoreCache: !!a.ignore_cache })); say(`reloaded ${target.id}`); return; }
    const out = await K.withTarget(ep, target, async (c) => {
      await c.send('Network.enable', {});
      await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        await c.send('Page.reload', { ignoreCache: !!a.ignore_cache });
        await K.sleep(a.offline * 1000);
        let value = null;
        if (a.eval_expr) { const r = await c.send('Runtime.evaluate', { expression: a.eval_expr, returnByValue: true, awaitPromise: true }); value = r.result?.value ?? r.exceptionDetails?.text ?? null; }
        return { reloaded: target.id, offlineSeconds: a.offline, value };
      } finally { await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {}); }
    }, Math.max(20, a.offline + 15));
    dump(out);
  },
  async dialog(ep, a) {
    const { target } = await select(ep, a, 'dialog');
    const out = await K.withTarget(ep, target, async (c) => {
      await c.send('Page.enable', {}, a.timeout);   // re-emits javascriptDialogOpening for a dialog already open
      const found = await c.waitEvent('Page.javascriptDialogOpening', a.wait * 1000);
      const o = { targetId: target.id, open: !!found, dialog: found, handled: null };
      if (found && (a.accept || a.dismiss)) {
        const p = { accept: !!a.accept };
        if (a.prompt_text !== null) p.promptText = a.prompt_text;
        await c.send('Page.handleJavaScriptDialog', p, a.timeout);
        o.handled = a.accept ? 'accepted' : 'dismissed';
      }
      return o;
    });
    dump(out, { indent: 2 });
  },
  async info(ep, a) {
    const { target } = await select(ep, a);
    const live = await K.withTarget(ep, target, (c) => K.evalValue(c, '({url:location.href,title:document.title,ready:document.readyState,w:innerWidth,h:innerHeight,scrollY:scrollY})'));
    dump({ id: target.id, type: target.type, listUrl: target.url, live: live ?? {} }, { indent: 2 });
  },
  async cookies(ep, a) {
    const { target } = await select(ep, a, a.delete ? 'delete cookies of' : null);
    const out = await K.withTarget(ep, target, async (c) => {
      const url = await K.evalValue(c, 'location.href');
      const { cookies = [] } = await c.send('Network.getCookies', { urls: [url] });
      const row = (k) => ({ name: k.name, domain: k.domain, path: k.path, httpOnly: !!k.httpOnly, secure: !!k.secure, session: !!k.session, size: k.size });
      const o = { targetId: target.id, url, count: cookies.length, cookies: cookies.map(row) };
      if (a.delete) {
        const re = new RegExp(a.delete);
        const hit = cookies.filter((k) => re.test(k.name));
        if (!a.dry_run) for (const k of hit) await c.send('Network.deleteCookies', { name: k.name, domain: k.domain, path: k.path });
        o.deleted = hit.map(row); o.dryRun = !!a.dry_run; delete o.cookies;
      }
      return o;
    });
    dump(out, { indent: 2 });
  },
  async eval(ep, a) {
    const { target } = await select(ep, a, 'evaluate in');
    const inline = a.js || a.js_opt;
    const expression = a.file ? fs.readFileSync(a.file.replace(/^~(?=\/)/, process.env.HOME), 'utf8') : inline && !a.stdin ? inline : fs.readFileSync(0, 'utf8');
    if (!expression.trim()) throw E('nothing to evaluate; pass JS, --file PATH, or pipe it on stdin', 'usage');
    const r = await K.withTarget(ep, target, (c) => K.evaluate(c, expression, { awaitPromise: !a.no_await, timeout: a.timeout }), Math.max(a.timeout, 20));
    if ('value' in r) {
      const rendered = a.json || typeof r.value !== 'string' ? pyJson(r.value, { indent: 2, ascii: false }) : r.value;
      say(cut(rendered, a.max_chars, (n, l) => `\n[truncated at ${n} of ${l} chars by --max-chars]`));
    } else dump({ type: r.type ?? null, description: r.description ?? null });
  },
  async html(ep, a) { await CMD._read(ep, a, a.selector || 'html', 'outerHTML'); },
  async text(ep, a) { await CMD._read(ep, a, a.selector || 'body', 'innerText'); },
  async _read(ep, a, sel, prop) {
    const { target } = await select(ep, a);
    const s = JSON.stringify(sel);
    const value = await K.withTarget(ep, target, (c) => K.evalValue(c, `(()=>{${K.DEEP}const el=__q1(document,${s});if(!el)throw new Error("no element matches "+${s});return el.${prop};})()`));
    say(cut(value ?? '', a.max_chars, (n) => `\n... [truncated at ${n} chars]`));
  },
  async screenshot(ep, a) {
    const { target, job } = await select(ep, a);
    // a tab that had a secret typed into it is captured with its fields blurred
    const filled = S.secretFillRecord(target, job), mask = !!filled && !a.allow_secret_fields;
    if (filled) warn(`warning: this tab had a secret typed into it (${filled.verb} ${filled.vault || 'secret'} at ${filled.at}); ${mask
      ? 'inputs, iframes and editable fields are blurred in this screenshot; --allow-secret-fields captures them unmasked (never OCR or share that image)'
      : '--allow-secret-fields: captured UNMASKED; never OCR, upload or share this image'}\n`);
    const r = await K.withTarget(ep, target, async (c) => {
      // no requestAnimationFrame wait: a background tab never runs one; the capture itself renders a frame
      if (mask) await K.evalValue(c, `(()=>{const s=document.createElement('style');s.id='__tophat_cdp_mask';s.textContent=${JSON.stringify(S.MASK_CSS)};document.documentElement.appendChild(s);void document.documentElement.offsetHeight;return 1})()`);
      // --color-scheme: prefers-color-scheme emulated for this capture only (it is session-scoped, so it is set and cleared here), reaching sandboxed widget iframes too
      if (a.color_scheme) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: a.color_scheme }] });
      try { return await capture(c); } finally {
        if (a.color_scheme) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] }).catch(() => {});
        if (mask) await K.evalValue(c, `(()=>{const s=document.getElementById('__tophat_cdp_mask');if(s)s.remove();return 1})()`).catch(() => {});
      }
    }, Math.max(a.timeout, 30));
    async function capture(c) {
      const p = { format: 'png', fromSurface: true, captureBeyondViewport: false };
      if (a.clip) {
        const n = a.clip.split(',').map(Number);
        if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) throw E('--clip wants x,y,w,h in CSS pixels', 'usage');
        p.clip = { x: n[0], y: n[1], width: n[2], height: n[3], scale: a.scale };
      } else if (a.full_page) {
        const m = await c.send('Page.getLayoutMetrics'), size = m.cssContentSize || m.contentSize || {};
        p.clip = { x: 0, y: 0, width: size.width ?? 1280, height: size.height ?? 800, scale: a.scale };
        p.captureBeyondViewport = true;
      }
      return c.send('Page.captureScreenshot', p, Math.max(a.timeout, 20));
    }
    const data = Buffer.from(r.data, 'base64'), outPath = a.out_opt || a.out;
    if (!outPath) throw E('screenshot needs an output path: positional, or --out PATH', 'usage');
    const file = path.resolve(outPath.replace(/^~(?=\/)/, process.env.HOME));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    dump({ path: file, bytes: data.length, targetId: target.id, secretFieldsMasked: mask, secretFilled: !!filled });
  },
  async pdf(ep, a) {
    const { target } = await select(ep, a);
    // screen media, not print: single-page apps hide their content under @media print
    const r = await K.withTarget(ep, target, async (c) => {
      await c.send('Emulation.setEmulatedMedia', { media: 'screen' });
      try { return await c.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, Math.max(a.timeout, 30)); }
      finally { await c.send('Emulation.setEmulatedMedia', { media: '' }).catch(() => {}); }
    }, Math.max(a.timeout, 40));
    const data = Buffer.from(r.data, 'base64'), file = path.resolve(a.out.replace(/^~(?=\/)/, process.env.HOME));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    dump({ path: file, bytes: data.length, targetId: target.id, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  },
  async download(ep, a) {
    const { target } = await select(ep, a);
    const js = `(async()=>{const r=await fetch(${JSON.stringify(a.url)},{credentials:'include'});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));return JSON.stringify({status:r.status,type:r.headers.get('content-type'),disposition:r.headers.get('content-disposition'),b64:btoa(s)})})()`;
    const raw = await K.withTarget(ep, target, (c) => K.evalValue(c, js), Math.max(a.timeout, 40));
    const info = JSON.parse(raw), data = Buffer.from(info.b64, 'base64');
    delete info.b64;
    if (!(info.status >= 200 && info.status < 300)) throw E(`download: HTTP ${info.status} from ${a.url.split('?')[0]}`, 'target');
    if (a.expect_pdf && data.subarray(0, 5).toString() !== '%PDF-') throw E(`download: ${data.length} bytes (${info.type}) are not a PDF`, 'target');
    const file = path.resolve(a.out.replace(/^~(?=\/)/, process.env.HOME));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    dump({ ...info, path: file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), targetId: target.id });
  },
  async click(ep, a) {
    const { target } = await select(ep, a, 'click');
    let page = target, ox = 0, oy = 0;
    if (target.type === 'iframe' && !a.in_frame) {
      const res = new K.Resolver(ep);
      try { [page, ox, oy] = await res.frameOffset(target); } finally { await res.close(); }
      warn(`note: ${target.id} is a frame; clicking its embedding page ${page.id} at ${Math.round(ox + a.x)},${Math.round(oy + a.y)} (frame origin ${Math.round(ox)},${Math.round(oy)})\n`);
    }
    const x = ox + a.x, y = oy + a.y;
    await K.withTarget(ep, page, async (c) => { if (!a.no_focus_emulation) await c.focusEmulation(true); await K.mouseClick(c, x, y, a.button, a.clicks, K.modifierBits(a.modifiers)); });
    say(`clicked ${page.id} at ${x},${y}`);
  },
  async 'dom-click'(ep, a) {
    const { target } = await select(ep, a, 'click in');
    const sel = JSON.stringify(selectorOf(a)), needle = a.text ?? null, index = a.index || 0;
    const js = `(()=>{${K.DEEP}let list=__qa(document,${sel});const needle=${JSON.stringify(needle)};if(needle!==null){const f=(l)=>l.filter(e=>((e.innerText||e.value||"")+"").toLowerCase().includes(needle.toLowerCase()));list=f(list);if(!list.length)list=f(__all(document,${sel}));}const el=list[${index}];if(!el)throw new Error("no element matches "+${sel}+(needle!==null?" with text "+needle:"")+" at index ${index} ("+list.length+" candidates)");el.scrollIntoView({block:"center"});el.click();return {clicked:true,tag:el.tagName,text:(el.innerText||el.value||"").slice(0,80),candidates:list.length};})()`;
    dump(await K.withTarget(ep, target, (c) => K.evalValue(c, js)));
  },
  async type(ep, a) {
    const { target: t0, job } = await select(ep, a, 'type into');
    const { text, secret } = S.resolveText(a, 'type');
    const target = await routeToPage(ep, t0, a, 'type');
    await K.withTarget(ep, target, async (c) => {
      if (!a.no_focus_emulation) await c.focusEmulation(true);
      if (secret) { await S.guardActiveElement(c, a, job); S.noteSecretFill(target, job, 'type', a); }
      await c.send('Input.insertText', { text });
    });
    say(`typed ${[...text].length} chars into ${target.id}`);
  },
  async keys(ep, a) {
    const { target: t0, job } = await select(ep, a, 'send keys to');
    const sourced = !!(a.text_stdin || a.text_env || a.text_file || a.secret_from);
    if (a.keys.length && sourced) throw E('keys: give key names OR a text source, not both', 'usage');
    if (!a.keys.length && !sourced) throw E('keys needs key names (Tab Enter ...) or --text-stdin/--text-env/--text-file/--secret-from', 'usage');
    let typed = null, secret = false;
    if (sourced) ({ text: typed, secret } = S.resolveText({ ...a, text: null }, 'keys'));
    const target = await routeToPage(ep, t0, a, 'keys');
    await K.withTarget(ep, target, async (c) => {
      if (!a.no_focus_emulation) await c.focusEmulation(true);
      if (secret) { await S.guardActiveElement(c, a, job); S.noteSecretFill(target, job, 'keys', a); }
      if (a.select_all) await K.sendSelectAll(c);
      for (const spec of typed !== null ? [...typed] : a.keys) {
        try { await K.sendKey(c, spec); } catch (e) { if (!(e instanceof K.CdpError) || e.kind !== 'usage') throw e; await c.send('Input.insertText', { text: spec }); }
        if (a.delay) await K.sleep(a.delay);
      }
    });
    say(typed !== null ? `sent ${[...typed].length} characters to ${target.id}` : `sent ${a.keys.join(' ')} to ${target.id}`);
  },
  async 'frame-map'(ep, a) {
    const { target } = await select(ep, a);
    const res = new K.Resolver(ep);
    let rows;
    try { rows = await res.frameTree(target.id, a.depth); } finally { await res.close(); }
    if (a.json) return dump({ target: target.id, url: target.url, frames: rows }, { indent: 2 });
    if (!rows.length) return say(`(no iframes in ${target.id})`);
    const w = Math.max(...rows.map((r) => r.selector.length)), byUrl = {};
    for (const r of rows) (byUrl[r.frameUrl || r.src || ''] ||= []).push(r);
    const n = (x, k) => String(Math.round(x || 0)).padStart(k);
    for (const r of rows) {
      const rc = r.rect || {}, shared = byUrl[r.frameUrl || r.src || ''].length > 1;
      say(`${r.selector.padEnd(w)}  ${r.targetId || '-'.repeat(32)}  ${(r.targetId ? 'frame' : 'same').padEnd(5)} ${n(rc.w, 4)}x${String(Math.round(rc.h || 0)).padEnd(4)} @${n(rc.x, 4)},${String(Math.round(rc.y || 0)).padEnd(4)}  ${(r.frameUrl || r.src || '').slice(0, 70)}${shared ? '   [url shared with another frame: only the selector identifies it]' : ''}`);
    }
  },
  async point(ep, a) {
    const { target } = await select(ep, a);
    const res = new K.Resolver(ep);
    try {
      const c = await res.locate(target, a.selector, { scroll: !a.no_scroll, pick: pickOf(a) }), info = res.describe(c);
      info.hit = await res.hitTest(c);
      if (a.page_errors) info.pageMessages = await res.fieldError(c);
      dump(info, { indent: 2 });
      if (!info.hit.ok) { warn(`tophat-cdp: the hit test does not reach ${K.pyRepr(a.selector)}; a click there would land on ${info.hit.hit}\n`); return X.hittest; }
      if (!info.inView) { warn(`tophat-cdp: ${K.pyRepr(a.selector)} is not inside the page viewport\n`); return X.hittest; }
    } finally { await res.close(); }
  },
  async tap(ep, a) {
    const { target } = await select(ep, a, 'click in');
    const res = new K.Resolver(ep);
    try {
      let c = await res.locate(target, a.selector, { scroll: !a.no_scroll, pick: pickOf(a) });
      res.requireInView(c);
      c = await res.uncover(target, a.selector, c, { scroll: !a.no_scroll, pick: pickOf(a) });
      await res.requireHit(c, 'click');
      const where = await res.clickAt(c, { button: a.button, clicks: a.clicks, focusEmulation: !a.no_focus_emulation });
      await K.sleep(a.settle);
      const pick = (o) => Object.fromEntries(['tag', 'id', 'name', 'type', 'text'].map((k) => [k, o[k] ?? null]));
      const out = { clicked: true, selector: c.selector, canonicalSelector: c.canonicalSelector, ownerTargetId: c.ownerTargetId,
        x: Math.round(where.x * 100) / 100, y: Math.round(where.y * 100) / 100, element: pick(c.element) };
      try {
        const [el, walk] = await res.readBack(c, S.registerSecret);
        out.focused = walk.active ?? null;
        out.valueAfter = String(el?.type || '').toLowerCase() !== 'password' ? (el?.value ?? null) : S.placeholder(el?.value || '');
      } catch (e) { if (!(e instanceof K.CdpError)) throw e; out.gone = true; }
      dump(out);
    } finally { await res.close(); }
  },
  async fill(ep, a) { const { text, private: p, secret } = S.resolveText(a, 'fill'); return doFill(ep, a, text, 'fill', p, secret); },
  async upload(ep, a) {
    const { target } = await select(ep, a, 'upload into');
    const files = a.files.map((f) => path.resolve(f.replace(/^~(?=\/)/, process.env.HOME || '~')));
    for (const f of files) if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw E(`upload: not a file: ${f}`, 'usage');
    const sel = a.selector || 'input[type=file]';
    const out = await K.withTarget(ep, target, async (c) => {
      await c.send('DOM.enable');
      const doc = await c.send('DOM.getDocument', { depth: 0 });
      const q = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: sel });
      const ids = q.nodeIds || [];
      if (!ids.length) throw E(`upload: no element matches ${sel}`, 'target');
      const nodeId = ids[a.index || 0];
      if (!nodeId) throw E(`upload: only ${ids.length} candidates for ${sel}, no index ${a.index}`, 'target');
      await c.send('DOM.setFileInputFiles', { nodeId, files });
      return { candidates: ids.length, index: a.index || 0 };
    });
    dump({ uploaded: files.length, files: files.map((f) => path.basename(f)), selector: sel, ...out, target: target.id });
  },
  async clear(ep, a) { a.append = false; a.text = ''; return doFill(ep, a, '', 'clear'); },
  async 'wait-for'(ep, a) {
    const { target } = await select(ep, a);
    const until = Date.now() + a.timeout * 1000, c = await K.openTargetConn(ep, target, Math.min(a.timeout + 5, 60));
    const href = () => K.evalValue(c, 'location.href');
    try {
      const start = await href();
      for (;;) {
        if (a.selector && await K.evalValue(c, `(()=>{${K.DEEP}return !!__q1(document,${JSON.stringify(a.selector)});})()`)) return dump({ matched: 'selector', selector: a.selector, url: await href() });
        if (a.url_contains) { const u = await href(); if (u.includes(a.url_contains)) return dump({ matched: 'url-contains', url: u }); }
        if (a.url_changes) { const u = await href(); if (u !== start) return dump({ matched: 'url-changes', from: start, url: u }); }
        if (a.text_contains && await K.evalValue(c, `(document.body&&document.body.innerText||"").includes(${JSON.stringify(a.text_contains)})`)) return dump({ matched: 'text-contains', url: await href() });
        if (Date.now() > until) throw E(`timed out after ${K.pyFloat(a.timeout)}s waiting on ${target.id}`, 'timeout');
        await K.sleep(a.poll * 1000);
      }
    } finally { c.close(); }
  },
  async captcha(ep, a) {
    if (a.what === 'balance') return dump(await Captcha.balance());
    if (a.what === 'spend') return dump(Captcha.spend(), { indent: 2 });
    const { target } = await select(ep, a, a.what === 'solve' ? 'solve a captcha on' : null);
    if (a.what === 'detect') return dump(await CaptchaRun.detect(ep, target), { indent: 2 });
    try { dump(await CaptchaRun.solve(ep, target, a), { indent: 2 }); } catch (e) { if (e.result) dump(e.result, { indent: 2 }); throw e; }
  },
  async protected(ep) {
    const known = new Map((await K.listTargets(ep)).map((t) => [t.id.toUpperCase(), t]));
    dump({ file: K.protectFile(), protected: [...K.protectedIds()].sort().map((id) => ({ id, live: known.has(id), url: known.get(id)?.url ?? '' })) }, { indent: 2 });
  },
  async job(ep, a) {
    const out = (p) => dump(p, { indent: 2, sortKeys: true });
    const sub = a.job_command || 'list';
    if (sub === 'list') {
      let t = await K.listTargets(ep);
      if (!a.keep_stale) { const orphans = []; K.reapJobs(t, { orphans }); await K.reapIdleTabs(t, { endpoint: ep, extra: orphans }).catch(() => []); t = await K.listTargets(ep); }
      const ui = K.uiJobs(), p = { jobs: K.allJobs().map((j) => K.jobRow(j, t, ui)), registry: K.jobsDir() };
      if (a.all) p.uiJobs = Object.values(ui).map((r) => ({ ...r, registry: K.uiJobsDir() }));
      return out(p);
    }
    if (sub === 'reap') {
      const t = await K.listTargets(ep), orphans = [], reaped = K.reapJobs(t, { orphans });
      return out({ reaped, closedTabs: await K.reapIdleTabs(t, { endpoint: ep, extra: orphans }).catch(() => []) });
    }
    if (sub === 'claim' || sub === 'adopt') {
      const ui = K.uiJobs()[a.name];
      if (sub === 'claim' && ui) warn(`note: ${a.name} is also a UI-automation job (window ${ui.windowID} of ${ui.app}). The job namespace is shared by convention; same name should mean the same piece of work.\n`);
      const [job, how] = await K.claimJob(ep, a.name, sub === 'claim' ? { url: a.url, targetId: a.target, steal: a.steal, background: !a.foreground, newContext: a.new_context,
        fresh: a.new, ephemeral: a.ephemeral, expectPrefix: a.expect_url } : { targetId: a.target, steal: a.steal, expectPrefix: a.expect_url });
      return out({ ...job, how });
    }
    if (sub === 'release') {
      const job = K.loadJob(a.name);
      if (!job) throw E(`no such cdp job ${K.pyRepr(a.name)}`, 'usage');
      const closed = a.close ? await K.closeTarget(ep, job.targetId) : false;
      K.releaseJob(a.name);
      return out({ released: a.name, targetId: job.targetId ?? null, closed });
    }
    if (sub === 'show') { const { job, drift } = await K.resolveJobTarget(ep, a.name, { quiet: true }); return out({ ...K.jobRow(job, await K.listTargets(ep), K.uiJobs()), drift }); }
    if (sub === 'sync') {
      const { target, job } = await K.resolveJobTarget(ep, a.name, { quiet: true });
      K.jobNoteUrl(job, target.url, target.title);
      return out({ job: a.name, lastUrl: job.lastUrl ?? null, note: 'the tab where it stands now is the job fingerprint' });
    }
    if (sub === 'expect') {
      const job = K.loadJob(a.name);
      if (!job) throw E(`no such cdp job ${K.pyRepr(a.name)}`, 'usage');
      job.expectPrefix = a.clear ? null : a.prefix;
      K.saveJob(job);
      return out({ job: a.name, expectPrefix: job.expectPrefix });
    }
    throw E(`unknown job subcommand ${K.pyRepr(sub)}`, 'usage');
  },
};
CMD.list = CMD.targets;

const HINT = 'hint: pass secrets with --secret-from VAULT_ID (or --text-stdin/--text-env/--text-file), never as an argument; a value starting with "-" goes after `--`; --job NAME stands in for the TARGET positional and may sit before or after the verb';
/** Parse exactly as the Python tool would: -> {ns} | {help} | {error}; no side effects. */
export function parseArgv(argv, env = process.env, ppid = process.ppid) {
  const n = normalizeArgv(argv.length ? argv : ['status'], env, ppid);
  try {
    const ns = parse(SPEC, n.argv);
    if (ns.command === 'wait-for' && !(ns.selector || ns.url_changes || ns.url_contains || ns.text_contains)) throw new ParseError('wait-for needs --selector, --url-changes, --url-contains or --text-contains');
    return { ns, norm: n };
  } catch (e) {
    if (e instanceof HelpExit) return { help: e.text, norm: n };
    if (e instanceof ParseError) return { error: scrubMessage(e.message), norm: n };
    throw e;
  }
}

export async function main(argv) {
  S.installRedaction();
  if (verbOf(argv) === 'passkey') {
    const py = envGet(process.env, 'TOPHAT_CDP_PY') || path.join(HERE, 'tophat-cdp.py');
    return spawnSync(py, argv, { stdio: 'inherit' }).status ?? 1;
  }
  const { ns: a, help, error, norm } = parseArgv(argv);
  if (help) { process.stdout.write(help); return X.ok; }
  if (error) {
    warn(`usage: tophat-cdp [-h] [--job NAME] {${Object.keys(VERBS).join(',')}} ...\ntophat-cdp: error: ${error}\n`);
    if (/^(unrecognized|argument command|the following)/.test(error) || error.includes('expected')) warn(`${HINT}\n`);
    return X.usage;
  }
  if (!a.command) { process.stdout.write(helpText(SPEC)); return X.usage; }
  a.job_source = norm.source ?? null;
  a.job_hint = norm.hint ?? null;
  try {
    const ep = ['status', 'endpoint'].includes(a.command) ? null : K.discover().endpoint;
    const r = await CMD[a.command](ep, a);
    return typeof r === 'number' ? r : X.ok;
  } catch (e) {
    warn(`tophat-cdp: ${e?.message ?? e}\n`);
    return e instanceof K.CdpError ? e.code : X.usage;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`tophat-cdp: ${e?.message ?? e}\n`); process.exitCode = 1; });
}
