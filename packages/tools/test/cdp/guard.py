#!/usr/bin/env python3
"""Tests for tophat-cdp's secret handling and forgiving command line.

    python3 packages/tools/test/cdp/guard.py
    python3 ... --no-browser     only the pure/unit and parse-error tests

Everything uses the fake secret FAKE below and a fake tophat-pass script (via
TOPHAT_CDP_PASS_BIN); no real credential is read. The browser half serves a tiny
page on 127.0.0.1:8913 and drives it through a job named `secrets-test`.
"""

import importlib.machinery
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import http.server
from pathlib import Path

HERE = Path(__file__).resolve().parent
CDP = str(HERE.parent.parent / 'cdp' / 'tophat-cdp.py')
FAKE = 'hunter2-test-value'
PAGE = b"""<!doctype html><title>secret fixture</title>
<form onsubmit="return false"><input id=user type=text name=user>
<input id=pw type=password name=pw></form>
<div id=chat contenteditable=true style="border:1px solid;height:30px"></div>
<textarea id=ta></textarea><input id=cb type=checkbox>"""

# an input inside a collapsed (height 0, overflow hidden) section must be refused with a message that
# says it is clipped, since no scroll can reach it.
OVERLAY_PAGE = b"""<!doctype html><title>overlay fixture</title>
<div style="height:calc(100vh - 70px)"></div>
<input id=under type=text style="width:300px;height:24px">
<div style="height:0;overflow:hidden"><label for=clipped>Clipped</label><input id=clipped type=text></div>
<label for=after>After</label><textarea id=after></textarea>
<div style="height:2000px"></div>
<div id=footer style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#ccc">footer</div>"""

PASSED, FAILED = [], []


def check(name, ok, detail=''):
    (PASSED if ok else FAILED).append(name)
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, ('  -- ' + detail) if detail and not ok else ''))


def load_module():
    loader = importlib.machinery.SourceFileLoader('tophat_cdp_mod', CDP)
    spec = importlib.util.spec_from_loader('tophat_cdp_mod', loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def run(*args, env=None, stdin=None, timeout=60):
    proc = subprocess.run([CDP] + list(args), capture_output=True, text=True, timeout=timeout,
                          env=dict(os.environ, **(env or {})), input=stdin)
    return proc.returncode, proc.stdout, proc.stderr


def unit(m):
    parser = m.build_parser()
    # --- argparse never echoes values
    for argv in (['fill', '0AFC41144B23DA144C549ACD70869DC2', 'input', FAKE, 'extra', FAKE],
                 ['navigate', '--nope', FAKE], [FAKE, 'fill'], ['click', 'ID123456', FAKE, '1'],
                 ['fill', '0AFC41144B23DA144C549ACD70869DC2', 'input', '--secret-from', FAKE, '--bogus=' + FAKE]):
        code, out, err = run(*argv)
        check('parse error hides value: %s' % ' '.join(a if a != FAKE else '<v>' for a in argv[:3]),
              code == 1 and FAKE not in out + err and 'error:' in err, '%s %s' % (code, err[-200:]))
    check('scrub: unrecognized', FAKE not in m.scrub_argparse_message('unrecognized arguments: %s x' % FAKE))
    check('scrub: invalid float', FAKE not in m.scrub_argparse_message("argument x: invalid float value: '%s'" % FAKE))
    check('scrub: invalid choice', FAKE not in m.scrub_argparse_message(
        "argument command: invalid choice: '%s' (choose from 'a', 'b')" % FAKE))
    check('scrub: suggests verb', 'navigate' in m.scrub_argparse_message(
        "argument command: invalid choice: 'navigat' (choose from 'navigate', 'new')"))
    # --- redactor, including json/repr escaped forms
    m.SECRET_VARIANTS[:] = []
    m.register_secret('p"w\\x-1234')
    text = json.dumps({'value': 'p"w\\x-1234'}) + repr('p"w\\x-1234') + 'p"w\\x-1234'
    check('redact_text covers raw/json/repr', 'x-1234' not in m.redact_text(text), m.redact_text(text))
    m.SECRET_VARIANTS[:] = []
    # --- normalisation: the shapes seen in the ledger
    cases = [
        (['fill', '0AFC41144B23DA144C549ACD70869DC2', 'input', 'pw', '--job', 'cf'], ['fill', '0AFC41144B23DA144C549ACD70869DC2', 'input', 'pw']),
        (['--job', 'cf', 'fill', 'input', 'pw'], ['fill', 'job=cf', 'input', 'pw']),
        (['fill', '--job', 'cf', 'input', 'pw'], ['fill', 'job=cf', 'input', 'pw']),
        (['eval', '--target', '0AFC41144B23DA144C549ACD70869DC2', '--expr', '1+1', '--await'],
         ['eval', '0AFC41144B23DA144C549ACD70869DC2', '--expr', '1+1', '--await']),
        (['--timeout', '10', '--job', 'k', 'eval', 'document.readyState'], ['eval', 'job=k', 'document.readyState', '--timeout', '10']),
        (['nav', '--job', 's', '--url', 'https://a.b'], ['navigate', 'job=s', '--url', 'https://a.b']),
        (['type', '--job', 'x', '--', '-5'], ['type', 'job=x', '--', '-5']),
        (['--steal', '--expect-url', 'https://x.com/', '--job', 'cf', 'fill', 'i', '--secret-from', 'a'],
         ['fill', 'job=cf', 'i', '--secret-from', 'a', '--steal', '--expect-url', 'https://x.com/']),
        (['screenshot', '--job', 'd', '--out', '/tmp/x.png'], ['screenshot', 'job=d', '--out', '/tmp/x.png']),
        (['click', '--job', 'y', '0AFC41144B23DA144C549ACD70869DC2', '3', '4'], ['click', '0AFC41144B23DA144C549ACD70869DC2', '3', '4']),
    ]
    for argv, want in cases:
        os.environ.pop('TOPHAT_CDP_JOB_HINT', None)
        got, _ = m.normalize_argv(argv, parser)
        check('normalize %s' % ' '.join(argv)[:70], got == want, str(got))
        try:
            parser.parse_args(got)
            parsed = True
        except SystemExit:
            parsed = False
        check('  parses', parsed)
    ns = parser.parse_args(m.normalize_argv(['fill', '--job', 'x', 'input', '--', '-abc'], parser)[0])
    check('leading-dash text after --', ns.text == '-abc', repr(ns.text))
    # --- text sources
    ns = parser.parse_args(['fill', 'job=x', 'input', '--text-env', 'TOPHAT_TEST_SECRET'])
    os.environ['TOPHAT_TEST_SECRET'] = FAKE
    text, private, secret = m.resolve_text(ns, 'fill')
    check('--text-env resolves, private, not secret', (text, private, secret) == (FAKE, True, False))
    check('private sources register for redaction', FAKE in m.SECRET_VARIANTS)
    m.SECRET_VARIANTS[:] = []
    ns = parser.parse_args(['fill', 'job=x', 'input', 'a', '--text-env', 'TOPHAT_TEST_SECRET'])
    try:
        m.resolve_text(ns, 'fill')
        check('text + source is refused', False)
    except m.CdpError:
        check('text + source is refused', True)
    # --- destination / element guards
    def refused(fn, *a):
        try:
            fn(*a)
            return False
        except m.CdpError as error:
            return error.code == m.EHIJACK
    check('guard: no expectation', refused(m.check_secret_destination, 'https://a.com/x', None))
    check('guard: wrong page', refused(m.check_secret_destination, 'https://evil.com/x', 'https://a.com/'))
    check('guard: discord even when expected', refused(m.check_secret_destination,
                                                       'https://discord.com/channels/1', 'https://discord.com/'))
    check('guard: http non-local prefix', refused(m.check_secret_destination, 'http://a.com/', 'http://a.com/'))
    check('guard: ok', not refused(m.check_secret_destination, 'https://dash.cloudflare.com/login', 'https://dash.cloudflare.com/'))
    check('guard: origin must match, not just startswith',
          refused(m.check_secret_destination, 'https://dash.cloudflare.com.evil.io/', 'https://dash.cloudflare.com'))
    check('element: contenteditable div', refused(m.check_secret_element, {'tag': 'DIV'}))
    check('element: checkbox', refused(m.check_secret_element, {'tag': 'INPUT', 'type': 'checkbox'}))
    check('element: unfocused', refused(m.check_secret_element, {'tag': 'INPUT', 'type': 'password'}, False))
    check('element: password ok', not refused(m.check_secret_element, {'tag': 'INPUT', 'type': 'password'}))
    # --- vault fetch through a fake tophat-pass; failure never forwards its stderr
    with tempfile.TemporaryDirectory() as tmp:
        fake = Path(tmp) / 'tophat-pass'
        fake.write_text('#!/bin/sh\nif [ "$2" = "ok-entry" ]; then printf "%s\\n" "' + FAKE + '"; exit 0; fi\n'
                        'echo "boom ' + FAKE + '" >&2; exit 3\n')
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        os.environ['TOPHAT_CDP_PASS_BIN'] = str(fake)
        check('vault fetch', m.fetch_vault_secret('ok-entry') == FAKE)
        try:
            m.fetch_vault_secret('bad-entry')
            check('vault failure hides stderr', False)
        except m.CdpError as error:
            check('vault failure hides stderr', FAKE not in str(error))
        os.environ.pop('TOPHAT_CDP_PASS_BIN')



def unit_secret_fills(m):
    """A --secret-from fill marks the tab; a screenshot of it is masked; the mark lapses off-origin."""
    import argparse
    with tempfile.TemporaryDirectory() as d:
        m.SECRET_FILLS = Path(d) / 'secret-fills.json'
        ns = argparse.Namespace(secret_from='card-test:number')
        m.note_secret_fill({'id': 'T1', 'url': 'https://pay.example/checkout'}, None, 'fill', ns)
        rec = m.secret_fill_record({'id': 'T1', 'url': 'https://pay.example/checkout?step=2'}, None)
        check('secret fill recorded for its tab, vault id only', bool(rec) and rec.get('vault') == 'card-test'
              and 'number' not in json.dumps(rec), str(rec))
        check('another tab is not marked', m.secret_fill_record({'id': 'T2', 'url': 'https://pay.example/'}, None) is None)
        check('the mark lapses when the tab leaves the origin',
              m.secret_fill_record({'id': 'T1', 'url': 'https://other.example/done'}, None) is None)
        check('a frame of the marked page is marked too',
              bool(m.secret_fill_record({'id': 'F1', 'parentId': 'T1', 'url': 'https://pay.example/frame'}, None)))
        args = m.build_parser().parse_args(['screenshot', 'job=x', '/tmp/x.png', '--allow-secret-fields'])
        check('screenshot --allow-secret-fields parses', args.allow_secret_fields is True)


def serve():
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('content-type', 'text/html')
            self.end_headers()
            self.wfile.write(OVERLAY_PAGE if self.path.startswith('/overlay') else PAGE)

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 8913), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def browser():
    code, out, err = run('status')
    if code != 0:
        print('SKIP browser tests: tophat-cdp status exited %s' % code)
        return
    server = serve()
    tmp = tempfile.TemporaryDirectory()
    fake = Path(tmp.name) / 'tophat-pass'
    fake.write_text('#!/bin/sh\nprintf "%s\\n" "' + FAKE + '"\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    env = {'TOPHAT_CDP_PASS_BIN': str(fake)}
    base = 'http://127.0.0.1:8913/'
    job_expect, job_plain = 'secrets-test', 'secrets-test-plain'
    try:
        run('job', 'release', job_expect, '--close')
        run('job', 'release', job_plain, '--close')
        code, out, err = run('job', 'claim', job_expect, '--url', base, '--expect-url', base)
        check('claim job with expectation', code == 0, err)
        code, out, err = run('job', 'claim', job_plain, '--url', base)
        check('claim plain job', code == 0, err)
        run('wait-for', '--job', job_expect, '--selector', '#pw', '--timeout', '15')
        run('wait-for', '--job', job_plain, '--selector', '#pw', '--timeout', '15')

        def value_of(job, sel):
            code, out, err = run('eval', '--job', job, 'document.querySelector(%s).value' % json.dumps(sel))
            return out.strip()
        def clean(out, err, name):
            check(name + ': nothing leaked', FAKE not in out + err, (out + err)[-300:])

        code, out, err = run('fill', '--job', job_expect, '#pw', '--secret-from', 'any-entry', env=env)
        clean(out, err, 'secret fill password')
        check('secret fill typed it', code == 0 and value_of(job_expect, '#pw') == FAKE, '%s %s' % (code, err[-200:]))
        check('secret fill reports redacted value', '"verified": true' in out and 'redacted' in out, out[-300:])
        run('fill', '--job', job_expect, '#pw', '', env=env)

        code, out, err = run('fill', '--job', job_expect, '#user', '--secret-from', 'any-entry', env=env)
        clean(out, err, 'secret fill text input within expected origin')
        check('  typed', code == 0 and value_of(job_expect, '#user') == FAKE)

        code, out, err = run('fill', '--job', job_expect, '#chat', '--secret-from', 'any-entry', env=env)
        clean(out, err, 'secret into contenteditable')
        check('contenteditable refused (exit 6/7/8), nothing typed', code != 0 and
              run('eval', '--job', job_expect, 'document.querySelector("#chat").innerText')[1].strip() == '', '%s %s' % (code, err[-200:]))

        code, out, err = run('fill', '--job', job_plain, '#pw', '--secret-from', 'any-entry', env=env)
        clean(out, err, 'secret without expect-url')
        check('no expectation refused, field empty', code == 6 and value_of(job_plain, '#pw') == '', '%s %s' % (code, err[-200:]))

        code, out, err = run('fill', '--job', job_plain, '#pw', '--secret-from', 'any-entry', '--expect-url', 'https://other.example/', env=env)
        clean(out, err, 'secret wrong expect-url')
        check('wrong expect-url refused', code == 6 and value_of(job_plain, '#pw') == '', str(code))

        code, out, err = run('fill', '--job', job_plain, '#pw', '--secret-from', 'any-entry', '--expect-url', base, env=env)
        check('flag expect-url satisfies the guard', code == 0 and value_of(job_plain, '#pw') == FAKE, '%s %s' % (code, err[-200:]))
        run('fill', '--job', job_plain, '#pw', '', env=env)

        # incident shape: explicit target AND --job after, positional password
        code, out, err = run('job', 'show', job_plain)
        tid = json.loads(out)['targetId'] if code == 0 else ''
        code, out, err = run('fill', tid, '#pw', FAKE, '--job', job_plain)
        clean(out, err, 'positional password into type=password, explicit target + --job')
        check('  fill worked', code == 0 and value_of(job_plain, '#pw') == FAKE, '%s %s' % (code, err[-200:]))
        run('fill', '--job', job_plain, '#pw', '', env=env)

        # failure path with a secret: bad selector error must not echo it
        code, out, err = run('fill', '--job', job_expect, '#nope', '--secret-from', 'any-entry', env=env)
        clean(out, err, 'secret fill, selector missing')
        check('  fails', code != 0)

        # type / keys with a secret need the focus on the right element
        run('fill', '--job', job_expect, '#chat', 'x', '--dom-value', env=env)
        run('eval', '--job', job_expect, 'document.querySelector("#chat").focus()')
        code, out, err = run('type', '--job', job_expect, '--secret-from', 'any-entry', env=env)
        clean(out, err, 'type secret into focused chat box')
        check('  refused', code == 6, '%s %s' % (code, err[-200:]))
        run('eval', '--job', job_expect, 'document.querySelector("#pw").focus()')
        code, out, err = run('type', '--job', job_expect, '--secret-from', 'any-entry', env=env)
        check('type secret into focused password', code == 0 and value_of(job_expect, '#pw') == FAKE, '%s %s' % (code, err[-200:]))
        clean(out, err, 'type secret')
        run('fill', '--job', job_expect, '#pw', '', env=env)
        code, out, err = run('keys', '--job', job_expect, '--text-stdin', '--secret', stdin=FAKE + '\n', env=env)
        clean(out, err, 'keys --text-stdin --secret')
        check('  keys typed it', code == 0 and value_of(job_expect, '#pw') == FAKE, '%s %s' % (code, err[-200:]))

        # a screenshot of a secret-filled tab blurs its fields
        shot = str(Path(tmp.name) / 'shot.png')
        code, out, err = run('screenshot', '--job', job_expect, shot)
        check('screenshot after a secret fill warns and masks', code == 0 and 'secret typed into it' in err
              and '"secretFieldsMasked": true' in out, '%s %s %s' % (code, out[-200:], err[-200:]))
        check('  mask style removed after capture', run('eval', '--job', job_expect,
              'String(document.getElementById("__tophat_cdp_mask"))')[1].strip() == 'null')
        code, out, err = run('screenshot', '--job', job_expect, shot, '--allow-secret-fields')
        check('screenshot --allow-secret-fields captures unmasked, still warns', code == 0 and 'UNMASKED' in err
              and '"secretFieldsMasked": false' in out, '%s %s %s' % (code, out[-200:], err[-200:]))

        # forgiving shapes against the real page
        code, out, err = run('eval', '--job', job_expect, '--expr', '1+1', '--max-chars', '100', '--await')
        check('eval --expr --max-chars --await', code == 0 and out.strip() == '2', '%s %s' % (code, err))
        code, out, err = run('--steal', '--job', job_expect, 'eval', 'document.title', '--timeout', '20')
        check('--steal before the verb', code == 0 and 'secret fixture' in out, '%s %s' % (code, err))
        code, out, err = run('eval', '--job', job_expect, '--stdin', stdin='document.title')
        check('eval --stdin', code == 0 and 'secret fixture' in out, '%s %s' % (code, err))
        code, out, err = run('dom-click', '--job', job_expect, 'input', '--index', '2')
        check('dom-click --index', code == 0 and '"candidates": 3' in out or '"candidates":3' in out, out + err)
        # covered by a sticky footer while "in view": centred and filled; clipped by a collapsed section: refused, named
        job_ov = 'secrets-test-overlay'
        run('job', 'release', job_ov, '--close')
        code, out, err = run('job', 'claim', job_ov, '--url', base + 'overlay')
        check('claim overlay job', code == 0, err)
        run('wait-for', '--job', job_ov, '--selector', '#under', '--timeout', '15')
        code, out, err = run('point', '--job', job_ov, '#under', '--no-scroll')
        check('fixture: #under starts covered by the footer', code == 7, '%s %s' % (code, err[-200:]))
        code, out, err = run('fill', '--job', job_ov, '#under', 'LS-TEST-1')
        check('fill under a sticky footer centres the field and fills it', code == 0 and value_of(job_ov, '#under') == 'LS-TEST-1',
              '%s %s' % (code, err[-300:]))
        code, out, err = run('tap', '--job', job_ov, '#under')
        check('tap under a sticky footer works too', code == 0, '%s %s' % (code, err[-300:]))
        code, out, err = run('fill', '--job', job_ov, '#clipped', 'x')
        check('fill inside a collapsed section is refused and says clipped', code == 7 and 'clipped by' in err
              and value_of(job_ov, '#clipped') == '', '%s %s' % (code, err[-300:]))
        run('job', 'release', job_ov, '--close')
    finally:
        run('job', 'release', job_expect, '--close')
        run('job', 'release', job_plain, '--close')
        run('job', 'release', 'secrets-test-overlay', '--close')
        server.shutdown()
        tmp.cleanup()


if __name__ == '__main__':
    os.environ.pop('TOPHAT_CDP_JOB_HINT', None)
    mod = load_module()
    unit(mod)
    unit_secret_fills(mod)
    if '--no-browser' not in sys.argv:
        browser()
    print('\n%d passed, %d failed' % (len(PASSED), len(FAILED)))
    if FAILED:
        print('FAILED: ' + ', '.join(FAILED))
    sys.exit(1 if FAILED else 0)
