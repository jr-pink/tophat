#!/usr/bin/env python3
"""Python twin for the cdp differential tests: imports cdp/tophat-cdp.py as a module and
answers JSON-line requests on stdin, one JSON line out per request. Never opens a browser socket."""
import contextlib, importlib.machinery, importlib.util, io, json, math, os, sys
from pathlib import Path

CDP_PY = Path(__file__).resolve().parents[2] / 'cdp' / 'tophat-cdp.py'


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(mod)
    return mod


cdp = load('tophat_cdp_py', CDP_PY)
PARSER = cdp.build_parser()
IDENTITY = ('TOPHAT_CDP_JOB', 'TOPHAT_AGENT_ID', 'TOPHAT_CONVERSATION_ID', 'TOPHAT_CDP_JOB_HINT', 'TOPHAT_CDP_JOB_SOURCE')


def clean(v):
    if isinstance(v, float):
        return v if math.isfinite(v) else ('nan' if v != v else ('inf' if v > 0 else '-inf'))
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


def cdp_parse(req):
    for key in IDENTITY:
        os.environ.pop(key, None)
    os.environ.update(req.get('env') or {})
    argv = req['argv'] or ['status']
    out = {}
    try:
        norm, auto = cdp.normalize_argv(list(argv), PARSER)
    except Exception as error:  # the old tool would crash here: record it
        return {'crash': type(error).__name__}
    out['norm'] = norm
    out['hint'] = os.environ.get('TOPHAT_CDP_JOB_HINT')
    out['source'] = os.environ.get('TOPHAT_CDP_JOB_SOURCE')
    buf, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            ns = PARSER.parse_args(norm)
        d = {k: v for k, v in vars(ns).items() if k != 'func'}
        if d.get('command') == 'wait-for' and not (d.get('selector') or d.get('url_changes') or d.get('url_contains') or d.get('text_contains')):
            out['exit'] = 1
        else:
            out['ns'] = clean(d)
    except SystemExit as stop:
        out['exit'] = stop.code if isinstance(stop.code, int) else 1
        if out['exit'] == 0:
            out['help'] = buf.getvalue()
    return out


def fake_session(payload):
    class S:
        origin = None

        def ensure(self, carrier, number=None):
            return None

        def js(self, expression, timeout=None):
            return payload
    return S()


def call(req):
    fn = req['fn']
    if fn == 'cdp.parse':
        return cdp_parse(req)
    if fn == 'cdp.options':  # every option string per verb, for the --help comparison
        subs = PARSER._subparsers._group_actions[0].choices
        return {verb: sorted(s for a in sub._actions for s in a.option_strings) for verb, sub in subs.items()}
    a = req.get('args') or []
    if fn in ('cdp.parse_key', 'cdp.url_drift', 'cdp.sanitize_job_name', 'cdp.looks_like_target', 'cdp.scrub_argparse_message', 'cdp.split_selector'):
        return clean(getattr(cdp, fn.split('.', 1)[1])(*a))
    if fn == 'cdp.check_secret_destination' or fn == 'cdp.check_secret_element':
        try:
            getattr(cdp, fn.split('.', 1)[1])(*a)
            return {'ok': True}
        except cdp.CdpError as error:
            return {'code': error.code}
    raise ValueError(fn)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        result = {'ok': call(json.loads(line))}
    except Exception as error:
        result = {'raised': type(error).__name__, 'message': str(error)[:200]}
    sys.stdout.write(json.dumps(result, default=str) + '\n')
    sys.stdout.flush()
