#!/usr/bin/env node
// tophat-vnc -- scripted VNC console for another Mac on the LAN.
//
// Why this exists: driving a GUI-only app (LabVIEW-style vendor tools with no
// accessibility tree) on a second Mac needs a real RFB client talking to
// Apple's Screen Sharing server. Injecting events into a local Screen Sharing
// *client window* does not work; a direct RFB client does.
//
// Auth: Apple's server offers RFB security type 30 (ARD Diffie-Hellman), which
// takes an account username + password, not the legacy VNC password. vncdotool
// supports it with -u/-p. Secrets come from the keyring, never from argv the
// caller typed, and every password is scrubbed out of stdout/stderr here.
//
// OCR: these windows have no accessibility tree, so reading the screen means
// OCR. macOS Vision is used locally (pyobjc), giving pixel-accurate boxes you
// can click straight away. Coordinates everywhere are FRAMEBUFFER PIXELS
// (a 4K screen is 3840x2160), not AppKit points.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, envGet } from '../lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UV = envGet(process.env, 'TOPHAT_UV') || path.join(os.homedir(), '.local', 'bin', 'uv');

// Targets: a JSON file ($TOPHAT_VNC_HOSTS, default <config dir>/vnc-hosts.json) mapping a name to
// { "host": "...", "port": 5900, "user": "...", "secret": "<vault id of the login password>" }.
const HOSTS_FILE = envGet(process.env, 'TOPHAT_VNC_HOSTS') || path.join(configDir(), 'vnc-hosts.json');
function loadHosts() {
  try { return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')); } catch (e) {
    console.error(`tophat-vnc: cannot read the targets file ${HOSTS_FILE} (${e.code || e.name}); set TOPHAT_VNC_HOSTS`);
    process.exit(2);
  }
}

function usage() {
  console.log(`tophat-vnc -- scripted VNC console (RFB) for a Mac on the LAN

  tophat-vnc capture OUT.png            grab the framebuffer
  tophat-vnc ocr [OUT.png]              capture, then OCR: "x,y WxH  text" per line
  tophat-vnc read IMG.png               OCR an image already on disk
  tophat-vnc click X Y                  move and left-click at framebuffer pixels
  tophat-vnc dblclick X Y               double-click
  tophat-vnc triple X Y                 triple-click (selects a text field's contents)
  tophat-vnc type TEXT                  type a literal string
  tophat-vnc key KEY                    one keysym: enter, esc, tab, bsp, ctrl-c ...
  tophat-vnc clear N                    N backspaces
  tophat-vnc setfield X Y TEXT          triple-click, select-all, type, verify nothing threw
  tophat-vnc unlock                     if (and only if) the console is locked, type the login password; verified from a remote shell
  tophat-vnc ensure-unlocked            same as unlock (alias for scripts)
  tophat-vnc locked                     locked | unlocked | unreachable over ssh; exit 0 / 1 / 7
  tophat-vnc raw ARGS...                any vncdo command sequence

Options: --target NAME (default $TOPHAT_VNC_TARGET, else the first target in the targets file), --delay MS (default 120), --crop x,y,w,h (ocr/read)
Exit 0 on success; vncdo's exit code otherwise. Passwords are never printed.`);
}

// The login password comes from tophat-pass (or $TOPHAT_VNC_PASS_BIN, same `get ID --raw -n` interface), never from argv.
function secret(name) {
  const named = envGet(process.env, 'TOPHAT_VNC_PASS_BIN');
  const bin = named || process.execPath, lead = named ? [] : [fileURLToPath(new URL('../bin/tophat-pass.mjs', import.meta.url))];
  const r = spawnSync(bin, [...lead, 'get', name, '--raw', '-n'], { encoding: 'utf8', timeout: 30000 });
  const v = (r.stdout || '').trim();
  if (!v) { console.error(`tophat-vnc: secret "${name}" is empty or missing`); process.exit(3); }
  return v;
}

function vncdo(target, pw, args, { delay = 120 } = {}) {
  const r = spawnSync(UV, ['run', '--with', 'vncdotool', 'vncdo',
    '-s', `${target.host}::${target.port}`, '-u', target.user, '-p', pw,
    '--delay', String(delay), ...args], { encoding: 'utf8', timeout: 300000 });
  const scrub = (s) => (s || '').split(pw).join('***')
    .split('\n').filter((l) => !/CryptographyDeprecationWarning|param_nums =|server_key =/.test(l)).join('\n');
  const err = scrub(r.stderr).trim();
  if (err) process.stderr.write(err + '\n');
  process.stdout.write(scrub(r.stdout));
  return r.status ?? 1;
}

const OCR_PY = `
import sys, json
import Quartz, Vision
from Foundation import NSURL
path = sys.argv[1]
crop = sys.argv[2] if len(sys.argv) > 2 else ''
url = NSURL.fileURLWithPath_(path)
src = Quartz.CGImageSourceCreateWithURL(url, None)
img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
ox = oy = 0
if crop:
    x, y, w, h = [int(v) for v in crop.split(',')]
    img = Quartz.CGImageCreateWithImageInRect(img, Quartz.CGRectMake(x, y, w, h))
    ox, oy = x, y
W = Quartz.CGImageGetWidth(img); H = Quartz.CGImageGetHeight(img)
req = Vision.VNRecognizeTextRequest.alloc().init()
req.setRecognitionLevel_(0)
req.setUsesLanguageCorrection_(False)
h_ = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
h_.performRequests_error_([req], None)
out = []
for o in (req.results() or []):
    t = o.topCandidates_(1)[0].string()
    bb = o.boundingBox()
    out.append({"t": t,
                "x": round(bb.origin.x * W) + ox,
                "y": round((1 - bb.origin.y - bb.size.height) * H) + oy,
                "w": round(bb.size.width * W),
                "h": round(bb.size.height * H)})
out.sort(key=lambda r: (r["y"], r["x"]))
for r in out:
    print(f'{r["x"]:5d},{r["y"]:5d} {r["w"]:4d}x{r["h"]:3d}  {r["t"]}')
`;

function ocr(file, crop) {
  const py = path.join(os.tmpdir(), 'tophat-vnc-ocr.py');
  fs.writeFileSync(py, OCR_PY);
  const r = spawnSync(UV, ['run', '--with', 'pyobjc-framework-Vision', '--with', 'pyobjc-framework-Quartz',
    'python', py, file, ...(crop ? [crop] : [])], { encoding: 'utf8', timeout: 180000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status) process.stderr.write(r.stderr || '');
  return r.status ?? 1;
}

const UNLOCK_PY = `
import sys, json, time
from vncdotool import api
c = json.loads(sys.stdin.read())
cl = api.connect(f"{c['host']}::{c['port']}", password=c['password'], username=c['user'], timeout=30)
d = c['delay']
cl.keyPress('esc'); time.sleep(1)
cl.mouseMove(c['fx'], c['fy']); cl.mousePress(1); time.sleep(1)
for _ in range(24):
    cl.keyPress('bsp'); time.sleep(d)
for ch in c['password']:
    cl.keyPress(ch); time.sleep(d)
time.sleep(1); cl.keyPress('enter'); time.sleep(6)
cl.disconnect()
api.shutdown()
`;

const argv = process.argv.slice(2);
let targetName = envGet(process.env, 'TOPHAT_VNC_TARGET') || null, delay = 120, crop = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target') { targetName = argv.splice(i, 2)[1]; i--; }
  else if (argv[i] === '--delay') { delay = Number(argv.splice(i, 2)[1]); i--; }
  else if (argv[i] === '--crop') { crop = argv.splice(i, 2)[1]; i--; }
}
const cmd = argv.shift();
if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0); }
const HOSTS = loadHosts();
targetName ||= Object.keys(HOSTS)[0];
const target = HOSTS[targetName];
if (!target) { console.error(`tophat-vnc: unknown target "${targetName}"; known: ${Object.keys(HOSTS).join(', ')}`); process.exit(2); }

if (cmd === 'read') process.exit(ocr(argv[0], crop));

// Ask the target (over ssh) whether the console is locked. Returns 'locked',
// 'unlocked' or 'unreachable': a failed ssh must never read as "unlocked". Both
// keys are checked: CGSSessionScreenIsLocked is what the lock screen sets,
// IOConsoleLocked the session-level flag. Output is captured before grepping
// (SIGPIPE under pipefail).
function consoleState() {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', `${target.user}@${target.host}`,
    'o="$(ioreg -l -w0)" || exit 9; if grep -q \'CGSSessionScreenIsLocked"=Yes\' <<<"$o" || grep -q \'IOConsoleLocked" = Yes\' <<<"$o"; then echo locked; else echo unlocked; fi'],
    { encoding: 'utf8', timeout: 30000 });
  const t = (r.stdout || '').trim();
  return r.status === 0 && (t === 'locked' || t === 'unlocked') ? t : 'unreachable';
}

if (cmd === 'locked') {
  const st = consoleState();
  console.log(st);
  process.exit(st === 'unlocked' ? 0 : st === 'locked' ? 1 : 7);
}

const pw = secret(target.secret);
const tmpShot = path.join(os.tmpdir(), `tophat-vnc-${Date.now()}.png`);
let rc = 0;
switch (cmd) {
  case 'capture': rc = vncdo(target, pw, ['capture', argv[0] || tmpShot], { delay }); break;
  case 'ocr': {
    const out = argv[0] || tmpShot;
    rc = vncdo(target, pw, ['capture', out], { delay });
    if (rc === 0) rc = ocr(out, crop);
    break;
  }
  case 'click': rc = vncdo(target, pw, ['move', argv[0], argv[1], 'click', '1'], { delay }); break;
  case 'dblclick': rc = vncdo(target, pw, ['move', argv[0], argv[1], 'click', '1', 'click', '1'], { delay }); break;
  case 'triple': rc = vncdo(target, pw, ['move', argv[0], argv[1], 'click', '1', 'click', '1', 'click', '1'], { delay }); break;
  case 'type': rc = vncdo(target, pw, ['type', argv.join(' ')], { delay }); break;
  case 'key': rc = vncdo(target, pw, ['key', argv[0]], { delay }); break;
  case 'clear': rc = vncdo(target, pw, Array.from({ length: Number(argv[0] || 16) }, () => ['key', 'bsp']).flat(), { delay }); break;
  case 'setfield': {
    const [x, y, ...rest] = argv;
    const text = rest.join(' ');
    rc = vncdo(target, pw, ['move', x, y, 'click', '1', 'click', '1', 'click', '1', 'pause', '1',
      'key', 'ctrl-a', 'pause', '1', 'type', text, 'pause', '1'], { delay });
    break;
  }
  case 'unlock':
  case 'ensure-unlocked': {
    // Never types into an unlocked desktop (it would put the password into
    // whatever app has focus), never puts the password in argv (the vncdo CLI
    // did: -p and `type`), retries once, and confirms over ssh that it worked.
    const fx = Number(argv[0] || target.unlockX || 1889), fy = Number(argv[1] || target.unlockY || 1962);
    let st = consoleState();
    if (st === 'unreachable') { console.error(`tophat-vnc: cannot reach ${targetName} over ssh; lock state unknown, not typing`); rc = 7; break; }
    for (let attempt = 1; attempt <= 2 && st === 'locked'; attempt++) {
      const r = spawnSync(UV, ['run', '--with', 'vncdotool', 'python', '-c', UNLOCK_PY],
        { input: JSON.stringify({ host: target.host, port: target.port, user: target.user, password: pw,
            delay: Math.max(delay, 200) / 1000, fx, fy }), encoding: 'utf8', timeout: 180000 });
      const scrub = (x) => (x || '').split(pw).join('***').split('\n')
        .filter((l) => !/CryptographyDeprecationWarning|param_nums =|server_key =/.test(l)).join('\n').trim();
      if (scrub(r.stderr)) process.stderr.write(scrub(r.stderr) + '\n');
      st = consoleState();
    }
    console.log(st === 'unlocked' ? 'unlocked' : `still ${st}`);
    rc = st === 'unlocked' ? 0 : 1;
    break;
  }
  case 'raw': rc = vncdo(target, pw, argv, { delay }); break;
  default: usage(); rc = 2;
}
process.exit(rc);
