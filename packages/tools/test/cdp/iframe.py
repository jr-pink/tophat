#!/usr/bin/env python3
"""Measure tophat-cdp's out-of-process-iframe support against a local fixture.

    python3 packages/tools/test/cdp/iframe.py
    python3 ... --keep           leave the tab and the servers running
    python3 ... --only fill,tap  run a subset (substring match on case names)

The fixture (tools/fixtures/cdp-iframe, README beside it) reproduces the seven
things measured on the live Yogibo/Shopify checkout on 2026-10-09: frames whose
urls collide, input that has to go through the page, replace-not-append,
Backspace walking backwards through a segmented card field, DOM values that are
invisible to framework state, an inner scroll container with nothing to scroll
in the window, and a submit button that ignores el.click().

It drives the real CLI, through a job named `iframefix-test`, so exit codes are
part of what is tested. Nothing here touches a payment page or the network.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'fixtures-cdp-iframe'
CDP = str(HERE.parent.parent / 'cdp' / 'tophat-cdp.py')
JOB = os.environ.get('TOPHAT_CDP_TEST_JOB', 'iframefix-test')
PARENT_URL = 'http://127.0.0.1:8910/index.html'
SHADOW_URL = 'http://127.0.0.1:8910/shadow.html'
SAMESITE_URL = 'http://127.0.0.1:8910/samesite.html'
PORTS = ((8910, 'parent'), (8911, 'child'), (8912, 'child'), (8913, 'child'))

PASSED, FAILED = [], []


def run(*args, **kwargs):
    """One tophat-cdp invocation: (exit code, stdout, stderr)."""
    proc = subprocess.run([CDP] + list(args), capture_output=True, text=True,
                          timeout=kwargs.get('timeout', 60))
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def job(*args, **kwargs):
    return run('--job', JOB, *args, **kwargs)


def js(expression):
    code, out, err = job('eval', expression)
    if code != OK_EXIT:
        raise RuntimeError('eval failed (%s): %s' % (code, err))
    return out


OK_EXIT, EUSAGE, EENDPOINT, ETARGET, ETIMEOUT, EREFUSED, EHIJACK, EHITTEST, EVERIFY = range(9)


def check(name, ok, detail=''):
    (PASSED if ok else FAILED).append(name)
    print('%s %-34s %s' % ('PASS' if ok else 'FAIL', name, detail))


def start_servers():
    procs = []
    for port, folder in PORTS:
        procs.append(subprocess.Popen(
            [sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1',
             '--directory', str(FIXTURE / folder)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for _ in range(40):
        time.sleep(0.1)
        try:
            import urllib.request
            urllib.request.urlopen(PARENT_URL, timeout=1).read()
            return procs
        except Exception:
            continue
    raise SystemExit('fixture servers did not come up on %s' % ', '.join(str(p) for p, _ in PORTS))


def reload_page():
    job('navigate', PARENT_URL)
    time.sleep(2.0)


# -- cases -----------------------------------------------------------------

def case_frame_map():
    code, out, _ = job('frame-map', '--json')
    rows = json.loads(out)['frames'] if code == OK_EXIT else []
    by_selector = {r['selector']: r for r in rows}
    want = ['#card-fields-number', '#card-fields-expiry', '#card-fields-verification_value',
            '#card-fields-name', '#card-fields-segmented', '#outer-frame',
            '#outer-frame >>> #inner-frame']
    missing = [w for w in want if w not in by_selector]
    check('frame-map names every frame', code == OK_EXIT and not missing,
          '%d frames, missing %s' % (len(rows), missing or 'none'))
    shared = [r for r in rows if (r.get('frameUrl') or '') == 'http://localhost:8911/field.html']
    ids = {r['targetId'] for r in shared}
    check('three frames share one url', len(shared) == 3 and len(ids) == 3,
          '%d frames, %d distinct target ids' % (len(shared), len(ids)))
    nested = by_selector.get('#outer-frame >>> #inner-frame', {})
    check('nested frame is mapped', bool(nested.get('targetId')),
          'target %s url %s' % (nested.get('targetId'), nested.get('frameUrl')))


def case_url_ambiguity():
    code, out, err = run('eval', 'url=http://localhost:8911/field.html', '1')
    check('ambiguous url selector is an error', code == ETARGET and 'ambiguous' in err.lower(),
          'exit %d' % code)
    code, out, err = run('eval', 'url*=number-ltr', '1')
    check('substring url alias is an error', code == ETARGET and 'ambiguous' in err.lower(),
          'exit %d' % code)


def case_fill_identical_urls():
    reload_page()
    values = {'number': '4242424242424242', 'verification_value': '123', 'name': 'JANE DOE'}
    codes = {}
    for field, value in values.items():
        code, out, err = job('fill', '#card-fields-%s >>> input' % field, value)
        codes[field] = code
    fields = json.loads(js('JSON.stringify(window.__fields)'))
    right = all(fields.get(f) == v for f, v in values.items())
    check('each identical-url frame gets its own value', right and set(codes.values()) == {OK_EXIT},
          json.dumps({k: fields.get(k) for k in values}))


def case_fill_replaces():
    job('fill', '#card-fields-expiry >>> input', '1228')
    code, out, _ = job('fill', '#card-fields-expiry >>> input', '0131')
    value = json.loads(out).get('value') if code == OK_EXIT else None
    check('fill replaces, never appends', code == OK_EXIT and value == '0131',
          'value %r (append would be "12280131")' % value)


def case_fill_trusted_only():
    code, out, _ = job('fill', '#card-fields-expiry >>> input', '0930')
    state = js('document.querySelector("#card-fields-expiry").contentWindow ? "same-origin" : "oopif"')
    check('framework state accepts the fill', code == OK_EXIT, 'exit %d, frame is %s' % (code, state))
    code, out, err = job('fill', '--dom-value', '#card-fields-expiry >>> input', '0101')
    time.sleep(0.4)
    after = json.loads(js('JSON.stringify(window.__fields)')).get('expiry')
    check('--dom-value is rejected by the page', after == '0930',
          'page state still %r after a DOM value write' % after)


def case_page_error():
    code, out, err = job('fill', '#card-fields-expiry >>> input', '12')
    payload = json.loads(out) if out else {}
    check('page validation text fails the fill',
          code == EVERIFY and payload.get('verified') and payload.get('pageMessages'),
          'exit %d, message %s' % (code, payload.get('pageMessages')))
    job('fill', '#card-fields-expiry >>> input', '1228')


def case_clear_vs_backspace():
    reload_page()
    for index, value in enumerate(['1111', '2222', '3333', '4444']):
        job('fill', '#card-fields-segmented >>> #s%d' % index, value)
    before = json.loads(js('JSON.stringify(window.__fields)')).get('segmented')
    code, _out, err = job('clear', '#card-fields-segmented >>> #s3')
    after = json.loads(js('JSON.stringify(window.__fields)')).get('segmented')
    check('clear empties one segment only', code == OK_EXIT and after == '1111 2222 3333 ',
          'before %r after %r' % (before, after))
    # the destructive alternative, measured, for the record
    job('fill', '#card-fields-segmented >>> #s3', '4444')
    job('keys', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace',
        'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace')
    walked = json.loads(js('JSON.stringify(window.__fields)')).get('segmented')
    check('a Backspace loop is destructive (control)', walked != '1111 2222 3333 ',
          'ten Backspaces left %r' % walked)


def case_below_the_fold():
    reload_page()
    scroll = js('JSON.stringify({scrollY: window.scrollY, docH: document.documentElement.scrollHeight,'
                ' innerH: window.innerHeight, boxTop: document.querySelector("#scrollbox").scrollTop})')
    code, out, err = job('point', '--no-scroll', '#pay-button')
    check('window does not scroll, inner box does', json.loads(scroll)['scrollY'] == 0
          and json.loads(scroll)['docH'] == json.loads(scroll)['innerH'], scroll)
    check('out-of-view element exits 7 with --no-scroll', code == EHITTEST, 'exit %d' % code)
    code, out, err = job('point', '#pay-button')
    payload = json.loads(out) if out else {}
    check('point scrolls the inner container into view',
          code == OK_EXIT and payload.get('inView') and payload.get('hit', {}).get('ok'),
          'y=%s hit=%s' % (payload.get('pageY'), (payload.get('hit') or {}).get('hit')))


def case_dom_click_vs_tap():
    reload_page()
    job('dom-click', '#pay-button')
    time.sleep(0.3)
    after_dom = json.loads(js('JSON.stringify({submitted: window.__submitted, ignored: window.__domClickIgnored})'))
    check('dom-click does not submit', after_dom['submitted'] == 0 and after_dom['ignored'] > 0,
          json.dumps(after_dom))
    code, out, err = job('tap', '#pay-button')
    time.sleep(0.4)
    after_tap = json.loads(js('JSON.stringify({submitted: window.__submitted, status: document.getElementById("status").textContent})'))
    check('tap submits', code == OK_EXIT and after_tap['submitted'] == 1,
          'exit %d, %s' % (code, json.dumps(after_tap)))


def case_covered_element():
    reload_page()
    js('(()=>{const d=document.createElement("div");d.id="overlay";'
       'd.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:9999";'
       'document.body.appendChild(d);return 1})()')
    code, out, err = job('tap', '#card-fields-number >>> input')
    check('a covered element exits 7, nothing dispatched',
          code == EHITTEST and 'overlay' in err.lower(), 'exit %d' % code)
    js('document.getElementById("overlay").remove()')


def case_nested_frame():
    reload_page()
    code, out, err = job('fill', '#outer-frame >>> #inner-frame >>> input', 'NESTED OK')
    payload = json.loads(out) if out else {}
    check('fill reaches a doubly nested frame', code == OK_EXIT and payload.get('value') == 'NESTED OK',
          'exit %d value %r' % (code, payload.get('value')))


def case_legacy_frame_target():
    reload_page()
    code, out, _ = job('frame-map', '--json')
    rows = json.loads(out)['frames']
    target = next(r['targetId'] for r in rows if r['selector'] == '#card-fields-name')
    code, out, err = run('fill', target, 'input', 'LEGACY PATH', '--steal')
    payload = json.loads(out) if out else {}
    value = json.loads(js('JSON.stringify(window.__fields)')).get('name')
    check('a bare frame target still works, through the page',
          code == OK_EXIT and value == 'LEGACY PATH',
          'exit %d, page target %s' % (code, payload.get('pageTargetId')))


def _job_file(name):
    root = Path(os.environ.get('TOPHAT_CDP_JOBS', str(Path.home() / '.local/state/tophat/cdp/jobs')))
    return root / (name + '.json')


def _run_env(extra, *args):
    env = dict(os.environ)
    for key in ('TOPHAT_CDP_JOB', 'TOPHAT_AGENT_ID', 'TOPHAT_CONVERSATION_ID'):
        env.pop(key, None)
    env.update(extra)
    proc = subprocess.run([CDP] + list(args), capture_output=True, text=True, timeout=60, env=env)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def case_default_job_name():
    """Resolution order: --job > TOPHAT_CDP_JOB > TOPHAT_AGENT_ID > TOPHAT_CONVERSATION_ID > process."""
    everything = {'TOPHAT_CDP_JOB': 'tj-cdpjob', 'TOPHAT_AGENT_ID': 'tj_agent',
                  'TOPHAT_CONVERSATION_ID': 'tj-conv'}
    made = []
    trials = [
        ('--job wins', dict(everything), ['--job', 'tj-flag', 'info'], 'tj-flag'),
        ('TOPHAT_CDP_JOB', dict(everything), ['info'], 'tj-cdpjob'),
        ('TOPHAT_AGENT_ID', {k: v for k, v in everything.items() if k != 'TOPHAT_CDP_JOB'},
         ['info'], 'tj_agent'),
        ('TOPHAT_CONVERSATION_ID', {'TOPHAT_CONVERSATION_ID': 'tj-conv'}, ['info'], 'tj-conv'),
        ('process fallback', {}, ['info'], 'auto-'),
    ]
    for label, env, argv, want in trials:
        code, out, err = _run_env(env, *argv)
        payload = json.loads(out) if out.startswith('{') else {}
        names = [j['job'] for j in json.loads(run('job', 'list')[1])['jobs']]
        hit = [n for n in names if n == want or (want.endswith('-') and n.startswith(want))]
        made.extend(hit)
        check('default job: ' + label, code == OK_EXIT and bool(hit),
              'claimed %s' % (hit or names[:3]))
    for name in set(made):
        run('job', 'release', name, '--close')
    # an identity that is not a legal job name is cleaned, not rejected
    code, out, err = _run_env({'TOPHAT_AGENT_ID': 'agent/2e36 e1c7!'}, 'info')
    names = [j['job'] for j in json.loads(run('job', 'list')[1])['jobs']]
    cleaned = [n for n in names if n == 'agent-2e36-e1c7']
    check('an illegal identity is sanitised', code == OK_EXIT and bool(cleaned),
          'agent/2e36 e1c7! -> %s' % (cleaned or names[:3]))
    for name in cleaned:
        run('job', 'release', name, '--close')


def case_auto_claim():
    code, out, err = _run_env({'TOPHAT_AGENT_ID': 'tj-auto'}, 'navigate', PARENT_URL)
    payload = json.loads(out) if out.startswith('{') else {}
    record = _job_file('tj-auto')
    opened = record.exists() and json.loads(record.read_text()).get('targetId') == payload.get('targetId')
    check('auto-claim opens its own tab at the url', code == OK_EXIT and opened,
          'target %s' % payload.get('targetId'))
    # the tab another job holds is still refused without --steal
    code, shown, _ = run('job', 'show', JOB)
    held = json.loads(shown)['job']['targetId'] if code == OK_EXIT and isinstance(
        json.loads(shown).get('job'), dict) else json.loads(shown).get('targetId')
    code, out, err = _run_env({'TOPHAT_AGENT_ID': 'tj-auto'}, 'navigate', held, 'about:blank')
    check('auto-claim never steals another job', code == EREFUSED and JOB in err, 'exit %d' % code)
    run('job', 'release', 'tj-auto', '--close')


def case_job_reaper():
    code, out, _ = _run_env({'TOPHAT_AGENT_ID': 'tj-stale'}, 'info')
    stale, fresh = _job_file('tj-stale'), _job_file(JOB)
    record = json.loads(stale.read_text())
    tab = record['targetId']
    record['pid'] = 999999                      # a pid that is not alive
    record['lastSeen'] = '2020-01-01T00:00:00+0000'
    stale.write_text(json.dumps(record))
    before = json.loads(fresh.read_text()) if fresh.exists() else {}
    run('job', 'list')
    tabs = [t['id'] for t in json.loads(run('targets', '--json')[1])]
    check('a dead, idle claim is reaped', not stale.exists(), 'record gone')
    check('its tab is left open', tab in tabs, 'tab %s still there' % tab[:8])
    check('the live job is untouched', fresh.exists()
          and json.loads(fresh.read_text()).get('targetId') == before.get('targetId'),
          'job %s intact' % JOB)
    # same dead pid, but used a moment ago: not stale
    code, out, _ = _run_env({'TOPHAT_AGENT_ID': 'tj-recent'}, 'info')
    recent = _job_file('tj-recent')
    record = json.loads(recent.read_text())
    record['pid'] = 999999
    recent.write_text(json.dumps(record))
    run('job', 'list')
    check('a recently used claim survives a dead pid', recent.exists(), 'kept')
    run('job', 'release', 'tj-recent', '--close')


# -- shadow DOM --------

def shadow_page():
    job('navigate', SHADOW_URL)
    time.sleep(2.0)


def shadow_state():
    return json.loads(js('JSON.stringify({fields: window.__fields, continued: window.__continued,'
                         ' ignored: window.__domClickIgnored, toggled: window.__toggled})'))


def case_shadow_frame_map():
    shadow_page()
    code, out, err = job('frame-map', '--json')
    rows = json.loads(out)['frames'] if code == OK_EXIT else []
    acct = [r for r in rows if r.get('name') == 'shadowacct']
    check('shadow: frame-map finds the iframe two shadow roots deep',
          len(acct) == 1 and bool(acct[0].get('targetId')) and acct[0].get('shadow'),
          '%d frames, shadowacct %s' % (len(rows), acct[0]['selector'] if acct else 'missing'))
    cards = [r for r in rows if not r.get('name') and r.get('shadow')]
    sels = [r['selector'] for r in cards]
    check('shadow: unnamed shadow iframes get distinct host >>> iframe selectors',
          len(cards) == 2 and len(set(sels)) == 2 and all('>>>' in s for s in sels)
          and all(r.get('targetId') for r in cards), json.dumps(sels))
    values = ['1111', '2222']
    codes = [job('fill', s + ' >>> input', v)[0] for s, v in zip(sels, values)]
    reads = []
    for s in sels:
        c, o, _ = job('point', '--no-scroll', s + ' >>> input')
        reads.append((json.loads(o).get('element') or {}).get('value') if o.startswith('{') else None)
    check('shadow: each frame-map selector reaches its own frame', codes == [OK_EXIT, OK_EXIT] and reads == values,
          'codes %s values %s' % (codes, reads))


def case_shadow_fill_through_frame():
    shadow_page()
    code, out, err = job('fill', 'iframe[name=shadowacct] >>> input', '4242')
    got = shadow_state()['fields'].get('shadowacct')
    check('shadow: fill IFRAME >>> input when the iframe is in a shadow root', code == OK_EXIT and got == '4242',
          'exit %d value %r %s' % (code, got, err[-160:]))
    code, out, err = job('fill', 'x-outer >>> x-pay >>> #pay-frame >>> #field', '5353')
    got = shadow_state()['fields'].get('shadowacct')
    check('shadow: explicit shadow-host hops with >>>', code == OK_EXIT and got == '5353',
          'exit %d value %r %s' % (code, got, err[-160:]))
    code, out, err = job('fill', 'iframe[src*=nowhere] >>> #x', 'no')
    check('shadow: a missing frame lists the shadow iframes', code == ETARGET and 'pay-frame' in err,
          'exit %d %s' % (code, err[-200:].replace('\n', ' ')))


def case_shadow_frame_target_click():
    shadow_page()
    code, out, _ = job('frame-map', '--json')
    rows = json.loads(out)['frames'] if code == OK_EXIT else []
    target = next((r['targetId'] for r in rows if r.get('name') == 'shadowacct'), None)
    code, out, err = run('click', target or 'missing', '20', '15', '--steal')
    # where the page-routed click landed, drilled through shadow roots: it must be the embedding iframe.
    # (Focus is not asserted: a page-level click into an OOPIF of a background tab does not move focus
    # into it, with or without shadow DOM; that is why fill clicks inside the owning frame.)
    xy = out.rsplit(' at ', 1)[-1].split(',') if code == OK_EXIT else ['0', '0']
    landed = js('(()=>{let h=document.elementFromPoint(%s,%s);while(h&&h.shadowRoot){const i=h.shadowRoot'
                '.elementFromPoint(%s,%s);if(!i||i===h)break;h=i};return h?h.tagName+"#"+h.id:null})()'
                % (xy[0], xy[1], xy[0], xy[1]))
    check('shadow: click FRAME_TARGET X Y finds its embedding iframe', code == OK_EXIT and 'pay-frame' in landed,
          'exit %d landed on %s %s' % (code, landed, err[-200:].replace('\n', ' ')))


def case_shadow_elements():
    shadow_page()
    code, out, err = job('fill', '#memo', 'hello shadow')
    check('shadow: a plain selector reaches an input in a shadow root',
          code == OK_EXIT and shadow_state()['fields'].get('memo') == 'hello shadow', 'exit %d %s' % (code, err[-160:]))
    code, out, err = job('tap', 'button')
    check('shadow: tap with an ambiguous selector exits 3', code == ETARGET and 'ambiguous' in err, 'exit %d' % code)
    code, out, err = job('tap', 'button', '--text', 'continue')
    state = shadow_state()
    check('shadow: tap --text picks the trusted-only button', code == OK_EXIT and state['continued'] == 1,
          'exit %d %s %s' % (code, json.dumps(state), err[-160:]))
    code, out, err = job('point', 'button', '--text', 'cancel')
    payload = json.loads(out) if out.startswith('{') else {}
    check('shadow: point --text hit-tests inside the shadow root',
          code == OK_EXIT and (payload.get('element') or {}).get('id') == 'cancel', 'exit %d %s' % (code, err[-160:]))
    code, out, err = job('dom-click', 'button', '--text', 'toggle')
    code2, out2, err2 = job('dom-click', '#toggle')
    state = shadow_state()
    check('shadow: dom-click (selector and --text) reaches shadow buttons',
          code == OK_EXIT and code2 == OK_EXIT and state['toggled'] == 2, 'exits %d %d %s' % (code, code2, json.dumps(state)))
    code, out, err = job('wait-for', '--selector', '#continue', '--timeout', '3')
    code2, out2, _ = job('html', '#memo')
    check('shadow: wait-for and html see shadow elements', code == OK_EXIT and code2 == OK_EXIT and 'memo' in out2,
          'exits %d %d' % (code, code2))


def samesite_page():
    job('navigate', SAMESITE_URL)
    time.sleep(2.0)


def samesite_fields():
    return json.loads(js('JSON.stringify(window.__fields)'))


def case_samesite_nested_fill():
    """Home Depot CVV shape: page -> same-site cross-origin frame (no target) -> OOPIF -> input."""
    samesite_page()
    code, out, err = job('fill', '#pay-outer >>> iframe >>> #field', '4242')
    payload = json.loads(out) if out.startswith('{') else {}
    got = samesite_fields().get('cvv')
    check('same-process outer frame: fill OUTER >>> iframe >>> input',
          code == OK_EXIT and got == '4242' and payload.get('value') == '4242',
          'exit %d value %r readback %r %s' % (code, got, payload.get('value'), err[-200:].replace('\n', ' ')))
    code, out, err = job('fill', '#pay-outer >>> #cvv-frame >>> #field', '999')
    got = samesite_fields().get('cvv')
    check('same-process outer frame: replace, not append', code == OK_EXIT and got == '999',
          'exit %d value %r %s' % (code, got, err[-200:].replace('\n', ' ')))


def case_samesite_direct_field():
    samesite_page()
    code, out, err = job('fill', '#pay-outer >>> #direct', 'DIRECT')
    got = samesite_fields().get('direct')
    check('same-process frame: a field directly inside it', code == OK_EXIT and got == 'DIRECT',
          'exit %d value %r %s' % (code, got, err[-200:].replace('\n', ' ')))


def case_samesite_point_tap_map():
    samesite_page()
    code, out, err = job('point', '#pay-outer >>> iframe >>> #field')
    payload = json.loads(out) if out.startswith('{') else {}
    frames = payload.get('frames') or []
    check('same-process outer frame: point resolves two hops', code == OK_EXIT and len(frames) == 3,
          'exit %d %d hops %s' % (code, len(frames), err[-160:]))
    code, out, err = job('tap', '#pay-outer >>> iframe >>> #field')
    check('same-process outer frame: tap reaches the inner input', code == OK_EXIT, 'exit %d %s' % (code, err[-160:]))
    code, out, _ = job('frame-map', '--json')
    rows = json.loads(out)['frames'] if code == OK_EXIT else []
    sels = [r['selector'] for r in rows]
    check('same-process outer frame: frame-map lists the frame inside it',
          '#pay-outer' in sels and any(s.startswith('#pay-outer >>> ') for s in sels), json.dumps(sels))


def case_samesite_errors():
    samesite_page()
    code, out, err = job('fill', '#pay-outer >>> iframe >>> #nope', 'x')
    check('same-process outer frame: a missing inner element is a clear error',
          code == ETARGET and 'no element matches' in err and 'not a live target' not in err,
          'exit %d %s' % (code, err[-200:].replace('\n', ' ')))


CASES = [case_frame_map, case_url_ambiguity, case_fill_identical_urls, case_fill_replaces,
         case_fill_trusted_only, case_page_error, case_clear_vs_backspace, case_below_the_fold,
         case_dom_click_vs_tap, case_covered_element, case_nested_frame, case_legacy_frame_target,
         case_shadow_frame_map, case_shadow_fill_through_frame, case_shadow_frame_target_click,
         case_shadow_elements,
         case_samesite_nested_fill, case_samesite_direct_field, case_samesite_point_tap_map, case_samesite_errors,
         case_default_job_name, case_auto_claim, case_job_reaper]


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--keep', action='store_true', help='leave the tab and the servers up')
    parser.add_argument('--only', help='comma list of substrings; run only matching cases')
    args = parser.parse_args()

    servers = start_servers()
    code, out, err = run('job', 'claim', JOB, '--url', PARENT_URL)
    if code != OK_EXIT:
        raise SystemExit('could not claim job %s: %s' % (JOB, err))
    time.sleep(2.0)
    try:
        for case in CASES:
            name = case.__name__.replace('case_', '')
            if args.only and not any(piece.strip() in name for piece in args.only.split(',')):
                continue
            try:
                case()
            except Exception as error:  # a crashed case is a failure, not a stack trace
                check(name + ' (crashed)', False, repr(error))
    finally:
        if not args.keep:
            run('job', 'release', JOB, '--close')
            for proc in servers:
                proc.send_signal(signal.SIGTERM)
        else:
            print('\nkept: job %s on %s, servers on %s'
                  % (JOB, PARENT_URL, ', '.join(str(p) for p, _ in PORTS)))
    print('\n%d passed, %d failed%s' % (len(PASSED), len(FAILED),
                                        (': ' + ', '.join(FAILED)) if FAILED else ''))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
