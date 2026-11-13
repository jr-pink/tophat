#!/usr/bin/env python3
"""Captures one harness fixture as frag/NAME.json (rendered html + the stylesheet rules that apply to it).

    CDP_TOOL=<browser tool> HARNESS_TARGET=<tab id> [CDP_ARGS='--job NAME'] python3 capture.py NAME FIXTURE [selector-to-click ...]

The harness (harness/) must be running (`npx vite --config harness/vite.config.js`); HARNESS_TARGET is a tab of a Chrome the tool drives.
The tool is called as `$CDP_TOOL eval|navigate|tap TARGET ...`. Clicks are real clicks (a fold the figure shows open is opened by clicking it).
"""
import json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
TOOL, TARGET = os.environ['CDP_TOOL'], os.environ['HARNESS_TARGET']
URL = os.environ.get('HARNESS_URL', 'http://127.0.0.1:5199')

def cdp(*a):
    return subprocess.run([TOOL, *a, *os.environ.get('CDP_ARGS', '').split()], capture_output=True, text=True)

name, fixture, *taps = sys.argv[1:]
cdp('eval', TARGET, 'localStorage.clear()')          # folds are remembered per chat: start every capture closed
cdp('navigate', TARGET, f'{URL}/?f={fixture}'); time.sleep(4)
for sel in taps:
    r = cdp('tap', TARGET, sel); time.sleep(0.6)
    if r.returncode: print('tap failed', sel, r.stderr[-300:])
js = open(os.path.join(HERE, 'extract.js')).read()
out = cdp('eval', TARGET, f"({js})('#app')").stdout.strip().split('\n')[0]
d = json.loads(json.loads(out) if out.startswith('"') else out)
# keep only the harness build's own component rules; the global ones come from the app shell capture
import re
d['css'] = [r for r in d['css'] if re.search(r'\.s-[A-Za-z0-9_-]{6}', r) or r.startswith('@keyframes')]
os.makedirs(os.path.join(HERE, 'frag'), exist_ok=True)
with open(os.path.join(HERE, 'frag', f'{name}.json'), 'w') as f: json.dump(d, f, separators=(',', ':'))
print(name, [len(x) for x in d['html']], len(d['css']))
