#!/usr/bin/env python3
"""tophat-cdp: drive the local Chrome over the DevTools Protocol from the shell.

Installed as ~/.local/bin/tophat-cdp (symlink). Verbs, the seven CDP gotchas,
exit codes (0 ok, 1 usage, 2 endpoint, 3 target/JS, 4 timeout, 5 refused,
6 drift) and the job model are in README-tophat-cdp.md beside this file.
"""

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def env_get(name, default=None):
    """$TOPHAT_X, else <$TOPHAT_LEGACY_ENV_PREFIX>X when that prefix is set (an older install's names)."""
    value = os.environ.get(name)
    prefix = os.environ.get('TOPHAT_LEGACY_ENV_PREFIX', '')
    if not value and prefix and name.startswith('TOPHAT_'):
        value = os.environ.get(prefix + name[len('TOPHAT_'):])
    return value if value else default


CONFIG_DIR = Path(env_get('TOPHAT_CONFIG_DIR', str(Path.home() / '.config/tophat')))
STATE_DIR = Path(env_get('TOPHAT_STATE_DIR', str(Path.home() / '.local/state/tophat')))

# --- self-bootstrap -------------------------------------------------------
# The script may be run by anything on this Mac, so it must not assume the
# interpreter has websocket-client. If the import fails, re-exec through
# `uv run --with websocket-client python`, once (guarded by an env flag).
try:
    import websocket  # type: ignore
except ImportError:  # pragma: no cover - exercised only on a bare interpreter
    if env_get('TOPHAT_CDP_BOOTSTRAPPED'):
        sys.stderr.write('tophat-cdp: websocket-client unavailable even after uv bootstrap\n')
        sys.exit(1)
    uv = env_get('TOPHAT_UV') or str(Path.home() / '.local/bin/uv')
    if not os.path.exists(uv):
        uv = 'uv'
    env = dict(os.environ, TOPHAT_CDP_BOOTSTRAPPED='1')
    os.execvpe(uv, [uv, 'run', '--quiet', '--with', 'websocket-client', 'python',
                    os.path.realpath(__file__)] + sys.argv[1:], env)

OK, EUSAGE, EENDPOINT, ETARGET, ETIMEOUT, EREFUSED, EHIJACK = 0, 1, 2, 3, 4, 5, 6
# 7: the element could not be put under the pointer (not in view, or the hit test
#    landed on something else) and NOTHING was dispatched.
# 8: the action was dispatched and the verification disagreed: the readback is not
#    what we typed, or the embedding page shows a validation message for the field.
EHITTEST, EVERIFY = 7, 8

DEFAULT_PROTECT_FILE = CONFIG_DIR / 'cdp-protected-targets.txt'


class CdpError(Exception):
    def __init__(self, message, code=ETARGET):
        super().__init__(message)
        self.code = code


# --- endpoint discovery (unchanged semantics) -----------------------------

def discover():
    """Return (endpoint, source). Local-only, never guesses a port."""
    config = Path(env_get('TOPHAT_CONFIG', str(CONFIG_DIR / 'config.json')))
    override = env_get('TOPHAT_CDP_ENDPOINT') or env_get('TOPHAT_RUNNER_BROWSER_CDP') or env_get('TOPHAT_REV5_BROWSER_CDP')
    endpoint = override
    if not endpoint:
        try:
            data = json.loads(config.read_text())
            endpoint = data.get('browserCdp') or data.get('rev5', {}).get('browserCdp')
        except FileNotFoundError:
            raise CdpError('No browser configuration at %s; set TOPHAT_CDP_ENDPOINT or browserCdp in that file (inspect local configuration instead of guessing a port)' % config, EUSAGE)
    if not endpoint:
        raise CdpError('No browserCdp configured; set TOPHAT_CDP_ENDPOINT or browserCdp in the config file (inspect local configuration instead of guessing a port)', EUSAGE)
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.username or parsed.password:
        raise CdpError('Expected a local HTTP CDP endpoint', EUSAGE)
    source = 'environment' if override else str(config) + '#browserCdp'
    return endpoint.rstrip('/'), source


def launchd_label():
    return env_get('TOPHAT_CDP_LAUNCHD_LABEL', '')


def refused_hint(error):
    # A refused connection means Chrome is down; when its launchd agent is named, say how to bring it back.
    text = str(error)
    if 'refused' in text.lower() or 'Errno 61' in text or isinstance(error, ConnectionRefusedError) \
            or isinstance(getattr(error, 'reason', None), ConnectionRefusedError):
        label = launchd_label()
        if not label:
            return '; Chrome is not listening. Start Chrome with --remote-debugging-port.'
        return ('; Chrome is not listening. It is owned by the launchd agent %s: '
                '`launchctl kickstart -k gui/$(id -u)/%s` (if not loaded: '
                '`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/%s.plist`)' % (label, label, label))
    return ''


def http_json(endpoint, path, timeout=5):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(endpoint + path, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise CdpError('%s returned HTTP %s (note: /json/new is 405 on this Chrome; use `new`, which goes through Target.createTarget)' % (path, error.code), EENDPOINT)
    except Exception as error:
        raise CdpError('CDP endpoint %s unreachable: %s%s' % (endpoint, error, refused_hint(error)), EENDPOINT)


def browser_socket_url(endpoint):
    version = http_json(endpoint, '/json/version')
    url = version.get('webSocketDebuggerUrl')
    if not url:
        raise CdpError('Endpoint did not return a CDP browser socket', EENDPOINT)
    return url, version


def target_socket_url(endpoint, target_id):
    # Gotcha 3: /devtools/page/<id> is correct for every attachable target,
    # iframe (OOPIF) targets included.
    host = urllib.parse.urlparse(endpoint).netloc
    return 'ws://%s/devtools/page/%s' % (host, target_id)


# --- websocket plumbing ---------------------------------------------------

class Conn(object):
    """One DevTools websocket, synchronous request/response, events discarded."""

    def __init__(self, url, timeout=20.0):
        self.url = url
        self.timeout = timeout
        self._next_id = 0
        try:
            # Gotcha 1: suppress_origin=True or Chrome answers the handshake
            # with HTTP 403.
            self.ws = websocket.create_connection(url, timeout=timeout, suppress_origin=True)
        except Exception as error:
            raise CdpError('could not open DevTools socket %s: %s%s' % (url, error, refused_hint(error)), EENDPOINT)
        self.events = []

    def send(self, method, params=None, timeout=None):
        self._next_id += 1
        message_id = self._next_id
        payload = {'id': message_id, 'method': method, 'params': params or {}}
        self.ws.send(json.dumps(payload))
        deadline = time.time() + (timeout or self.timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CdpError('%s timed out after %.0fs' % (method, timeout or self.timeout), ETIMEOUT)
            self.ws.settimeout(remaining)
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                raise CdpError('%s timed out after %.0fs' % (method, timeout or self.timeout), ETIMEOUT)
            except Exception as error:
                raise CdpError('%s failed on the socket: %s' % (method, error), EENDPOINT)
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if message.get('id') != message_id:
                if 'method' in message:
                    self.events.append(message)
                continue
            if 'error' in message:
                error = message['error']
                raise CdpError('%s failed: %s (%s)' % (method, error.get('message'), error.get('code')))
            return message.get('result', {})

    def focus_emulation(self, enabled=True):
        """Gotcha 7: without this, key events into a non-focused tab vanish."""
        try:
            self.send('Emulation.setFocusEmulationEnabled', {'enabled': bool(enabled)})
            return True
        except CdpError:
            return False

    def drain(self, seconds=0.0):
        """Collect events already queued, without blocking beyond `seconds`."""
        deadline = time.time() + seconds
        while True:
            remaining = deadline - time.time()
            self.ws.settimeout(max(remaining, 0.001))
            try:
                raw = self.ws.recv()
            except Exception:
                break
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if 'method' in message:
                self.events.append(message)
            if remaining <= 0:
                break
        return self.events

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


# --- target listing and selection ----------------------------------------

def list_targets(endpoint):
    """Every target, from /json/list (HTTP, no socket, touches nothing)."""
    raw = http_json(endpoint, '/json/list')
    out = []
    for entry in raw:
        out.append({
            'id': entry.get('id'),
            'type': entry.get('type'),
            'title': entry.get('title', ''),
            'url': entry.get('url', ''),
            'attached': entry.get('attached'),
            'parentId': entry.get('parentId'),
        })
    return out


ID_RE = re.compile(r'^[0-9A-Fa-f]{6,}$')


SELECTOR_PREFIXES = ('url=', 'url^=', 'url*=', 'title*=', 'job=')


def looks_like_target(piece):
    """Is this positional a target selector, or the verb's own argument?

    `tophat-cdp eval 'document.title'` and `tophat-cdp fill '#card >>> input' 42`
    name no target, so they get the default job; `tophat-cdp eval <32-hex id>
    ...` names one and is left exactly as it was.
    """
    if not piece:
        return False
    return bool(ID_RE.match(piece)) or piece.startswith(SELECTOR_PREFIXES)


def resolve_target(endpoint, spec, want_types=None):
    """Turn a target selector into exactly one target dict.

    Gotcha 5: ambiguity is an error, never a silent first match.
    Accepted forms:
      <32-hex id>          exact target id
      <hex prefix>         unique id prefix (>= 6 chars)
      url=<URL>            exact url equality
      url^=<PREFIX>        url starts with
      url*=<SUBSTR>        url contains, must match exactly one target
      title*=<SUBSTR>      title contains, must match exactly one target
    """
    targets = list_targets(endpoint)
    if want_types:
        pool = [t for t in targets if t['type'] in want_types] or targets
    else:
        pool = targets

    def unique(matches, how):
        if not matches:
            raise CdpError('no target matched %s (%s)' % (spec, how))
        if len(matches) > 1:
            lines = ['%s  %-8s %s' % (m['id'], m['type'], m['url'][:110]) for m in matches]
            raise CdpError('ambiguous target selector %s (%s) matched %d targets; be exact:\n  %s'
                           % (spec, how, len(matches), '\n  '.join(lines)))
        return matches[0]

    for prefix, how in (('url=', 'exact url'), ('url^=', 'url prefix'), ('url*=', 'url substring'),
                        ('title*=', 'title substring')):
        if spec.startswith(prefix):
            value = spec[len(prefix):]
            if prefix == 'url=':
                matches = [t for t in pool if t['url'] == value]
            elif prefix == 'url^=':
                matches = [t for t in pool if t['url'].startswith(value)]
            elif prefix == 'url*=':
                matches = [t for t in pool if value in t['url']]
            else:
                matches = [t for t in pool if value in (t['title'] or '')]
            return unique(matches, how)

    if ID_RE.match(spec):
        exact = [t for t in targets if (t['id'] or '').upper() == spec.upper()]
        if exact:
            return exact[0]
        matches = [t for t in targets if (t['id'] or '').upper().startswith(spec.upper())]
        return unique(matches, 'id prefix')
    raise CdpError('unrecognised target selector %r; use an id, an id prefix, url=, url^=, url*= or title*=' % spec, EUSAGE)


# --- protected targets ----------------------------------------------------

def protected_ids():
    """Target ids that mutating verbs refuse to touch.

    Sources: $TOPHAT_CDP_PROTECTED (comma separated) and the file
    $TOPHAT_CONFIG_DIR/cdp-protected-targets.txt (one id per line, # comments).
    A live checkout or a signed-in session an agent must not disturb goes here.
    """
    ids = set()
    env = env_get('TOPHAT_CDP_PROTECTED', '')
    for piece in env.replace(',', ' ').split():
        ids.add(piece.strip().upper())
    path = Path(env_get('TOPHAT_CDP_PROTECT_FILE', str(DEFAULT_PROTECT_FILE)))
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.split('#', 1)[0].strip()
            if line:
                ids.add(line.upper())
    return ids


def guard(target, args, action):
    if getattr(args, 'force', False):
        return
    if (target['id'] or '').upper() in protected_ids():
        raise CdpError('refusing to %s protected target %s (%s). It is listed in %s or $TOPHAT_CDP_PROTECTED; pass --force only if you own it.'
                       % (action, target['id'], target['url'][:80], DEFAULT_PROTECT_FILE), EREFUSED)


def warn_input_target(target, verb):
    """Gotcha 4: input into an OOPIF sometimes lands and sometimes vanishes.

    Not a refusal, because it was measured working; a warning plus, where the
    verb can, a read-back check.
    """
    if target['type'] == 'iframe':
        sys.stderr.write(
            'warning: %s is an iframe (OOPIF) target. Input events there are sometimes accepted and silently '
            'ignored (seen on Shopify checkout frames). Verify the result; if nothing landed use `dom-click` or '
            '`fill %s SELECTOR TEXT --input-target <PAGE_ID>`.\n' % (target['id'], target['id']))


# Two agents each claim a job, every command names its job, and a mutating verb
# aimed at a tab another live job holds is refused by name (--steal overrides).
# Lockless: nothing waits, nothing blocks.
#
# "Place your order" read as missing, and a checkout run died with "Cannot read
# properties of null (reading 'innerText')" because the page under it was a
# product page. Nothing noticed the tab had moved. Owning the tab and
# fingerprinting its url makes that an error with a name.

JOBS_DIR = Path(env_get('TOPHAT_CDP_JOBS', str(STATE_DIR / 'cdp/jobs')))
UI_JOBS_DIR = Path(env_get('TOPHAT_UI_JOBS', str(STATE_DIR / 'ui/jobs')))
JOB_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$')

# Verbs that change a page or the tab itself. These refuse another job's tab.
MUTATING_VERBS = ('close', 'activate', 'navigate', 'reload', 'click', 'dom-click',
                  'type', 'keys', 'fill', 'eval', 'tap', 'clear', 'dialog', 'upload')
# Every verb that takes a target, so `--job NAME` can stand in for it.
TARGET_VERBS = MUTATING_VERBS + ('info', 'html', 'text', 'screenshot', 'pdf', 'download', 'wait-for',
                                 'frame-map', 'point')


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
    except (OSError, TypeError, ValueError):
        return False
    return True


def check_job_name(name):
    if not name or not JOB_NAME_RE.match(name):
        raise CdpError('bad job name %r; use letters, digits, . _ - @ (max 64 chars)' % (name,), EUSAGE)
    return name


JOB_TTL_SECONDS = float(env_get('TOPHAT_CDP_JOB_TTL', 3600))

# Where a default job name comes from, best first.
JOB_NAME_SOURCES = ('TOPHAT_CDP_JOB', 'TOPHAT_AGENT_ID', 'TOPHAT_CONVERSATION_ID')


def sanitize_job_name(value, prefix='agent-'):
    """Any identity string -> a legal job name (check_job_name's alphabet)."""
    cleaned = re.sub(r'[^A-Za-z0-9._@-]', '-', (value or '').strip())
    cleaned = re.sub(r'-{2,}', '-', cleaned).strip('-')
    if not cleaned:
        return None
    if not cleaned[0].isalnum():
        cleaned = prefix + cleaned
    return cleaned[:64].rstrip('-') or None


def default_job_name():
    """(name, source) for a caller that named no job.

    An unnamed call never acts on an arbitrary tab: it gets its own, named after
    whoever is calling (the agent id, else the conversation id, else the process).
    """
    for variable in JOB_NAME_SOURCES:
        name = sanitize_job_name(env_get(variable))
        if name:
            return name, variable
    # No identity in the environment: one job per calling process tree, stable
    # for the life of that shell, so repeated commands share one tab.
    return sanitize_job_name('auto-%d' % os.getppid()) or 'auto', 'process'


def job_path(name):
    return JOBS_DIR / (check_job_name(name) + '.json')


def load_job(name):
    try:
        return json.loads(job_path(name).read_text())
    except (OSError, ValueError):
        return None


def save_job(job):
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    path = job_path(job['job'])
    tmp = path.with_suffix('.json.tmp.%d' % os.getpid())
    tmp.write_text(json.dumps(job, indent=2, sort_keys=True))
    os.replace(str(tmp), str(path))
    return job


def save_job_exclusive(job):
    """Create the job file only if nobody else did; lockless claim race-breaker."""
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    path = job_path(job['job'])
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return None
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(job, indent=2, sort_keys=True))
    return job


def all_jobs():
    out = []
    try:
        names = sorted(p.name for p in JOBS_DIR.iterdir() if p.name.endswith('.json'))
    except OSError:
        return out
    for name in names:
        job = load_job(name[:-5])
        if job and job.get('job'):
            out.append(job)
    return out


def ui_jobs():
    """the UI-automation tool's own registry, read only. The job NAMESPACE is shared by
    convention: `shop` should mean the same piece of work in both tools."""
    out = {}
    try:
        names = [p for p in UI_JOBS_DIR.iterdir() if p.name.endswith('.json')]
    except OSError:
        return out
    for path in names:
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get('job'):
            out[record['job']] = record
    return out


def release_job(name):
    try:
        job_path(name).unlink()
        return True
    except OSError:
        return False


def url_parts(url):
    parsed = urllib.parse.urlparse(url or '')
    segments = [s for s in (parsed.path or '').split('/') if s]
    return parsed.scheme, parsed.netloc, (segments[0] if segments else '')


def url_drift(expected, current):
    """The anti-yank signal: has this tab left where the job put it?

    Origin change, or a change of the first path segment, is drift. Anything
    finer is normal navigation inside a site, and a warning nobody reads is a
    warning that hides the real one.
    """
    if not expected or not current or expected in ('about:blank', 'chrome://newtab/'):
        return None
    escheme, ehost, epath = url_parts(expected)
    cscheme, chost, cpath = url_parts(current)
    if not chost and not ehost:
        return None
    if (escheme, ehost) != (cscheme, chost):
        return 'origin changed from %s://%s to %s://%s' % (escheme, ehost, cscheme or '?', chost or '?')
    if epath and epath != cpath:
        return 'path moved from /%s/... to /%s' % (epath, cpath or '')
    return None


def live_targets_by_id(endpoint, targets=None):
    targets = list_targets(endpoint) if targets is None else targets
    return {(t['id'] or '').upper(): t for t in targets}


def target_owner(endpoint, target_id, exclude=None, targets=None, jobs=None):
    """The live job holding this target, or None. A job whose tab is gone
    holds nothing, so a dead entry never blocks anyone."""
    live = live_targets_by_id(endpoint, targets)
    wanted = (target_id or '').upper()
    for job in (all_jobs() if jobs is None else jobs):
        if job.get('job') == exclude:
            continue
        if (job.get('targetId') or '').upper() != wanted:
            continue
        if wanted in live:
            return job
    return None


def job_age_seconds(job):
    stamp = job.get('lastSeen') or job.get('since')
    if not stamp:
        return None
    for shape in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S'):
        try:
            return max(time.time() - time.mktime(time.strptime(stamp, shape)) +
                       (time.timezone if shape.endswith('S') else 0), 0)
        except ValueError:
            continue
    return None


def job_is_stale(job, ttl=None):
    """An abandoned claim: its owner process is gone AND nothing has used it
    for a while.

    The second half matters, and it is why a dead pid alone is not the test:
    every tophat-cdp invocation is its own short-lived process, so the pid in a
    perfectly healthy job record is dead within a second of the claim (that is
    why `job list` showed amazon with pidAlive false while the checkout was
    live). `lastSeen` is rewritten by every command that resolves the job, so
    an idle gap is the real abandonment signal. A job whose owner is still
    running is never stale, however old.
    """
    ttl = JOB_TTL_SECONDS if ttl is None else ttl
    pid = job.get('pid')
    if pid and pid_alive(pid):
        return False
    age = job_age_seconds(job)
    return age is not None and age > ttl


def reap_jobs(endpoint, targets=None, ttl=None):
    """Drop entries whose tab is gone, and release claims nobody owns any more.

    A stale claim loses the NAME, never the TAB: an agent's tab stays open and
    visible, it just stops being spoken for, so auto-claimed jobs cannot pile
    up forever and nothing an agent opened vanishes under its owner.
    """
    targets = list_targets(endpoint) if targets is None else targets
    live = live_targets_by_id(endpoint, targets)
    reaped = []
    for job in all_jobs():
        if (job.get('targetId') or '').upper() not in live and refind_target(job, targets) is None:
            release_job(job['job'])
            reaped.append(job['job'])
            continue
        if job_is_stale(job, ttl=ttl):
            release_job(job['job'])
            reaped.append(job['job'])
    return reaped


def refind_target(job, targets):
    """A tab id dies when the tab is recreated. Re-find it by the fingerprint
    the job recorded, and only when exactly one unheld page matches."""
    held = {(j.get('targetId') or '').upper() for j in all_jobs() if j.get('job') != job.get('job')}
    pages = [t for t in targets if t.get('type') == 'page' and (t['id'] or '').upper() not in held]
    for key in ('lastUrl', 'lastTitle'):
        value = job.get(key)
        if not value:
            continue
        field = 'url' if key == 'lastUrl' else 'title'
        matches = [t for t in pages if (t.get(field) or '') == value]
        if len(matches) == 1:
            return matches[0]
    return None


def create_target(endpoint, url, background=True, new_context=False):
    def run(conn):
        params = {'url': url, 'background': bool(background)}
        if new_context:
            context = conn.send('Target.createBrowserContext', {'disposeOnDetach': False})
            params['browserContextId'] = context['browserContextId']
        return conn.send('Target.createTarget', params)['targetId']
    return with_browser(endpoint, run)


def close_target(endpoint, target_id):
    try:
        with_browser(endpoint, lambda c: c.send('Target.closeTarget', {'targetId': target_id}))
        return True
    except CdpError:
        return False


def new_job_record(name, target_id, url=None, title=None, ephemeral=False,
                   expect_prefix=None, tool='tophat-cdp'):
    stamp = now_iso()
    return {'job': name, 'targetId': target_id, 'pid': os.getpid(), 'ppid': os.getppid(),
            'tool': tool, 'since': stamp, 'lastSeen': stamp,
            'lastUrl': url, 'lastTitle': title, 'expectPrefix': expect_prefix,
            'ephemeral': bool(ephemeral)}


def claim_job(endpoint, name, url=None, target_id=None, steal=False, background=True,
              new_context=False, fresh=False, ephemeral=False, expect_prefix=None,
              tool='tophat-cdp', navigate=True):
    """Own a tab under this name. Returns (job, how) with how in
    created / reused / adopted / recovered."""
    check_job_name(name)
    targets = list_targets(endpoint)
    reap_jobs(endpoint, targets)

    if target_id:
        target = resolve_target(endpoint, target_id)
        owner = target_owner(endpoint, target['id'], exclude=name, targets=targets)
        if owner and not steal:
            raise CdpError('target %s (%s) is already job %s (pid %s, since %s); pass --steal to take it'
                           % (target['id'], (target['url'] or '')[:70], owner['job'],
                              owner.get('pid'), owner.get('since')), EREFUSED)
        if (target['id'] or '').upper() in protected_ids() and not steal:
            raise CdpError('target %s is on the protected list in %s; pass --steal only if you own it'
                           % (target['id'], DEFAULT_PROTECT_FILE), EREFUSED)
        job = new_job_record(name, target['id'], url=url or target.get('url'),
                             title=target.get('title'), ephemeral=ephemeral,
                             expect_prefix=expect_prefix, tool=tool)
        save_job(job)
        return job, 'adopted'

    existing = load_job(name)
    if existing and not fresh:
        live = live_targets_by_id(endpoint, targets)
        target = live.get((existing.get('targetId') or '').upper()) or refind_target(existing, targets)
        if target is not None:
            how = 'reused' if (existing.get('targetId') or '').upper() == (target['id'] or '').upper() else 'recovered'
            existing['targetId'] = target['id']
            existing['lastSeen'] = now_iso()
            existing['lastTitle'] = target.get('title')
            existing['pid'] = os.getpid()
            if expect_prefix:
                existing['expectPrefix'] = expect_prefix
            if url and navigate:
                navigate_job(endpoint, existing, url)
            else:
                existing.setdefault('lastUrl', target.get('url'))
                save_job(existing)
            return existing, how

    created_id = create_target(endpoint, url or 'about:blank', background=background,
                               new_context=new_context)
    job = new_job_record(name, created_id, url=url or 'about:blank', ephemeral=ephemeral,
                         expect_prefix=expect_prefix, tool=tool)
    if existing or fresh:
        save_job(job)
        return job, 'created'
    if save_job_exclusive(job) is None:
        # Another process claimed this name between the reap and the write.
        # Lockless means the loser cleans up after itself rather than waiting.
        close_target(endpoint, created_id)
        other = load_job(name)
        if other:
            return other, 'reused'
        save_job(job)
        return job, 'created'
    return job, 'created'


def navigate_job(endpoint, job, url, timeout=20.0):
    """Navigate the job's own tab and record the url as its fingerprint."""
    def run(conn):
        result = conn.send('Page.navigate', {'url': url})
        if result.get('errorText'):
            raise CdpError('navigation failed: %s' % result['errorText'])
        return result
    result = with_target(endpoint, {'id': job['targetId']}, run, timeout=timeout)
    job_note_url(job, url)
    return result


def job_note_url(job, url, title=None, save=True):
    """Record where the job PUT the tab. Drift is measured against this."""
    if url:
        job['lastUrl'] = url
    if title is not None:
        job['lastTitle'] = title
    job['lastSeen'] = now_iso()
    if save:
        save_job(job)
    return job


def resolve_job_target(endpoint, name, expect_url=None, update=True, quiet=False, targets=None,
                      create=False, create_url=None, source=None):
    """The job's tab as it stands NOW, with the anti-yank check.

    Re-resolved every command: by target id, then by the recorded url/title
    fingerprint if the id died. Warns on stderr when the tab has been moved off
    where the job left it; raises (exit 6) when --expect-url or a stored
    expectation is violated.
    """
    job = load_job(name)
    if not job and create:
        # Auto-claim: a fresh tab of its own, never somebody else's. Stealing
        # still needs --steal, and an explicit target that belongs to another
        # job is still refused.
        job, how = claim_job(endpoint, name, url=create_url, background=True)
        sys.stderr.write('note: no job named; claimed %s (%s) as job %s%s\n'
                         % (job['targetId'], how, name,
                            ' from $%s' % source if source and source != 'flag' else ''))
        targets = None
    if not job:
        known = ', '.join(j['job'] for j in all_jobs()) or 'none'
        raise CdpError('no such cdp job %r; claim one first: `tophat-cdp job claim %s --url URL` '
                       '(live jobs: %s)' % (name, name, known), EUSAGE)
    targets = list_targets(endpoint) if targets is None else targets
    live = live_targets_by_id(endpoint, targets)
    target = live.get((job.get('targetId') or '').upper())
    if target is None:
        target = refind_target(job, targets)
        if target is None:
            raise CdpError('job %s: its tab %s (last at %s) is gone from the browser and no tab matches '
                           'its fingerprint; claim it again with `tophat-cdp job claim %s --url ...`'
                           % (name, job.get('targetId'), job.get('lastUrl'), name), ETARGET)
        sys.stderr.write('warning: job %s: tab %s disappeared; re-bound to %s by fingerprint %r\n'
                         % (name, job.get('targetId'), target['id'], job.get('lastUrl') or job.get('lastTitle')))
        job['targetId'] = target['id']
    current = target.get('url') or ''
    prefix = expect_url or job.get('expectPrefix')
    drift = url_drift(job.get('lastUrl'), current)
    if prefix and not current.startswith(prefix):
        raise CdpError('job %s: its tab should be on %s but it is on %s. Another session navigated it; '
                       'this is the yank the job model exists to catch. Re-claim the job, or drop the '
                       'expectation with `tophat-cdp job expect %s --clear`.'
                       % (name, prefix, current or 'nothing', name), EHIJACK)
    if drift and not quiet:
        sys.stderr.write('warning: job %s: %s. The job last set %s, the tab is now on %s; someone else '
                         'may be driving it (pass --expect-url PREFIX to make this an error).\n'
                         % (name, drift, job.get('lastUrl'), current or 'nothing'))
    job['lastSeen'] = now_iso()
    job['lastTitle'] = target.get('title')
    if update:
        save_job(job)
    return target, job, drift


def job_row(job, targets, ui=None):
    live = live_targets_by_id(None, targets)
    target = live.get((job.get('targetId') or '').upper())
    try:
        age = time.time() - time.mktime(time.strptime((job.get('since') or '')[:19], '%Y-%m-%dT%H:%M:%S'))
    except ValueError:
        age = None
    row = {'job': job.get('job'), 'targetId': job.get('targetId'),
           'live': target is not None, 'url': (target or {}).get('url'),
           'title': (target or {}).get('title'), 'expectedUrl': job.get('lastUrl'),
           'expectPrefix': job.get('expectPrefix'), 'since': job.get('since'),
           'ageSeconds': int(age) if age is not None else None,
           'pid': job.get('pid'), 'pidAlive': pid_alive(job.get('pid')),
           'tool': job.get('tool'), 'ephemeral': job.get('ephemeral', False),
           'drift': url_drift(job.get('lastUrl'), (target or {}).get('url'))}
    if ui and job.get('job') in ui:
        row['uiJob'] = {'app': ui[job['job']].get('app'), 'window': ui[job['job']].get('windowID'),
                        'title': ui[job['job']].get('title')}
    return row


def select_target(args, endpoint, action=None, want_types=None):
    """Every verb's target: a job (`--job NAME` / `job=NAME`) or a raw selector.

    With a job: resolved through the registry, with drift and expectation
    checks. With a raw selector and a MUTATING action: refused if the target
    belongs to a different live job, which is what stops two agents from
    yanking each other's tabs even in legacy calls that name a bare id.
    """
    spec = getattr(args, 'target', None) or ''
    job = None
    if spec.startswith('job='):
        # A verb that carries a url opens the auto-claimed tab there instead of
        # on about:blank, so `tophat-cdp navigate URL` with no job is one step.
        create_url = getattr(args, 'url', None) if getattr(args, 'command', None) == 'navigate' else None
        target, job, _ = resolve_job_target(endpoint, spec[4:],
                                            expect_url=getattr(args, 'expect_url', None),
                                            create=True, create_url=create_url,
                                            source=getattr(args, 'job_source', None))
    else:
        if not spec:
            raise CdpError('this verb needs a target: a target id/selector, or --job NAME', EUSAGE)
        target = resolve_target(endpoint, spec, want_types=want_types)
        expect = getattr(args, 'expect_url', None)
        if expect and not (target.get('url') or '').startswith(expect):
            raise CdpError('target %s is on %s, not the expected %s'
                           % (target['id'], target.get('url'), expect), EHIJACK)
    if action:
        guard(target, args, action)
        if not (getattr(args, 'steal', False) or getattr(args, 'force', False)):
            owner = target_owner(endpoint, target['id'],
                                 exclude=job['job'] if job else env_get('TOPHAT_CDP_JOB_HINT'))
            if owner:
                raise CdpError('refusing to %s %s (%s): it belongs to job %s (pid %s, claimed %s). '
                               'Use `--job %s`, or pass --steal to take it.'
                               % (action, target['id'], (target.get('url') or '')[:70], owner['job'],
                                  owner.get('pid'), owner.get('since'), owner['job']), EREFUSED)
    return target, job


# --- evaluation helpers ---------------------------------------------------

def evaluate(conn, expression, await_promise=True, by_value=True, timeout=None):
    result = conn.send('Runtime.evaluate', {
        'expression': expression,
        'returnByValue': by_value,
        'awaitPromise': await_promise,
        'userGesture': True,
        'allowUnsafeEvalBlockedByCSP': False,
    }, timeout=timeout)
    details = result.get('exceptionDetails')
    if details:
        exception = details.get('exception') or {}
        message = exception.get('description') or exception.get('value') or details.get('text') or 'JavaScript exception'
        raise CdpError('JavaScript exception: %s' % message, ETARGET)
    return result.get('result', {})


def js_string(value):
    return json.dumps(value)


def with_target(endpoint, target, fn, timeout=20.0):
    conn = open_target_conn(endpoint, target, timeout=timeout)
    try:
        return fn(conn)
    finally:
        conn.close()


def open_target_conn(endpoint, target, timeout=20.0):
    """A session on this target: the passkey keeper's, if one owns the tab.

    Opening and then CLOSING a second DevTools session on a tab destroys any
    virtual authenticator attached to it (gotcha 8b). So while a passkey is
    attached, every verb borrows the keeper's single long-lived session instead
    of making its own. Set TOPHAT_CDP_NO_KEEPER_PROXY=1 to force a direct socket.
    """
    proxy = keeper_proxy(target['id'], timeout=timeout)
    return proxy if proxy is not None else Conn(target_socket_url(endpoint, target['id']), timeout=timeout)


def with_browser(endpoint, fn, timeout=20.0):
    url, _ = browser_socket_url(endpoint)
    conn = Conn(url, timeout=timeout)
    try:
        return fn(conn)
    finally:
        conn.close()


# --- key table for `keys` -------------------------------------------------

MODIFIERS = {'alt': 1, 'ctrl': 2, 'control': 2, 'meta': 4, 'cmd': 4, 'command': 4, 'shift': 8}

NAMED_KEYS = {
    'enter': ('Enter', 'Enter', 13, '\r'),
    'return': ('Enter', 'Enter', 13, '\r'),
    'tab': ('Tab', 'Tab', 9, '\t'),
    'escape': ('Escape', 'Escape', 27, None),
    'esc': ('Escape', 'Escape', 27, None),
    'backspace': ('Backspace', 'Backspace', 8, None),
    'delete': ('Delete', 'Delete', 46, None),
    'space': (' ', 'Space', 32, ' '),
    'arrowup': ('ArrowUp', 'ArrowUp', 38, None),
    'arrowdown': ('ArrowDown', 'ArrowDown', 40, None),
    'arrowleft': ('ArrowLeft', 'ArrowLeft', 37, None),
    'arrowright': ('ArrowRight', 'ArrowRight', 39, None),
    'up': ('ArrowUp', 'ArrowUp', 38, None),
    'down': ('ArrowDown', 'ArrowDown', 40, None),
    'left': ('ArrowLeft', 'ArrowLeft', 37, None),
    'right': ('ArrowRight', 'ArrowRight', 39, None),
    'home': ('Home', 'Home', 36, None),
    'end': ('End', 'End', 35, None),
    'pageup': ('PageUp', 'PageUp', 33, None),
    'pagedown': ('PageDown', 'PageDown', 34, None),
}


def parse_key(spec):
    """'Shift+Tab' or 'a' or 'Enter' -> (modifiers, key, code, vk, text)."""
    parts = spec.split('+')
    mods = 0
    while len(parts) > 1 and parts[0].lower() in MODIFIERS:
        mods |= MODIFIERS[parts.pop(0).lower()]
        
    name = '+'.join(parts)
    low = name.lower()
    if low in NAMED_KEYS:
        key, code, vk, text = NAMED_KEYS[low]
        return mods, key, code, vk, text
    if len(name) == 1:
        char = name
        upper = char.upper()
        code = ('Key' + upper) if upper.isalpha() else (('Digit' + char) if char.isdigit() else '')
        vk = ord(upper) if (upper.isalpha() or char.isdigit()) else 0
        # A character typed with Ctrl/Meta held carries no text; with Shift
        # held the text is the shifted character ('Shift+a' must insert 'A').
        if mods & 8 and char.isalpha():
            char = upper
        text = None if mods & (2 | 4) else char
        return mods, char, code, vk, text
    raise CdpError('unknown key %r; use a single character or one of: %s' % (spec, ', '.join(sorted(NAMED_KEYS))), EUSAGE)


def send_key(conn, spec):
    """Dispatch one key as rawKeyDown/char/keyUp (or keyDown/keyUp when the key
    carries no text). Verified to insert exactly one character per key; the
    tab must have focus emulation on first, see gotcha 7."""
    mods, key, code, vk, text = parse_key(spec)
    base = {'modifiers': mods, 'key': key, 'code': code,
            'windowsVirtualKeyCode': vk, 'nativeVirtualKeyCode': vk}
    if text is not None and len(key) == 1 and key not in ('\r', '\t'):
        conn.send('Input.dispatchKeyEvent', dict(base, type='rawKeyDown'))
        conn.send('Input.dispatchKeyEvent', {'type': 'char', 'text': text,
                                             'key': key, 'modifiers': mods})
    elif text is not None:
        conn.send('Input.dispatchKeyEvent', dict(base, type='keyDown', text=text, unmodifiedText=text))
    else:
        conn.send('Input.dispatchKeyEvent', dict(base, type='rawKeyDown'))
    conn.send('Input.dispatchKeyEvent', dict(base, type='keyUp'))


# --- frame-aware element addressing ------------------ Everything below exists
# because a payment form lives in an out-of-process iframe (OOPIF) and the old
# code addressed those frames BY URL and typed into them BY FRAME TARGET.
#
#   * six card frames shared one build url, so `url*=number-ltr` named two
#     different fields and `eval` on the wrong one returned the card number;
#   * a frame's real identity is the <iframe> ELEMENT that embeds it, which on
#     that checkout carried a stable id (card-fields-expiry-...) and always a
#     stable position in the parent DOM;
#   * `Input.*` aimed at a frame target, or JS focus() inside the frame, left
#     the page's keyboard focus where it was: the cardholder name went into the
#     card number field, twice, in two independent sessions.
#
# Measured on this Chrome (154.0.8037.98) against tools/fixtures/cdp-iframe:
#   - DOM.describeNode on an <iframe> element returns `frameId`, and for an
#     OOPIF that frameId IS the target id. Six frames, six exact matches.
#   - Page.getFrameTree on the embedding page lists ONLY the root frame; the
#     OOPIF children are not in it at all (same as the Oura/Zuora finding).
#   - /json/list carries `parentId`, so a frame target can be walked UP to its
#     page, including through a second level of nesting.
#
# The chain below is therefore: page target -> iframe ELEMENT (css) -> child
# target -> ... -> element; coordinates compose down it; every Input event is
# dispatched to the PAGE target at hit-tested page coordinates.

FRAME_SEP = '>>>'


def split_selector(selector):
    """'#card-fields-expiry >>> input' -> ['#card-fields-expiry', 'input']."""
    parts = [piece.strip() for piece in (selector or '').split(FRAME_SEP)]
    if not parts or any(not piece for piece in parts):
        raise CdpError('empty segment in frame-piercing selector %r (syntax: "IFRAME_CSS >>> ELEMENT_CSS")'
                       % selector, EUSAGE)
    return parts


# Open shadow roots are walked wherever a selector is resolved. A segment matches in the light DOM first,
# exactly as before; only when it matches nothing there are the open shadow roots under the current document
# searched, so no selector that resolved before changes meaning. A non-final segment naming a shadow host (not
# an iframe) steps into its shadow root. Spliced into every page script below and the one-line verbs; the rev6
# port (rev6/tools/browser/frames.mjs) carries the same text. No backslash, backtick or percent sign in it.
DEEP_JS = r"""
  const __kids = (r) => { const out = []; let all = []; try { all = r.querySelectorAll('*'); } catch (e) { return out; }
    for (const n of all) if (n.shadowRoot) out.push(n.shadowRoot); return out; };
  const __roots = (root) => { const out = [], todo = __kids(root); while (todo.length && out.length < 5000) { const r = todo.shift(); out.push(r); todo.push(...__kids(r)); } return out; };
  const __all = (root, sel) => { const out = [...root.querySelectorAll(sel)]; for (const r of __roots(root)) out.push(...r.querySelectorAll(sel)); return out; };
  const __qa = (root, sel) => { const light = [...root.querySelectorAll(sel)]; if (light.length) return light;
    const deep = []; for (const r of __roots(root)) deep.push(...r.querySelectorAll(sel)); return deep; };
  const __q1 = (root, sel) => __qa(root, sel)[0] || null;
  const __up = (n) => !n ? null : (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.host) ? n.parentNode.host : n.parentNode;
  const __within = (a, b) => { for (let n = b; n; n = __up(n)) if (n === a) return true; return false; };
  const __hitAt = (doc, x, y) => { let h = doc.elementFromPoint(x, y);
    for (let i = 0; i < 32 && h && h.shadowRoot; i++) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner; } return h; };
  const __active = (doc) => { let a = doc.activeElement; for (let i = 0; i < 32 && a && a.shadowRoot && a.shadowRoot.activeElement; i++) a = a.shadowRoot.activeElement; return a; };
  const __isFrame = (el) => /^(IFRAME|FRAME)$/.test(el.tagName);
  const __textOf = (e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').toLowerCase();
  const __pick = (root, sel, pick) => { const f = (l) => pick.text === null || pick.text === undefined ? l : l.filter((e) => __textOf(e).includes(String(pick.text).toLowerCase()));
    let l = f(__qa(root, sel)); if (!l.length && pick.text !== null && pick.text !== undefined) l = f(__all(root, sel));
    if (pick.index !== null && pick.index !== undefined) l = l[pick.index] ? [l[pick.index]] : []; return l; };
"""

# Walk a list of CSS segments inside ONE target, crossing same-origin frames and
# shadow hosts in JS and stopping at a cross-origin frame so python can hop
# targets. Returns the offset of the final document's viewport inside this
# target's viewport. The second %s is the pick ({text, index} or null) for the
# FINAL segment.
WALK_JS = r"""
(() => {
  const segs = %s; const pick = %s;""" + DEEP_JS + r"""
  const info = (el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const out = {tag: el.tagName, id: el.id || null, name: el.getAttribute('name') || null, type: el.getAttribute('type') || null,
      src: el.getAttribute('src') || null, value: (el.value === undefined || el.value === null) ? null : String(el.value),
      text: (el.innerText || '').trim().slice(0, 80) || null, disabled: !!el.disabled, ariaInvalid: el.getAttribute('aria-invalid'),
      visible: !(cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || (r.width === 0 && r.height === 0)),
      rect: {x: r.x, y: r.y, w: r.width, h: r.height}};
    if (__isFrame(el)) out.contentOffset = {x: (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
      y: (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)};
    return out;
  };
  let doc = document, root = document, offX = 0, offY = 0; const crumbs = [];
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1; let matches;
    try { matches = (last && pick) ? __pick(root, segs[i], pick) : __qa(root, segs[i]); } catch (e) { return {status: 'badselector', index: i, selector: segs[i], message: String(e.message || e)}; }
    if (!matches.length) { let frames = []; try { frames = __all(root, 'iframe, frame').slice(0, 12).map(info); } catch (e) {}
      return {status: 'missing', index: i, selector: segs[i], frames: frames, pick: (last && pick) ? pick : null}; }
    if (matches.length > 1) return {status: 'ambiguous', index: i, selector: segs[i], count: matches.length, candidates: [...matches].slice(0, 12).map(info)};
    const el = matches[0];
    const view = {w: doc.defaultView.innerWidth, h: doc.defaultView.innerHeight, sx: doc.defaultView.scrollX, sy: doc.defaultView.scrollY};
    if (last) { window.__tophatCdpEl = el; let picked = null;
      if (pick) { try { for (const old of __all(doc, '[data-tophat-pick]')) if (old !== el) old.removeAttribute('data-tophat-pick'); } catch (e) {}
        const tag = 'p' + Math.random().toString(36).slice(2, 10); el.setAttribute('data-tophat-pick', tag); picked = '[data-tophat-pick="' + tag + '"]'; }
      return {status: 'ok', index: i, offsetX: offX, offsetY: offY, element: info(el), crumbs: crumbs, view: view, picked: picked,
        active: doc.activeElement === el || __active(doc) === el}; }
    if (!__isFrame(el)) {
      if (el.shadowRoot) { crumbs.push({selector: segs[i], id: el.id || null, name: el.getAttribute('name') || null, shadow: true}); root = el.shadowRoot; continue; }
      return {status: 'notframe', index: i, selector: segs[i], tag: el.tagName};
    }
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const ox = r.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const oy = r.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    let inner = null; try { inner = el.contentDocument; } catch (e) { inner = null; }
    crumbs.push({selector: segs[i], id: el.id || null, name: el.getAttribute('name') || null, sameOrigin: !!inner});
    if (!inner) { window.__tophatCdpFrameEl = el; return {status: 'frame', index: i, offsetX: offX + ox, offsetY: offY + oy, element: info(el), crumbs: crumbs, view: view}; }
    offX += ox; offY += oy; doc = inner; root = inner;
  }
})()
"""


def walk_js(segments, pick=None):
    return WALK_JS % (json.dumps(segments), json.dumps(pick))


# Scroll the chain into view inside one target, innermost element first and the
# frames that hold it afterwards. `behavior:'instant'` because a container with
# scroll-behavior:smooth is why a Pay button measured at y=1277 right after a
# scrollIntoView that "worked".
SCROLL_JS = r"""
(() => {
  const segs = %s;""" + DEEP_JS + r"""
  let root = document; const path = [];
  for (let i = 0; i < segs.length; i++) { let el = null; try { el = __q1(root, segs[i]); } catch (e) {} if (!el) break; path.push(el);
    if (i === segs.length - 1) break;
    if (!__isFrame(el)) { if (!el.shadowRoot) break; root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {} if (!inner) break; root = inner; }
  const scrolled = [];
  for (let i = path.length - 1; i >= 0; i--) { try { path[i].scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); }
    catch (e) { try { path[i].scrollIntoView(true); } catch (e2) {} } scrolled.push(path[i].tagName + (path[i].id ? '#' + path[i].id : '')); }
  return {depth: path.length, scrolled: scrolled, windowScrollY: window.scrollY, docHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight};
})()
"""

# Hit test inside one target: does elementFromPoint at these coordinates
# actually reach each element of the chain? This is the check that turns
# "clicked, exit 0, nothing happened" into an error. The hit is drilled through
# open shadow roots and containment is checked across them.
HIT_JS = r"""
(() => {
  const segs = %s; let x = %s, y = %s;""" + DEEP_JS + r"""
  const name = (el) => el ? (el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')) : null;
  let doc = document, root = document;
  for (let i = 0; i < segs.length; i++) {
    let el = null; try { el = __q1(root, segs[i]); } catch (e) {}
    if (!el) return {ok: false, reason: 'missing', index: i, selector: segs[i]};
    const hit = __hitAt(doc, x, y); const ok = hit === el || __within(el, hit) || (hit && __within(hit, el));
    if (!ok) {
      # Clipped, not covered: an ancestor with overflow other than visible does not contain the point. Scrolling
      # cannot fix it.
      let clippedBy = null;
      for (let a = __up(el); a && a.nodeType === 1; a = __up(a)) { let cs = null; try { cs = getComputedStyle(a); } catch (e) {} if (!cs) continue;
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = a.getBoundingClientRect();
        if (x < b.left || x > b.right || y < b.top || y > b.bottom) { clippedBy = {name: name(a), w: Math.round(b.width), h: Math.round(b.height), overflow: cs.overflowY}; break; } }
      return {ok: false, reason: clippedBy ? 'clipped' : 'covered', index: i, selector: segs[i], x: x, y: y, hit: name(hit), want: name(el), clippedBy: clippedBy};
    }
    if (i === segs.length - 1) return {ok: true, index: i, hit: name(hit)};
    if (!__isFrame(el) && el.shadowRoot) { root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {}
    if (!inner) return {ok: true, index: i, crossOrigin: true, hit: name(hit)};
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    x -= r.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0); y -= r.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0); doc = inner; root = inner;
  }
  return {ok: true};
})()
"""

# Every iframe in a target, shadow roots included, with a selector that actually
# identifies it, which is the whole point: a url cannot, an element can.
FRAME_LIST_JS = r"""
(() => {
  const out = [], store = [];""" + DEEP_JS + r"""
  const uniq = (scope, sel, el) => { try { const m = __qa(scope, sel); return m.length === 1 && m[0] === el; } catch (e) { return false; } };
  const pathIn = (el) => {
    const parts = []; let node = el;
    while (node && node.nodeType === 1) { const parent = node.parentElement; if (!parent) break;
      const kin = [...parent.children].filter((c) => c.tagName === node.tagName); const idx = kin.indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + (kin.length > 1 ? ':nth-of-type(' + idx + ')' : '')); node = parent; if (parts.length > 6) break; }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const cssFor = (el, doc, depth) => {
    const tag = el.tagName.toLowerCase(), c = [];
    if (el.id) c.push('#' + CSS.escape(el.id));
    const nm = el.getAttribute('name'); if (nm) c.push(tag + '[name="' + CSS.escape(nm) + '"]');
    const p = pathIn(el); c.push(p);
    for (const a of ['title', 'src']) { const v = el.getAttribute(a); if (v) c.push(tag + '[' + a + '="' + CSS.escape(v) + '"]'); }
    for (const s of c) if (uniq(doc, s, el)) return s;
    const root = el.getRootNode();
    if (depth < 8 && root && root !== doc && root.host) return cssFor(root.host, doc, depth + 1) + ' >>> ' + (c.find((s) => uniq(root, s, el)) || p);
    return p;
  };
  const walk = (doc, prefix, depth) => {
    if (depth > 4) return; let frames = []; try { frames = __all(doc, 'iframe, frame'); } catch (e) { return; }
    for (const el of frames) {
      const sel = cssFor(el, doc, 0); const full = prefix ? prefix + ' >>> ' + sel : sel; const r = el.getBoundingClientRect(); store.push(el);
      let inner = null; try { inner = el.contentDocument; } catch (e) {}
      out.push({selector: full, id: el.id || null, name: el.getAttribute('name') || null, src: el.getAttribute('src') || null, title: el.getAttribute('title') || null,
        rect: {x: r.x, y: r.y, w: r.width, h: r.height}, visible: r.width > 0 && r.height > 0, sameOrigin: !!inner, shadow: el.getRootNode() !== doc, index: store.length - 1});
      if (inner) walk(inner, full, depth + 1);
    }
  };
  walk(document, '', 0); window.__tophatCdpFrameList = store; return out;
})()
"""

# The embedding page's own validation text for a field. A card number can read
# back perfectly inside its frame while the checkout shows "Enter a valid
# expiration date" next to it and refuses to submit, so a readback alone is not
# evidence of success. Stops before any ancestor that holds a SECOND field.
FIELD_ERROR_JS = r"""
(() => {
  const segs = %s;""" + DEEP_JS + r"""
  let root = document, el = null;
  for (let i = 0; i < segs.length; i++) { let next = null; try { next = __q1(root, segs[i]); } catch (e) {} if (!next) break; el = next;
    if (i === segs.length - 1) break;
    if (!__isFrame(el)) { if (!el.shadowRoot) break; root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {} if (!inner) break; root = inner; }
  if (!el) return {found: false, messages: []};
  const SEL = '[role="alert"], [aria-live], .error, .field-error, [class*="error" i], [id*="error" i], [data-error], .invalid, [class*="invalid" i]';
  const seen = []; let node = el;
  for (let up = 0; up < 3 && node; up++) {
    node = __up(node); if (!node || node.nodeType !== 1) break;
    let fields = []; try { fields = __all(node, 'iframe, frame, input, select, textarea'); } catch (e) {} if (fields.length > 1) break;
    let hits = []; try { hits = __all(node, SEL); } catch (e) {}
    for (const h of hits) { if (__within(h, el)) continue; const text = (h.innerText || h.textContent || '').trim(); if (!text) continue;
      const cs = getComputedStyle(h); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const t = text.slice(0, 200); if (seen.indexOf(t) === -1) seen.push(t); }
    if (seen.length) break;
  }
  return {found: seen.length > 0, messages: seen.slice(0, 3), ariaInvalid: el.getAttribute('aria-invalid'), element: el.tagName + (el.id ? '#' + el.id : '')};
})()
"""


def frame_id_of_handle(conn, expression='window.__tophatCdpFrameEl'):
    """The frameId of the <iframe> element the last walk stopped on.

    Measured 2026-10-09 on Chrome 154: for an OOPIF this frameId is exactly the
    CDP target id, for all six fixture frames and for the live Shopify card
    fields. DOM.getDocument first because DOM needs a document to describe
    against; describeNode then works on any Runtime objectId in that target,
    including a node inside a same-origin child document.
    """
    handle = conn.send('Runtime.evaluate', {'expression': expression, 'returnByValue': False})
    object_id = ((handle.get('result') or {}).get('objectId'))
    if not object_id:
        raise CdpError('could not take a handle on the embedding iframe element', ETARGET)
    try:
        conn.send('DOM.getDocument', {'depth': 0})
    except CdpError:
        pass
    node = (conn.send('DOM.describeNode', {'objectId': object_id}) or {}).get('node') or {}
    frame_id = node.get('frameId')
    if not frame_id:
        raise CdpError('DOM.describeNode returned no frameId for the iframe element '
                       '(it may have navigated mid-call; retry)', ETARGET)
    return frame_id


VSEP = '@'


def is_virtual(target_id):
    return VSEP in str(target_id or '')


def root_of(target_id):
    return str(target_id or '').split(VSEP)[0]


def frame_of(target_id):
    return str(target_id or '').split(VSEP)[-1]


def virtual_id(current, frame_id):
    return '%s%s%s' % (root_of(current), VSEP, frame_id)


def context_for(conn, frame_id, timeout=3.0):
    """Default-world execution context id of `frame_id` on this socket.

    A frame that is cross-origin but SAME-SITE as its embedder is not a CDP target (Chrome keeps it in the
    embedder's renderer) and its contentDocument is null, so it is reached through its Runtime execution
    context on the nearest ancestor target's socket. 2026-10-22, Home Depot checkout CVV:
    `#iframe-credit-card-payment-field >>> iframe >>> #securityCode`, outer frame same-process, inner an OOPIF.
    Runtime.enable replays the existing contexts as events, which Conn.send collects.
    """
    if not hasattr(conn, 'events'):
        raise CdpError('a same-process iframe needs a direct DevTools socket on its page; the passkey keeper '
                       'proxy cannot see execution contexts (detach it, or use a frame target)', ETARGET)
    if not getattr(conn, '_runtime_enabled', False):
        conn.send('Runtime.enable')
        conn._runtime_enabled = True
    want = str(frame_id).upper()
    deadline = time.time() + timeout
    while True:
        conn.drain(0.001)
        found = None
        for event in conn.events:
            method, params = event.get('method'), event.get('params') or {}
            if method == 'Runtime.executionContextsCleared':
                found = None
            elif method == 'Runtime.executionContextCreated':
                context = params.get('context') or {}
                aux = context.get('auxData') or {}
                if (str(aux.get('frameId') or '').upper() == want and aux.get('isDefault') is not False
                        and aux.get('type', 'default') == 'default'):
                    found = context.get('id')
            elif method == 'Runtime.executionContextDestroyed' and params.get('executionContextId') == found:
                found = None
        if found is not None:
            return found
        if time.time() >= deadline:
            raise CdpError('no execution context for frame %s on its embedding page; the frame may still be '
                           'loading (retry) or have navigated away' % frame_id, ETARGET)
        time.sleep(0.06)


class FrameConn(object):
    """Socket-shaped wrapper whose Runtime.evaluate runs in one frame's execution context."""

    def __init__(self, base, frame_id):
        self.base = base
        self.frame_id = frame_id

    @property
    def events(self):
        return self.base.events

    def send(self, method, params=None, timeout=None):
        params = dict(params or {})
        if method == 'Runtime.evaluate' or (method == 'Runtime.callFunctionOn' and 'objectId' not in params):
            params['contextId'] = context_for(self.base, self.frame_id)
        try:
            return self.base.send(method, params, timeout)
        except CdpError as error:
            # the context id changes when the frame navigates; one retry with a fresh lookup
            if 'contextId' in params and re.search(r'context|Cannot find', str(error), re.I):
                time.sleep(0.15)
                params['contextId'] = context_for(self.base, self.frame_id)
                return self.base.send(method, params, timeout)
            raise

    def focus_emulation(self, enabled=True):
        return self.base.focus_emulation(enabled)

    def drain(self, seconds=0.0):
        return self.base.drain(seconds)

    def close(self):
        pass


class Resolver(object):
    """Resolves `IFRAME_CSS >>> ELEMENT_CSS` chains and keeps one socket per target."""

    def __init__(self, endpoint, timeout=20.0):
        self.endpoint = endpoint
        self.timeout = timeout
        self._conns = {}
        self._targets = None

    # -- plumbing ---------------------------------------------------------
    def targets(self, refresh=False):
        if self._targets is None or refresh:
            self._targets = {t['id']: t for t in list_targets(self.endpoint)}
        return self._targets

    def target(self, target_id, refresh=False):
        if is_virtual(target_id):
            return {'id': target_id, 'type': 'frame', 'url': '(same-process frame)', 'parentId': root_of(target_id)}
        found = self.targets(refresh=refresh).get(target_id)
        if not found and not refresh:
            found = self.targets(refresh=True).get(target_id)
        return found

    def conn(self, target_id):
        if is_virtual(target_id):
            if target_id not in self._conns:
                self._conns[target_id] = FrameConn(self.conn(root_of(target_id)), frame_of(target_id))
            return self._conns[target_id]
        if target_id not in self._conns:
            target = self.target(target_id) or {'id': target_id, 'type': 'page', 'url': ''}
            self._conns[target_id] = open_target_conn(self.endpoint, target, timeout=self.timeout)
        return self._conns[target_id]

    def close(self):
        for conn in list(self._conns.values()):
            try:
                conn.close()
            except Exception:
                pass
        self._conns = {}

    def ev(self, target_id, expression):
        return evaluate(self.conn(target_id), expression).get('value')

    # -- frame maps -------------------------------------------------------
    def frame_map(self, target_id):
        """Every iframe in this target: selector, frameId, child target id."""
        conn = self.conn(target_id)
        rows = evaluate(conn, FRAME_LIST_JS).get('value') or []
        live = self.targets(refresh=True)
        for row in rows:
            try:
                row['frameId'] = frame_id_of_handle(
                    conn, 'window.__tophatCdpFrameList[%d]' % row['index'])
            except CdpError:
                row['frameId'] = None
            row['targetId'] = row['frameId'] if row['frameId'] in live else None
            if row['targetId']:
                row['frameUrl'] = live[row['targetId']].get('url')
            row.pop('index', None)
        return rows

    def frame_tree(self, target_id, depth=3, prefix=''):
        """frame_map, recursively through child OOPIF targets."""
        rows = []
        for row in self.frame_map(target_id):
            row = dict(row, selector=(prefix + ' >>> ' + row['selector']) if prefix else row['selector'],
                       parentTargetId=target_id)
            rows.append(row)
            if depth > 1:
                if row.get('targetId'):
                    rows.extend(self.frame_tree(row['targetId'], depth - 1, row['selector']))
                elif row.get('frameId') and not row.get('sameOrigin'):
                    # cross-origin but same-site: no target of its own, walked through its execution context
                    row['sameProcess'] = True
                    try:
                        rows.extend(self.frame_tree(virtual_id(target_id, row['frameId']), depth - 1, row['selector']))
                    except CdpError:
                        pass
        return rows

    def selector_for_frame(self, parent_target_id, frame_target_id):
        wanted = (frame_target_id or '').upper()
        # a frame nested under a same-process cross-origin frame is not in its parent's own map: search the tree
        for row in self.frame_map(parent_target_id) + self.frame_tree(parent_target_id, 4):
            if (row.get('frameId') or '').upper() == wanted:
                return row['selector']
        raise CdpError('could not find the <iframe> element that embeds target %s inside its parent %s'
                       % (frame_target_id, parent_target_id), ETARGET)

    def page_chain(self, target):
        """(page target, [iframe selectors]) for any target, frame or page."""
        hops, current, guard = [], target, 0
        while (current.get('type') or 'page') != 'page':
            parent_id = current.get('parentId')
            parent = self.target(parent_id) if parent_id else None
            if not parent:
                raise CdpError('target %s (%s) is a %s with no reachable embedding page; '
                               'name the page and a `IFRAME_CSS >>> ELEMENT_CSS` selector instead'
                               % (current.get('id'), (current.get('url') or '')[:60], current.get('type')),
                               ETARGET)
            hops.insert(0, self.selector_for_frame(parent['id'], current['id']))
            current = parent
            guard += 1
            if guard > 8:
                raise CdpError('frame nesting deeper than 8 while walking up to a page', ETARGET)
        return current, hops

    # -- the chain --------------------------------------------------------
    def resolve(self, target, selector, pick=None):
        """Walk page -> frames -> element. Raises with candidates on ambiguity."""
        page, implicit = self.page_chain(target)
        pending = []
        for piece in implicit:
            pending.extend(split_selector(piece))
        pending.extend(split_selector(selector))

        hops, base_x, base_y, index, current = [], 0.0, 0.0, 0, page['id']
        while True:
            segments = pending[index:]
            walk = evaluate(self.conn(current), walk_js(segments, pick)).get('value') or {}
            status = walk.get('status')
            if status == 'ok':
                if walk.get('picked'):
                    segments = segments[:-1] + [walk['picked']]
                hops.append({'targetId': current, 'segments': segments, 'baseX': base_x,
                             'baseY': base_y, 'walk': walk})
                break
            if status == 'frame':
                taken = walk['index'] + 1
                hops.append({'targetId': current, 'segments': pending[index:index + taken],
                             'baseX': base_x, 'baseY': base_y, 'walk': walk})
                frame_id = frame_id_of_handle(self.conn(current))
                # a live target is an OOPIF with its own socket; anything else is a same-process cross-origin
                # frame, reached through its execution context on the owning target's socket (ROOT@FRAMEID)
                nxt = frame_id if frame_id in self.targets(refresh=True) else virtual_id(current, frame_id)
                if is_virtual(nxt):
                    try:
                        context_for(self.conn(root_of(current)), frame_id)
                    except CdpError as error:
                        raise CdpError('the frame at %r (frameId %s) is neither a live target nor a frame with an '
                                       'execution context on its embedding page: %s'
                                       % (pending[index + walk['index']], frame_id, error), ETARGET)
                base_x += float(walk.get('offsetX') or 0)
                base_y += float(walk.get('offsetY') or 0)
                current, index = nxt, index + taken
                continue
            self._raise_walk(status, walk, pending, index, current)

        last = hops[-1]
        element = last['walk']['element']
        rect = element['rect']
        abs_x = last['baseX'] + float(last['walk'].get('offsetX') or 0) + rect['x']
        abs_y = last['baseY'] + float(last['walk'].get('offsetY') or 0) + rect['y']
        page_view = hops[0]['walk'].get('view') or {}
        return {'page': page, 'hops': hops, 'selector': selector, 'element': element,
                'ownerTargetId': last['targetId'], 'x': abs_x, 'y': abs_y,
                'centerX': abs_x + rect['w'] / 2.0, 'centerY': abs_y + rect['h'] / 2.0,
                'width': rect['w'], 'height': rect['h'], 'view': page_view,
                'active': last['walk'].get('active'),
                'canonicalSelector': (' %s ' % FRAME_SEP).join(
                    seg for hop in hops for seg in hop['segments'])}

    def _raise_walk(self, status, walk, pending, index, current):
        selector = walk.get('selector') or (pending[index:] or [''])[0]
        where = '%s (%s)' % (current, (self.target(current) or {}).get('url', '')[:60])
        if status == 'ambiguous':
            lines = []
            for cand in walk.get('candidates') or []:
                lines.append('  %s%s%s%s' % (
                    cand.get('tag', '?').lower(),
                    '#' + cand['id'] if cand.get('id') else '',
                    ' name=%s' % cand['name'] if cand.get('name') else '',
                    ' src=%s' % (cand.get('src') or '')[:70] if cand.get('src') else ''))
            raise CdpError('ambiguous selector %r in %s: %d elements match. Name one of them:\n%s'
                           % (selector, where, walk.get('count', 0), '\n'.join(lines)), ETARGET)
        if status == 'missing':
            frames = walk.get('frames') or []
            hint = ''
            if frames:
                hint = '\n  iframes in that document: ' + ', '.join(
                    '%s%s' % (f.get('tag', 'iframe').lower(), '#' + f['id'] if f.get('id') else
                              (' name=%s' % f['name'] if f.get('name') else '')) for f in frames[:10])
                hint += '\n  (run `tophat-cdp frame-map` for ready-made selectors)'
            pick = walk.get('pick') or None
            picked = ''
            if pick:
                picked = ' with' + (' text containing %r' % pick['text'] if pick.get('text') is not None else '') + (
                    ' at index %d' % pick['index'] if pick.get('index') is not None else '')
            raise CdpError('no element matches %r%s in %s (open shadow roots searched too)%s'
                           % (selector, picked, where, hint), ETARGET)
        if status == 'notframe':
            raise CdpError('%r in %s is a <%s>, neither an iframe nor an open shadow host, so nothing can be addressed through it'
                           % (selector, where, (walk.get('tag') or '?').lower()), EUSAGE)
        if status == 'badselector':
            raise CdpError('invalid CSS selector %r: %s' % (selector, walk.get('message')), EUSAGE)
        raise CdpError('could not resolve %r in %s (walk returned %r)' % (selector, where, status), ETARGET)

    # -- geometry ---------------------------------------------------------
    def in_view(self, chain, margin=2.0):
        view = chain.get('view') or {}
        width, height = view.get('w') or 0, view.get('h') or 0
        if not width or not height:
            return False
        if chain['width'] <= 0 or chain['height'] <= 0:
            return False
        return (chain['x'] >= -margin and chain['y'] >= -margin
                and chain['x'] + chain['width'] <= width + margin
                and chain['y'] + chain['height'] <= height + margin)

    def scroll_chain(self, chain):
        """Scroll from the innermost frame outward: an outer scroll never moves
        an inner one, so the order matters."""
        notes = []
        for hop in reversed(chain['hops']):
            notes.append(evaluate(self.conn(hop['targetId']),
                                  SCROLL_JS % json.dumps(hop['segments'])).get('value'))
        return notes

    def locate(self, target, selector, scroll=True, passes=4, settle=0.12, pick=None):
        """Resolve, scroll into view, and wait for the scroll to actually stop.

        The settle loop is there because a container with scroll-behavior:
        smooth keeps moving after scrollIntoView returns, which is how a Pay
        button measured at y=1277 and a click at those coordinates hit nothing.
        """
        chain = self.resolve(target, selector, pick)
        chain['scrolled'] = False
        if not scroll:
            return chain
        for _ in range(passes):
            if self.in_view(chain):
                break
            self.scroll_chain(chain)
            chain['scrolled'] = True
            previous = None
            for _settle in range(8):
                time.sleep(settle)
                chain = self.resolve(target, selector, pick)
                chain['scrolled'] = True
                here = (round(chain['x'], 1), round(chain['y'], 1))
                if here == previous:
                    break
                previous = here
        return chain

    def hit_test(self, chain, x=None, y=None):
        """Walk elementFromPoint down the chain. Each hop must reach its own
        element, or the click would land somewhere else entirely."""
        px = chain['centerX'] if x is None else x
        py = chain['centerY'] if y is None else y
        for hop in chain['hops']:
            local_x = px - hop['baseX']
            local_y = py - hop['baseY']
            result = evaluate(self.conn(hop['targetId']),
                              HIT_JS % (json.dumps(hop['segments']), json.dumps(local_x),
                                        json.dumps(local_y))).get('value') or {}
            if not result.get('ok'):
                result['targetId'] = hop['targetId']
                result['pageX'], result['pageY'] = px, py
                return result
        return {'ok': True, 'x': px, 'y': py}

    def uncover(self, target, selector, chain, scroll=True, pick=None, settle=0.12):
        """In the viewport is not the same as reachable: a sticky footer can sit over
        an element that locate() left alone because its rect was already inside the
        viewport (Mercury's Back/Next bar over "Due date", 2026-11-01). When the hit
        test says covered, centre the element once more and re-measure. A clipped
        element (inside a collapsed container) comes back unchanged."""
        if not scroll:
            return chain
        hit = self.hit_test(chain)
        if hit.get('ok') or hit.get('reason') != 'covered':
            return chain
        self.scroll_chain(chain)
        previous = None
        for _settle in range(8):
            time.sleep(settle)
            chain = self.resolve(target, selector, pick)
            chain['scrolled'] = True
            chain['uncovered'] = True
            here = (round(chain['x'], 1), round(chain['y'], 1))
            if here == previous:
                break
            previous = here
        return chain

    def require_hit(self, chain, x=None, y=None, what='click'):
        hit = self.hit_test(chain, x=x, y=y)
        if hit.get('ok'):
            return hit
        view = chain.get('view') or {}
        clip = hit.get('clippedBy') or None
        why = (' The element is clipped by %s (overflow %s, %sx%s), which does not contain that point: it sits '
               'inside a collapsed or scrolled-away container, so expand or open that section first.'
               % (clip.get('name'), clip.get('overflow'), clip.get('w'), clip.get('h'))) if clip else ''
        raise CdpError(
            'refusing to %s %r: the hit test at page coordinates %.0f,%.0f does not reach it. '
            'At segment %r the point is on %s, not %s. Element rect x=%.0f y=%.0f w=%.0f h=%.0f, '
            'page viewport %sx%s%s.%s Nothing was dispatched.'
            % (what, chain['selector'], hit.get('pageX', 0), hit.get('pageY', 0),
               hit.get('selector'), hit.get('hit') or 'nothing', hit.get('want') or 'it',
               chain['x'], chain['y'], chain['width'], chain['height'],
               view.get('w'), view.get('h'),
               '' if chain.get('scrolled') else ' (not scrolled; drop --no-scroll)', why),
            EHITTEST)

    def require_in_view(self, chain):
        if self.in_view(chain):
            return
        view = chain.get('view') or {}
        raise CdpError(
            'could not bring %r into the page viewport: rect x=%.0f y=%.0f w=%.0f h=%.0f against '
            'viewport %sx%s after scrolling%s. Nothing was dispatched.'
            % (chain['selector'], chain['x'], chain['y'], chain['width'], chain['height'],
               view.get('w'), view.get('h'),
               '' if chain.get('scrolled') else ' (scrolling was disabled)'),
            EHITTEST)

    # -- input, always through the page target ----------------------------
    def page_conn(self, chain):
        return self.conn(chain['hops'][0]['targetId'])

    def click_at(self, chain, x=None, y=None, button='left', clicks=1, focus_emulation=True):
        conn = self.page_conn(chain)
        if focus_emulation:
            self.ensure_page_focus(conn)
        px = chain['centerX'] if x is None else x
        py = chain['centerY'] if y is None else y
        base = {'x': px, 'y': py, 'button': button, 'clickCount': clicks, 'modifiers': 0,
                'buttons': 1 if button == 'left' else 2}
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseMoved', buttons=0, clickCount=0))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mousePressed'))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseReleased', buttons=0))
        return {'x': px, 'y': py}

    def ensure_page_focus(self, conn, timeout=0.5, poll=0.03):
        """Turn focus emulation on and WAIT for the renderer to believe it.

        Measured 2026-10-09: setFocusEmulationEnabled returns before the page
        reports document.hasFocus(), and a click dispatched in that window is
        delivered but moves no focus; the next process's click works, which is
        why the first fill after a navigate put nothing in the field while the
        second and third were fine.
        """
        conn.focus_emulation(True)
        deadline = time.time() + max(timeout, 0)
        while True:
            try:
                if evaluate(conn, 'document.hasFocus()').get('value'):
                    return True
            except CdpError:
                return False
            if time.time() >= deadline:
                return False
            time.sleep(poll)

    def local_point(self, chain):
        """The element's centre in the coordinates of the target that owns it."""
        hop = chain['hops'][-1]
        rect = hop['walk']['element']['rect']
        return (float(hop['walk'].get('offsetX') or 0) + rect['x'] + rect['w'] / 2.0,
                float(hop['walk'].get('offsetY') or 0) + rect['y'] + rect['h'] / 2.0)

    def click_in_owner(self, chain, button='left', clicks=1):
        """Click the owning frame's own widget, at frame-local coordinates.

        A mouse event dispatched at the PAGE target is routed to a child widget
        by the browser's compositor hit-test data, and on a freshly loaded
        NESTED frame that data is not there yet: measured cold, 2 of 6 runs put
        the focus in the inner input, and in the other 4 the keystrokes were
        delivered to the page with the <iframe> element itself as the event
        target, so nothing reached the field. Dispatched at the owning target
        the event needs no routing: 6 of 6 cold runs focused and typed. This is
        only ever the FOCUS fallback; the hit test that protects against
        overlays has already run against the page.
        """
        conn = self.conn(chain['ownerTargetId'])
        conn.focus_emulation(True)
        x, y = self.local_point(chain)
        base = {'x': x, 'y': y, 'button': button, 'clickCount': clicks, 'modifiers': 0,
                'buttons': 1 if button == 'left' else 2}
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseMoved', buttons=0, clickCount=0))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mousePressed'))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseReleased', buttons=0))
        return {'x': x, 'y': y, 'targetId': chain['ownerTargetId']}

    def select_all(self, chain):
        """Meta+a with commands:['selectAll'].

        Measured 2026-10-09: a bare Meta+a key event to the page APPENDS (the
        OOPIF never selects), while the same event carrying the editing command
        selects the focused frame's input, 0..len, and the next insertText
        replaces it. This is what makes `fill` a replace and kills the Backspace
        loop that used to walk focus backwards through a segmented card field.
        """
        send_select_all(self.page_conn(chain))

    def insert_text(self, chain, text):
        self.page_conn(chain).send('Input.insertText', {'text': text})

    def wait_focus(self, chain, timeout=1.0, poll=0.05):
        """Poll until the clicked element actually holds the focus.

        A click needs a moment to move focus into an OOPIF, and the first click
        into a background tab needs longer; reading activeElement 60ms after the
        click reported 'focus is still elsewhere' for two fields out of three.
        """
        deadline = time.time() + max(timeout, 0)
        element, walk = self.read_back(chain)
        while not walk.get('active') and time.time() < deadline:
            time.sleep(poll)
            element, walk = self.read_back(chain)
        return element, walk

    def read_back(self, chain):
        hop = chain['hops'][-1]
        walk = evaluate(self.conn(hop['targetId']),
                        walk_js(hop['segments'])).get('value') or {}
        if walk.get('status') != 'ok':
            return None, walk
        element = walk['element']
        if str(element.get('type') or '').lower() == 'password' and element.get('value'):
            register_secret(element['value'])   # whatever prints it next is scrubbed
        return element, walk

    def field_error(self, chain):
        """What the EMBEDDING page says about this field, which is the half of
        the verification a readback inside the frame cannot see."""
        hop = chain['hops'][0]
        return evaluate(self.conn(hop['targetId']),
                        FIELD_ERROR_JS % json.dumps(hop['segments'])).get('value') or {}

    def describe(self, chain):
        return {'selector': chain['selector'],
                'canonicalSelector': chain.get('canonicalSelector'),
                'frames': [{'targetId': hop['targetId'], 'segments': hop['segments'],
                            'originX': hop['baseX'], 'originY': hop['baseY']}
                           for hop in chain['hops']],
                'ownerTargetId': chain['ownerTargetId'],
                'element': chain['element'],
                'pageX': round(chain['x'], 2), 'pageY': round(chain['y'], 2),
                'centerX': round(chain['centerX'], 2), 'centerY': round(chain['centerY'], 2),
                'viewport': chain.get('view'), 'inView': self.in_view(chain),
                'scrolled': chain.get('scrolled', False), 'focused': chain.get('active')}


def open_resolver(endpoint, timeout=20.0):
    return Resolver(endpoint, timeout=timeout)


# --- verbs ----------------------------------------------------------------

def cmd_status(args):
    endpoint, source = discover()
    url, version = browser_socket_url(endpoint)
    print(json.dumps({'endpoint': endpoint, 'browser': version.get('Browser'),
                      'reachable': True, 'source': source}))
    return OK


def cmd_endpoint(args):
    endpoint, _ = discover()
    print(endpoint)
    return OK


def _print_targets(rows, as_json, max_url=160):
    if as_json:
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print('(no targets matched)')
        return
    width = max(len(r['type']) for r in rows)
    for row in rows:
        title = (row.get('title') or '').replace('\n', ' ')[:48]
        url = row['url'] or ''
        # Tracking-pixel and checkout-frame urls run to thousands of characters
        # and make the table unreadable; --full-url or --json keeps them whole.
        if max_url and len(url) > max_url:
            url = url[:max_url] + ' ...[%d chars]' % len(row['url'])
        print('%s  %-*s  %-48s  %s' % (row['id'], width, row['type'], title, url))


def cmd_targets(args):
    endpoint, _ = discover()
    rows = list_targets(endpoint)
    if args.type:
        wanted = set(args.type.split(','))
        rows = [r for r in rows if r['type'] in wanted]
    if args.filter:
        needle = args.filter if args.case_sensitive else args.filter.lower()

        def hay(row):
            text = (row['url'] or '') + ' ' + (row['title'] or '')
            return text if args.case_sensitive else text.lower()
        if args.exact:
            rows = [r for r in rows if r['url'] == args.filter]
        elif args.prefix:
            rows = [r for r in rows if (r['url'] or '').startswith(args.filter)]
        else:
            rows = [r for r in rows if needle in hay(r)]
    _print_targets(rows, args.json, 0 if args.full_url else args.max_url)
    return OK


def cmd_frames(args):
    endpoint, _ = discover()
    rows = [r for r in list_targets(endpoint) if r['type'] == 'iframe']
    if args.filter:
        rows = [r for r in rows if args.filter.lower() in (r['url'] or '').lower()]
    _print_targets(rows, args.json, 0 if args.full_url else args.max_url)
    if not args.json and rows:
        sys.stderr.write('note: input into an OOPIF target can be silently dropped; `fill` verifies the result, `dom-click` always works\n')
    return OK


def cmd_new(args):
    endpoint, _ = discover()
    # Gotcha 2: /json/new answers 405 here; the browser websocket does work.
    def run(conn):
        params = {'url': getattr(args, 'url_opt', None) or args.url}
        if args.background:
            params['background'] = True
        if args.new_context:
            context = conn.send('Target.createBrowserContext', {'disposeOnDetach': False})
            params['browserContextId'] = context['browserContextId']
        return conn.send('Target.createTarget', params)
    result = with_browser(endpoint, run)
    target_id = result.get('targetId')
    if args.json:
        print(json.dumps({'targetId': target_id, 'url': getattr(args, 'url_opt', None) or args.url}))
    else:
        print(target_id)
    return OK


def cmd_close(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'close')
    # Who owns it has to be read BEFORE the tab goes: a closed tab owns nobody,
    # and a registry entry left behind is exactly the stale state jobs replace.
    owner = _job or target_owner(endpoint, target['id'])
    with_browser(endpoint, lambda c: c.send('Target.closeTarget', {'targetId': target['id']}))
    released = None
    if owner:
        release_job(owner['job'])
        released = owner['job']
    print('closed %s %s%s' % (target['id'], target['url'][:100],
                              ' (released job %s)' % released if released else ''))
    return OK


def cmd_activate(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'activate')
    with_browser(endpoint, lambda c: c.send('Target.activateTarget', {'targetId': target['id']}))
    print('activated %s' % target['id'])
    return OK


def cmd_navigate(args):
    endpoint, _ = discover()
    args.url = getattr(args, 'url_opt', None) or args.url
    if not args.url:
        raise CdpError('navigate needs a URL: positional, or --url URL', EUSAGE)
    target, _job = select_target(args, endpoint, 'navigate')

    def run(conn):
        result = conn.send('Page.navigate', {'url': args.url})
        if result.get('errorText'):
            raise CdpError('navigation failed: %s' % result['errorText'])
        return result
    result = with_target(endpoint, target, run)
    if _job:
        # The job's fingerprint is the url the JOB set, never where the tab
        # happens to be; that difference is the whole anti-yank signal.
        job_note_url(_job, args.url)
    print(json.dumps({'targetId': target['id'], 'frameId': result.get('frameId'), 'url': args.url,
                      'job': _job['job'] if _job else None}))
    return OK


def cmd_reload(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'reload')
    with_target(endpoint, target, lambda c: c.send('Page.reload', {'ignoreCache': bool(args.ignore_cache)}))
    print('reloaded %s' % target['id'])
    return OK


def cmd_dialog(args):
    """Report, accept or dismiss a JavaScript dialog (alert/confirm/prompt/beforeunload).

    An open dialog blocks the page's main thread, so every eval, text and
    screenshot on that tab times out with no hint why (2026-10-11, OpenRouter
    credits page after a Purchase click). Page.enable re-emits
    Page.javascriptDialogOpening for a dialog already open, which is how this
    verb sees one without having been attached when it opened.
    """
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'dialog')

    def run(conn):
        conn.send('Page.enable', timeout=args.timeout)
        deadline = time.time() + args.wait
        found = None
        while time.time() < deadline and found is None:
            for event in conn.events:
                if event.get('method') == 'Page.javascriptDialogOpening':
                    found = event.get('params', {})
            if found is None:
                try:
                    conn.ws.settimeout(max(0.05, deadline - time.time()))
                    raw = conn.ws.recv()
                    message = json.loads(raw)
                    if 'method' in message:
                        conn.events.append(message)
                except Exception:
                    break
        out = {'targetId': target['id'], 'open': found is not None, 'dialog': found, 'handled': None}
        if found is not None and (args.accept or args.dismiss):
            params = {'accept': bool(args.accept)}
            if args.prompt_text is not None:
                params['promptText'] = args.prompt_text
            conn.send('Page.handleJavaScriptDialog', params, timeout=args.timeout)
            out['handled'] = 'accepted' if args.accept else 'dismissed'
        return out
    result = with_target(endpoint, target, run)
    print(json.dumps(result, indent=2))
    return OK


def cmd_info(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)

    def run(conn):
        result = evaluate(conn, '({url:location.href,title:document.title,ready:document.readyState,'
                                'w:innerWidth,h:innerHeight,scrollY:scrollY})')
        return result.get('value', {})
    live = with_target(endpoint, target, run)
    print(json.dumps({'id': target['id'], 'type': target['type'], 'listUrl': target['url'],
                      'live': live}, indent=2))
    return OK


def cmd_eval(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'evaluate in')
    inline = args.js or getattr(args, 'js_opt', None)
    if args.file:
        expression = Path(args.file).expanduser().read_text()
    elif inline and not getattr(args, 'stdin', False):
        expression = inline
    else:
        expression = sys.stdin.read()
    if not expression.strip():
        raise CdpError('nothing to evaluate; pass JS, --file PATH, or pipe it on stdin', EUSAGE)

    def run(conn):
        return evaluate(conn, expression, await_promise=not args.no_await, timeout=args.timeout)
    result = with_target(endpoint, target, run, timeout=max(args.timeout, 20.0))
    if 'value' in result:
        value = result['value']
        if args.json or not isinstance(value, str):
            rendered = json.dumps(value, indent=2, ensure_ascii=False)
        else:
            rendered = value
        cap = getattr(args, 'max_chars', None)
        if cap and len(rendered) > cap:
            rendered = rendered[:cap] + '\n[truncated at %d of %d chars by --max-chars]' % (cap, len(rendered))
        print(rendered)
    else:
        print(json.dumps({'type': result.get('type'), 'description': result.get('description')}))
    return OK


def cmd_html(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    selector = args.selector or 'html'
    expression = ('(()=>{' + DEEP_JS + 'const el=__q1(document,%s);'
                  'if(!el)throw new Error("no element matches "+%s);'
                  'return el.outerHTML;})()' % (js_string(selector), js_string(selector)))
    value = with_target(endpoint, target, lambda c: evaluate(c, expression)).get('value', '')
    if args.max_chars and len(value) > args.max_chars:
        value = value[:args.max_chars] + '\n... [truncated at %d chars]' % args.max_chars
    print(value)
    return OK


def cmd_text(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    selector = args.selector or 'body'
    expression = ('(()=>{' + DEEP_JS + 'const el=__q1(document,%s);'
                  'if(!el)throw new Error("no element matches "+%s);'
                  'return el.innerText;})()' % (js_string(selector), js_string(selector)))
    value = with_target(endpoint, target, lambda c: evaluate(c, expression)).get('value', '')
    if args.max_chars and len(value) > args.max_chars:
        value = value[:args.max_chars] + '\n... [truncated at %d chars]' % args.max_chars
    print(value)
    return OK



# Secret-filled tabs, so a screenshot of one cannot carry the value out. Every
# --secret-from (or --secret) fill, type or keys records its page target here and
# in the job; `screenshot` of such a tab blurs every input, textarea, select and
# iframe before capture unless --allow-secret-fields is given. A record lapses
# when the tab leaves the origin it was filled on.
SECRET_FILLS = JOBS_DIR.parent / 'secret-fills.json'
MASK_CSS = ('input,textarea,select,iframe,[contenteditable=""],[contenteditable="true"]'
            '{filter:blur(14px)!important;-webkit-text-security:disc!important}')


def _read_secret_fills():
    try:
        data = json.loads(SECRET_FILLS.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def note_secret_fill(target, job, verb, args, url=None):
    """Best effort: a failure to record must never block the fill, so it only warns."""
    vault = (getattr(args, 'secret_from', None) or '').split(':')[0] or None
    row = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'verb': verb, 'vault': vault,
           'origin': origin_of(url or target.get('url'))}
    try:
        fills = _read_secret_fills()
        fills[target['id']] = row
        SECRET_FILLS.parent.mkdir(parents=True, exist_ok=True)
        tmp = SECRET_FILLS.with_suffix('.json.tmp.%d' % os.getpid())
        tmp.write_text(json.dumps(fills, indent=2, sort_keys=True))
        os.replace(str(tmp), str(SECRET_FILLS))
        if job:
            fresh = load_job(job['job']) or job
            fresh['secret_fills'] = [r for r in fresh.get('secret_fills') or [] if r.get('target') != target['id']]
            fresh['secret_fills'].append(dict(row, target=target['id']))
            save_job(fresh)
    except (OSError, CdpError) as error:
        sys.stderr.write('warning: could not record the secret fill (%s); screenshots of this tab are not '
                         'masked automatically\n' % type(error).__name__)


def secret_fill_record(target, job):
    """The live record for this tab (by target id, its parent page, or the job), or None."""
    ids = {target.get('id'), target.get('parentId')} - {None}
    rows = [r for t, r in _read_secret_fills().items() if t in ids]
    if job:
        rows += [r for r in (job.get('secret_fills') or []) if r.get('target') in ids or not ids]
    here = origin_of(target.get('url'))
    live = [r for r in rows if not r.get('origin') or not here or r.get('origin') == here]
    return live[0] if live else None


def cmd_screenshot(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    filled = secret_fill_record(target, _job)
    mask = bool(filled) and not getattr(args, 'allow_secret_fields', False)
    if filled:
        sys.stderr.write('warning: this tab had a secret typed into it (%s %s at %s); %s\n' % (
            filled.get('verb'), filled.get('vault') or 'secret', filled.get('at'),
            'inputs, iframes and editable fields are blurred in this screenshot; --allow-secret-fields '
            'captures them unmasked (never OCR or share that image)' if mask else
            '--allow-secret-fields: captured UNMASKED; never OCR, upload or share this image'))

    def run(conn):
        if mask:
            # one style element, added and removed around the capture; a frame target masks its own document.
            # No requestAnimationFrame wait: a background tab never runs one; the capture itself renders a frame.
            evaluate(conn, "(()=>{const s=document.createElement('style');s.id='__tophat_cdp_mask';"
                           "s.textContent=%s;document.documentElement.appendChild(s);"
                           "void document.documentElement.offsetHeight;return 1})()"
                     % json.dumps(MASK_CSS))
        try:
            return capture(conn)
        finally:
            if mask:
                try:
                    evaluate(conn, "(()=>{const s=document.getElementById('__tophat_cdp_mask');if(s)s.remove();return 1})()")
                except CdpError:
                    pass

    def capture(conn):
        params = {'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False}
        if args.clip:
            try:
                x, y, w, h = [float(p) for p in args.clip.split(',')]
            except ValueError:
                raise CdpError('--clip wants x,y,w,h in CSS pixels', EUSAGE)
            params['clip'] = {'x': x, 'y': y, 'width': w, 'height': h, 'scale': args.scale}
        elif args.full_page:
            metrics = conn.send('Page.getLayoutMetrics')
            size = metrics.get('cssContentSize') or metrics.get('contentSize') or {}
            params['clip'] = {'x': 0, 'y': 0, 'width': size.get('width', 1280),
                              'height': size.get('height', 800), 'scale': args.scale}
            params['captureBeyondViewport'] = True
        return conn.send('Page.captureScreenshot', params, timeout=max(args.timeout, 20.0))
    result = with_target(endpoint, target, run, timeout=max(args.timeout, 30.0))
    data = base64.b64decode(result['data'])
    if not (getattr(args, 'out_opt', None) or args.out):
        raise CdpError('screenshot needs an output path: positional, or --out PATH', EUSAGE)
    out = Path(getattr(args, 'out_opt', None) or args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(json.dumps({'path': str(out), 'bytes': len(data), 'targetId': target['id'],
                      'secretFieldsMasked': mask, 'secretFilled': bool(filled)}))
    return OK


def cmd_pdf(args):
    """Print the tab to a PDF file (Page.printToPDF). Added 2026-11-02 for gmail-pdf-filer: a portal
    that shows a document only as a page (Different Health results) has no file to download."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    def run(conn):
        # screen media, not print: single-page apps hide their content under @media print
        conn.send('Emulation.setEmulatedMedia', {'media': 'screen'})
        try:
            return conn.send('Page.printToPDF', {'printBackground': True, 'preferCSSPageSize': True},
                             timeout=max(args.timeout, 30.0))
        finally:
            try:
                conn.send('Emulation.setEmulatedMedia', {'media': ''})
            except CdpError:
                pass
    result = with_target(endpoint, target, run, timeout=max(args.timeout, 40.0))
    data = base64.b64decode(result['data'])
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(json.dumps({'path': str(out), 'bytes': len(data), 'targetId': target['id'],
                      'sha256': hashlib.sha256(data).hexdigest()}))
    return OK


def cmd_download(args):
    """Fetch URL inside the tab (its cookies, same origin rules) and write the bytes to OUT.
    Added 2026-11-02 for gmail-pdf-filer: a statement behind a login is a same-origin GET, and
    `eval` returning base64 through stdout is the workaround this replaces. Exit 3 on a non-2xx
    answer or, with --expect-pdf, on bytes that do not start with %PDF-."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    js = ("(async()=>{const r=await fetch(%s,{credentials:'include'});const b=new Uint8Array(await r.arrayBuffer());"
          "let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));"
          "return JSON.stringify({status:r.status,type:r.headers.get('content-type'),"
          "disposition:r.headers.get('content-disposition'),b64:btoa(s)})})()" % json.dumps(args.url))
    raw = with_target(endpoint, target, lambda conn: evaluate(conn, js), timeout=max(args.timeout, 40.0))
    info = json.loads(raw)
    data = base64.b64decode(info.pop('b64'))
    if not 200 <= int(info['status']) < 300:
        raise CdpError('download: HTTP %s from %s' % (info['status'], args.url.split('?')[0]), ETARGET)
    if args.expect_pdf and not data.startswith(b'%PDF-'):
        raise CdpError('download: %d bytes (%s) are not a PDF' % (len(data), info.get('type')), ETARGET)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(json.dumps(dict(info, path=str(out), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                          targetId=target['id'])))
    return OK


def send_select_all(conn):
    """Meta+a carrying the editing command, which is the only form that selects
    inside a focused out-of-process iframe (a bare Meta+a key event appends)."""
    base = {'key': 'a', 'code': 'KeyA', 'windowsVirtualKeyCode': 65,
            'nativeVirtualKeyCode': 65, 'modifiers': 4}
    conn.send('Input.dispatchKeyEvent', dict(base, type='rawKeyDown', commands=['selectAll']))
    conn.send('Input.dispatchKeyEvent', dict(base, type='keyUp'))


def route_to_page(endpoint, target, args, verb):
    """Keyboard input belongs to the page, never to a frame target.

    Measured 2026-10-09: insertText aimed at an OOPIF target does land on this
    Chrome, but whether it does is a property of the page, not of the protocol,
    and the Shopify card frames are the counter-example that cost 45 minutes.
    The embedding page is always correct, so that is where these events go.
    """
    if target['type'] != 'iframe' or getattr(args, 'in_frame', False):
        if getattr(args, 'in_frame', False):
            warn_input_target(target, verb)
        return target
    res = open_resolver(endpoint)
    try:
        page, _x, _y = frame_offset(res, target)
    finally:
        res.close()
    sys.stderr.write('note: %s is a frame; sending %s to its embedding page %s instead '
                     '(--in-frame keeps the old behaviour)\n' % (target['id'], verb, page['id']))
    return page


def cmd_click(args):
    """Raw coordinate click. On a FRAME target the coordinates are frame-local
    and the events still go to the embedding page, translated by the frame's
    origin: input dispatched at a frame target is the thing that silently does
    nothing. `tap SELECTOR` is the verb that hit-tests first."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'click')
    page, origin_x, origin_y = target, 0.0, 0.0
    res = None
    if target['type'] == 'iframe' and not args.in_frame:
        res = open_resolver(endpoint)
        try:
            page, origin_x, origin_y = frame_offset(res, target)
        finally:
            res.close()
        sys.stderr.write('note: %s is a frame; clicking its embedding page %s at %.0f,%.0f '
                         '(frame origin %.0f,%.0f)\n'
                         % (target['id'], page['id'], origin_x + args.x, origin_y + args.y,
                            origin_x, origin_y))
    elif args.in_frame:
        warn_input_target(target, 'click')
    x, y = origin_x + args.x, origin_y + args.y

    def run(conn):
        if not args.no_focus_emulation:
            conn.focus_emulation(True)
        base = {'x': x, 'y': y, 'button': args.button, 'clickCount': args.clicks,
                'modifiers': 0, 'buttons': 1 if args.button == 'left' else 2}
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseMoved', buttons=0, clickCount=0))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mousePressed'))
        conn.send('Input.dispatchMouseEvent', dict(base, type='mouseReleased', buttons=0))
    with_target(endpoint, page, run)
    print('clicked %s at %s,%s' % (page['id'], x, y))
    return OK


def cmd_dom_click(args):
    """DOM .click() inside the target. Works in an OOPIF, where Input.* does not."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'click in')
    args.selector = selector_of(args)
    needle = getattr(args, 'text', None)
    index = getattr(args, 'index', None) or 0
    # --text NEEDLE picks, among the elements matching SELECTOR, the one whose visible text contains it;
    # --index N picks the Nth (0-based) of what is left.
    # Light DOM first, then open shadow roots (DEEP_JS); with --text, a needle that matches nothing in the
    # light-DOM matches is looked for among the shadow-root matches too.
    expression = ('(()=>{' + DEEP_JS + 'let list=__qa(document,%s);'
                  'const needle=%s;if(needle!==null){const f=(l)=>l.filter(e=>((e.innerText||e.value||"")+"").toLowerCase().includes(needle.toLowerCase()));'
                  'list=f(list);if(!list.length)list=f(__all(document,%s));}'
                  'const el=list[%d];'
                  'if(!el)throw new Error("no element matches "+%s+(needle!==null?" with text "+needle:"")+" at index %d ("+list.length+" candidates)");'
                  'el.scrollIntoView({block:"center"});el.click();'
                  'return {clicked:true,tag:el.tagName,text:(el.innerText||el.value||"").slice(0,80),candidates:list.length};})()'
                  % (js_string(args.selector), js_string(needle) if needle is not None else 'null',
                     js_string(args.selector), index, js_string(args.selector), index))
    value = with_target(endpoint, target, lambda c: evaluate(c, expression)).get('value')
    print(json.dumps(value))
    return OK


def cmd_upload(args):
    """Attach local files to an <input type=file> with DOM.setFileInputFiles: no file dialog, no drag.
    Added 2026-10-31 for Mercury Bill Pay (a raw websocket script before). Same verb in rev6."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'upload into')
    files = [str(Path(f).expanduser().resolve()) for f in args.files]
    for f in files:
        if not Path(f).is_file():
            raise CdpError('upload: not a file: %s' % f, EUSAGE)

    def run(conn):
        conn.send('DOM.enable')
        doc = conn.send('DOM.getDocument', {'depth': 0})
        q = conn.send('DOM.querySelectorAll', {'nodeId': doc['root']['nodeId'], 'selector': args.selector})
        ids = q.get('nodeIds') or []
        if not ids:
            raise CdpError('upload: no element matches %s' % args.selector, ETARGET)
        if args.index >= len(ids):
            raise CdpError('upload: only %d candidates for %s, no index %d' % (len(ids), args.selector, args.index), ETARGET)
        conn.send('DOM.setFileInputFiles', {'nodeId': ids[args.index], 'files': files})
        return len(ids)
    n = with_target(endpoint, target, run)
    print(json.dumps({'uploaded': len(files), 'files': [os.path.basename(f) for f in files], 'selector': args.selector,
                      'candidates': n, 'index': args.index, 'target': target['id']}))
    return OK


def cmd_type(args):
    """Insert text wherever the keyboard focus is. A frame target is routed to
    its embedding page (--in-frame forces the old behaviour); keyboard focus is
    a property of the page, not of a frame target."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'type into')
    text, private, secret = resolve_text(args, 'type')
    target = route_to_page(endpoint, target, args, 'type')

    def run(conn):
        if not args.no_focus_emulation:
            conn.focus_emulation(True)
        if secret:
            guard_active_element(conn, args, _job)
            note_secret_fill(target, _job, 'type', args)
        conn.send('Input.insertText', {'text': text})
    with_target(endpoint, target, run)
    print('typed %d chars into %s' % (len(text), target['id']))
    return OK


def cmd_keys(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'send keys to')
    sourced = any((getattr(args, 'text_stdin', False), getattr(args, 'text_env', None),
                   getattr(args, 'text_file', None), getattr(args, 'secret_from', None)))
    if args.keys and sourced:
        raise CdpError('keys: give key names OR a text source, not both', EUSAGE)
    if not args.keys and not sourced:
        raise CdpError('keys needs key names (Tab Enter ...) or --text-stdin/--text-env/--text-file/--secret-from', EUSAGE)
    typed, secret = None, False
    if sourced:
        typed, _private, secret = resolve_text(args, 'keys')
    target = route_to_page(endpoint, target, args, 'keys')

    def run(conn):
        if not args.no_focus_emulation:
            conn.focus_emulation(True)
        if secret:
            guard_active_element(conn, args, _job)
            note_secret_fill(target, _job, 'keys', args)
        if args.select_all:
            send_select_all(conn)
        for spec in (list(typed) if typed is not None else args.keys):
            try:
                send_key(conn, spec)
            except CdpError:
                conn.send('Input.insertText', {'text': spec})
            if args.delay:
                time.sleep(args.delay / 1000.0)
    with_target(endpoint, target, run)
    if typed is not None:
        print('sent %d characters to %s' % (len(typed), target['id']))
    else:
        print('sent %s to %s' % (' '.join(args.keys), target['id']))
    return OK


def frame_offset(res, target):
    """(page target dict, originX, originY) for an iframe target."""
    page, implicit = res.page_chain(target)
    if not implicit:
        return page, 0.0, 0.0
    chain = res.resolve(page, (' %s ' % FRAME_SEP).join(implicit))
    offset = (chain['element'].get('contentOffset') or {'x': 0, 'y': 0})
    return page, chain['x'] + offset['x'], chain['y'] + offset['y']


def cmd_frame_map(args):
    """Name every frame by the element that embeds it, not by its url."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    res = open_resolver(endpoint)
    try:
        rows = res.frame_tree(target['id'], depth=args.depth)
    finally:
        res.close()
    if args.json:
        print(json.dumps({'target': target['id'], 'url': target['url'], 'frames': rows}, indent=2))
        return OK
    if not rows:
        print('(no iframes in %s)' % target['id'])
        return OK
    width = max(len(row['selector']) for row in rows)
    duplicate_urls = {}
    for row in rows:
        duplicate_urls.setdefault(row.get('frameUrl') or row.get('src') or '', []).append(row)
    for row in rows:
        rect = row.get('rect') or {}
        shared = len(duplicate_urls.get(row.get('frameUrl') or row.get('src') or '', [])) > 1
        print('%-*s  %s  %-5s %4.0fx%-4.0f @%4.0f,%-4.0f  %s%s' % (
            width, row['selector'], row.get('targetId') or ('-' * 32),
            'frame' if row.get('targetId') else 'same',
            rect.get('w', 0), rect.get('h', 0), rect.get('x', 0), rect.get('y', 0),
            (row.get('frameUrl') or row.get('src') or '')[:70],
            '   [url shared with another frame: only the selector identifies it]' if shared else ''))
    return OK


def add_pick_args(p):
    """tap/point: pick among the matches of the FINAL selector segment (light DOM first, then open shadow roots)."""
    p.add_argument('--text', dest='pick_text', metavar='NEEDLE', default=None,
                   help='only matches whose visible text contains NEEDLE (case-insensitive)')
    p.add_argument('--index', dest='pick_index', metavar='N', type=int, default=None,
                   help='the Nth (0-based) of the remaining matches')


def pick_of(args):
    text, index = getattr(args, 'pick_text', None), getattr(args, 'pick_index', None)
    if text is None and index is None:
        return None
    return {'text': text, 'index': index}


def cmd_point(args):
    """Where an element really is on the page, and whether a click would reach it."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    res = open_resolver(endpoint)
    try:
        chain = res.locate(target, args.selector, scroll=not args.no_scroll, pick=pick_of(args))
        info = res.describe(chain)
        info['hit'] = res.hit_test(chain)
        if args.page_errors:
            info['pageMessages'] = res.field_error(chain)
        print(json.dumps(info, indent=2))
        if not info['hit'].get('ok'):
            sys.stderr.write('tophat-cdp: the hit test does not reach %r; a click there would land on %s\n'
                             % (args.selector, info['hit'].get('hit')))
            return EHITTEST
        if not info['inView']:
            sys.stderr.write('tophat-cdp: %r is not inside the page viewport\n' % args.selector)
            return EHITTEST
        return OK
    finally:
        res.close()


def cmd_tap(args):
    """A real click: scroll, hit-test, then Input.dispatchMouseEvent on the PAGE."""
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint, 'click in')
    res = open_resolver(endpoint)
    try:
        chain = res.locate(target, args.selector, scroll=not args.no_scroll, pick=pick_of(args))
        res.require_in_view(chain)
        chain = res.uncover(target, args.selector, chain, scroll=not args.no_scroll, pick=pick_of(args))
        res.require_hit(chain, what='click')
        if env_get('TOPHAT_CDP_DEBUG'):
            sys.stderr.write('debug: pre-click pageHasFocus=%s frameHasFocus=%s active=%s\n' % (
                res.ev(chain['hops'][0]['targetId'], 'document.hasFocus()'),
                res.ev(chain['ownerTargetId'], 'document.hasFocus()'),
                res.ev(chain['hops'][0]['targetId'], 'document.activeElement.tagName')))
        where = res.click_at(chain, button=args.button, clicks=args.clicks,
                             focus_emulation=not args.no_focus_emulation)
        time.sleep(max(args.settle, 0) / 1000.0)
        if env_get('TOPHAT_CDP_DEBUG'):
            sys.stderr.write('debug: post-click pageHasFocus=%s frameHasFocus=%s active=%s\n' % (
                res.ev(chain['hops'][0]['targetId'], 'document.hasFocus()'),
                res.ev(chain['ownerTargetId'], 'document.hasFocus()'),
                res.ev(chain['hops'][0]['targetId'], 'document.activeElement.tagName')))
        out = {'clicked': True, 'selector': chain['selector'],
               'canonicalSelector': chain.get('canonicalSelector'),
               'ownerTargetId': chain['ownerTargetId'],
               'x': round(where['x'], 2), 'y': round(where['y'], 2),
               'element': {k: chain['element'].get(k) for k in ('tag', 'id', 'name', 'type', 'text')}}
        try:
            element, walk = res.read_back(chain)
            out['focused'] = walk.get('active')
            out['valueAfter'] = ((element or {}).get('value')
                                 if str((element or {}).get('type') or '').lower() != 'password'
                                 else secret_placeholder((element or {}).get('value') or ''))
        except CdpError:
            out['gone'] = True  # the click navigated or replaced the element: not an error
        print(json.dumps(out))
        return OK
    finally:
        res.close()


def _fill_dom_value(res, chain, text):
    """Legacy plain-form path. React and Shopify ignore this; measured again on
    the fixture's strict field, which reverted it inside one animation frame."""
    hop = chain['hops'][-1]
    segments = hop['segments']
    expression = walk_js(segments)
    evaluate(res.conn(hop['targetId']), expression)
    set_js = ('(()=>{const el=window.__tophatCdpEl;'
              'const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,"value");'
              'if(d&&d.set){d.set.call(el,%s);}else{el.value=%s;}'
              'el.dispatchEvent(new Event("input",{bubbles:true}));'
              'el.dispatchEvent(new Event("change",{bubbles:true}));'
              'return el.value;})()' % (js_string(text), js_string(text)))
    return evaluate(res.conn(hop['targetId']), set_js).get('value')


def fresh_page_url(endpoint, target_id, fallback_target):
    for row in list_targets(endpoint):
        if (row.get('id') or '').upper() == (target_id or '').upper():
            return row.get('url') or ''
    return fallback_target.get('url') or ''


def selector_of(args):
    path = getattr(args, 'selector_file', None)
    if path:
        if args.selector:
            raise CdpError('give the selector one way: positional or --selector-file', EUSAGE)
        try:
            return Path(path).expanduser().read_text().strip()
        except OSError as error:
            raise CdpError('--selector-file: cannot read %s (%s)' % (path, type(error).__name__), EUSAGE)
    if not args.selector:
        raise CdpError('this verb needs a CSS selector (positional, or --selector-file PATH)', EUSAGE)
    return args.selector


def _do_fill(args, text, verb='fill', private=False, secret=False):
    endpoint, _ = discover()
    args.selector = selector_of(args)
    target, _job = select_target(args, endpoint, '%s in' % verb)
    if secret:
        check_secret_destination(target.get('url'), secret_expectation(args, _job))
    sensitive = bool(private)
    if getattr(args, 'input_target', None):
        sys.stderr.write('note: --input-target is obsolete and ignored; fill always types into the '
                         'embedding page target at hit-tested coordinates\n')
    res = open_resolver(endpoint)
    try:
        chain = res.locate(target, args.selector, scroll=not args.no_scroll)
        element_type = str(((chain.get('element') or {}).get('type')) or '').lower()
        if element_type == 'password' or secret:
            sensitive = True
            register_secret(text)
            if element_type == 'password' and not private:
                sys.stderr.write('warning: a password went through argv; use --secret-from VAULT_ID so it never '
                                 'enters shell history or a transcript\n')
        if secret:
            check_secret_element(chain.get('element'), active=True)
        if getattr(args, 'dom_value', False):
            value = _fill_dom_value(res, chain, text)
            print(json.dumps({'method': 'dom-value', 'selector': chain['selector'],
                              'value': secret_placeholder(value) if sensitive else value,
                              'warning': 'DOM value assignment is invisible to React/Shopify state'}))
            return OK
        res.require_in_view(chain)
        chain = res.uncover(target, args.selector, chain, scroll=not args.no_scroll)
        res.require_hit(chain, what=verb)
        before = (chain['element'] or {}).get('value')
        # a same-process frame has no socket of its own to click in
        framed = chain['ownerTargetId'] != chain['hops'][0]['targetId'] and not is_virtual(chain['ownerTargetId'])
        focus_via = None
        if not args.no_click:
            # The hit test above already proved, from the page, that nothing
            # covers this point. Focus is a separate problem: a click
            # dispatched at the PAGE target has to be routed to the child
            # widget by compositor hit-test data, which a freshly loaded OOPIF
            # does not have yet, and the fallout is silent (measured cold on a
            # doubly nested frame: 2 of 6 runs focused the input; in the rest
            # the keystrokes went to the page with the <iframe> as the event
            # target, and once the inner document reported activeElement ===
            # the input while the typing still went nowhere, so the focus flag
            # alone cannot be trusted). Clicking the OWNING widget at
            # frame-local coordinates needs no routing: 6 of 6.
            focus_via = 'frame' if framed else 'page'
            (res.click_in_owner(chain) if framed
             else res.click_at(chain, focus_emulation=not args.no_focus_emulation))
        element, walk = res.wait_focus(chain, timeout=0.0 if args.no_click else 0.6)
        focusable = (element or {}).get('tag') in ('INPUT', 'TEXTAREA', 'SELECT')
        if focusable and not walk.get('active') and not args.no_click:
            res.click_at(chain, focus_emulation=not args.no_focus_emulation)
            focus_via = 'page-retry'
            element, walk = res.wait_focus(chain, timeout=0.8)
        if focusable and not walk.get('active') and not args.no_focus_check:
            raise CdpError(
                'clicked %r at %.0f,%.0f but the page focus is still elsewhere, so typing would land in '
                'another field (this is the Shopify failure where the cardholder name went into the card '
                'number). Nothing was typed.' % (chain['selector'], chain['centerX'], chain['centerY']),
                EVERIFY)
        if secret:
            # the focus is now proven by the readback above; re-check the destination at the last moment
            check_secret_element(element, active=bool(walk.get('active')))
            check_secret_destination(fresh_page_url(endpoint, chain['hops'][0]['targetId'], target),
                                     secret_expectation(args, _job))
        if secret:
            note_secret_fill({'id': chain['hops'][0]['targetId'], 'url': fresh_page_url(endpoint, chain['hops'][0]['targetId'], target)}, _job, verb, args)
        if not args.append:
            res.select_all(chain)
        res.insert_text(chain, text)
        time.sleep(max(args.settle, 0) / 1000.0)
        element, walk = res.read_back(chain)
        value = (element or {}).get('value')
        if args.append:
            landed = isinstance(value, str) and value.endswith(text)
        else:
            landed = isinstance(value, str) and value == text
        result = {'selector': chain['selector'], 'canonicalSelector': chain.get('canonicalSelector'),
                  'ownerTargetId': chain['ownerTargetId'], 'pageTargetId': chain['hops'][0]['targetId'],
                  'x': round(chain['centerX'], 2), 'y': round(chain['centerY'], 2),
                  'mode': 'append' if args.append else 'replace', 'focusVia': focus_via,
                  'before': secret_placeholder(before) if sensitive else before,
                  'value': secret_placeholder(value) if sensitive else value, 'verified': bool(landed)}
        errors = {} if args.allow_error else res.field_error(chain)
        result['pageMessages'] = errors.get('messages') or []
        result['ariaInvalid'] = errors.get('ariaInvalid')
        if not landed:
            appended = (isinstance(value, str) and isinstance(before, str) and before
                        and value == before + text)
            print(json.dumps(result))
            raise CdpError(
                'typed %s into %r but the element reads back %s%s. Nothing about this fill is trustworthy.'
                % ('[redacted]' if sensitive else repr(text), chain['selector'],
                   '[redacted]' if sensitive else repr(value),
                   '; the text was APPENDED to the old value, so the select-all did not take'
                   if appended else ''), EVERIFY)
        if result['pageMessages'] and not args.allow_error:
            print(json.dumps(result))
            raise CdpError('the value is in the field but the page shows a validation message for it: %s'
                           % ' | '.join(result['pageMessages']), EVERIFY)
        if str(errors.get('ariaInvalid') or '').lower() == 'true' and not args.allow_error:
            print(json.dumps(result))
            raise CdpError('the value is in the field but the page marks it aria-invalid="true"', EVERIFY)
        print(json.dumps(result))
        return OK
    finally:
        res.close()


def cmd_fill(args):
    """Replace a field's value for real: click it at hit-tested page coordinates,
    select all through a real editing command, insert the text into the PAGE
    target, read it back from the frame that owns it, and check the embedding
    page for a validation message about that field. Secrets: --secret-from / --text-*;
    output never carries a password value."""
    text, private, secret = resolve_text(args, 'fill')
    return _do_fill(args, text, 'fill', private=private, secret=secret)


def cmd_clear(args):
    """Empty a field with select-all + an empty insertText. Never a Backspace
    loop: on a segmented card input, Backspace in an empty segment walks focus
    backwards and eats the previous segment (measured: ten Backspaces turned
    4242 4242 4242 4242 into 4242 42 _ _)."""
    args.append = False
    args.text = ''
    return _do_fill(args, '', 'clear')


def cmd_wait_for(args):
    endpoint, _ = discover()
    target, _job = select_target(args, endpoint)
    deadline = time.time() + args.timeout

    def current_url(conn):
        return evaluate(conn, 'location.href').get('value', '')

    conn = open_target_conn(endpoint, target, timeout=min(args.timeout + 5, 60))
    try:
        start_url = current_url(conn)
        while True:
            if args.selector:
                found = evaluate(conn, '(()=>{' + DEEP_JS + 'return !!__q1(document,%s);})()'
                                 % js_string(args.selector)).get('value')
                if found:
                    print(json.dumps({'matched': 'selector', 'selector': args.selector,
                                      'url': current_url(conn)}))
                    return OK
            if args.url_contains:
                url = current_url(conn)
                if args.url_contains in url:
                    print(json.dumps({'matched': 'url-contains', 'url': url}))
                    return OK
            if args.url_changes:
                url = current_url(conn)
                if url != start_url:
                    print(json.dumps({'matched': 'url-changes', 'from': start_url, 'url': url}))
                    return OK
            if args.text_contains:
                has = evaluate(conn, '(document.body&&document.body.innerText||"").includes(%s)'
                               % js_string(args.text_contains)).get('value')
                if has:
                    print(json.dumps({'matched': 'text-contains', 'url': current_url(conn)}))
                    return OK
            if time.time() > deadline:
                raise CdpError('timed out after %ss waiting on %s' % (args.timeout, target['id']), ETIMEOUT)
            time.sleep(args.poll)
    finally:
        conn.close()


def cmd_protected(args):
    ids = sorted(protected_ids())
    endpoint, _ = discover()
    known = {t['id'].upper(): t for t in list_targets(endpoint)}
    rows = [{'id': i, 'live': i in known, 'url': known.get(i, {}).get('url', '')} for i in ids]
    print(json.dumps({'file': str(DEFAULT_PROTECT_FILE), 'protected': rows}, indent=2))
    return OK


# --- the job verb ---------------------------------------------------------

def _job_print(payload, as_json=True):
    print(json.dumps(payload, indent=2, sort_keys=True))
    return OK


def cmd_job(args):
    endpoint, _ = discover()
    sub = args.job_command or 'list'

    if sub == 'list':
        targets = list_targets(endpoint)
        if not args.keep_stale:
            reap_jobs(endpoint, targets)
            targets = list_targets(endpoint)
        ui = ui_jobs()
        rows = [job_row(job, targets, ui) for job in all_jobs()]
        payload = {'jobs': rows, 'registry': str(JOBS_DIR)}
        if args.all:
            payload['uiJobs'] = [dict(record, registry=str(UI_JOBS_DIR)) for record in ui.values()]
        return _job_print(payload)

    if sub == 'reap':
        reaped = reap_jobs(endpoint)
        return _job_print({'reaped': reaped})

    if sub == 'claim':
        collision = ui_jobs().get(args.name)
        if collision:
            sys.stderr.write('note: %s is also an UI-automation job (window %s of %s). The job namespace is '
                             'shared by convention; same name should mean the same piece of work.\n'
                             % (args.name, collision.get('windowID'), collision.get('app')))
        job, how = claim_job(endpoint, args.name, url=args.url, target_id=args.target,
                             steal=args.steal, background=not args.foreground,
                             new_context=args.new_context, fresh=args.new,
                             ephemeral=args.ephemeral, expect_prefix=args.expect_url)
        return _job_print(dict(job, how=how))

    if sub == 'adopt':
        job, how = claim_job(endpoint, args.name, target_id=args.target, steal=args.steal,
                             expect_prefix=args.expect_url)
        return _job_print(dict(job, how=how))

    if sub == 'release':
        job = load_job(args.name)
        if not job:
            raise CdpError('no such cdp job %r' % args.name, EUSAGE)
        closed = False
        if args.close:
            closed = close_target(endpoint, job.get('targetId'))
        release_job(args.name)
        return _job_print({'released': args.name, 'targetId': job.get('targetId'), 'closed': closed})

    if sub == 'show':
        target, job, drift = resolve_job_target(endpoint, args.name, quiet=True)
        return _job_print(dict(job_row(job, list_targets(endpoint), ui_jobs()), drift=drift))

    if sub == 'sync':
        target, job, _ = resolve_job_target(endpoint, args.name, quiet=True)
        job_note_url(job, target.get('url'), title=target.get('title'))
        return _job_print({'job': args.name, 'lastUrl': job.get('lastUrl'),
                           'note': 'the tab where it stands now is the job fingerprint'})

    if sub == 'expect':
        job = load_job(args.name)
        if not job:
            raise CdpError('no such cdp job %r' % args.name, EUSAGE)
        job['expectPrefix'] = None if args.clear else args.prefix
        save_job(job)
        return _job_print({'job': args.name, 'expectPrefix': job['expectPrefix']})

    raise CdpError('unknown job subcommand %r' % sub, EUSAGE)


# can u fix that ?"
#
# What this is. Chrome's DevTools Protocol has a WebAuthn domain that plugs a
# SOFTWARE authenticator into a tab: WebAuthn.addVirtualAuthenticator, then
# addCredential / getCredentials. A page's navigator.credentials.create() and
# .get() then succeed with no hardware, no Touch ID and no human gesture. No
# extension and no native-messaging host are involved; the older
# src/vault/passkeys/native-host.mjs route is not used here.
#
# What it is NOT. It cannot adopt a passkey that already exists in iCloud
# Keychain or any other hardware authenticator: those private keys are
# non-exportable by design. A site can only be reached this way if a credential
# was REGISTERED through a virtual authenticator in the first place, which means
# being signed in to that site at registration time.
#
# Gotcha 8, measured here on Chrome 154.0.8037.98 and the reason this is not a
# one-shot command: THE VIRTUAL AUTHENTICATOR DIES WITH THE DEVTOOLS SESSION.
# Add one, close the websocket, reconnect, WebAuthn.enable, getCredentials ->
# "Could not find a Virtual Authenticator matching the ID". Worse, a SECOND
# session that calls WebAuthn.enable and then disconnects takes the environment
# down for the session that created it ("The Virtual Authenticator Environment
# has not been enabled for this session"). A concurrent second session CAN see
# the same authenticator while it is open, because the environment is keyed by
# the tab's frame tree, not by the session.
#
# So `passkey attach` forks a tiny KEEPER process that holds one DevTools socket
# open for the life of the job and owns the authenticator; every other tophat-cdp
# verb keeps working against the same tab over its own socket (those sessions
# never touch the WebAuthn domain, so they cannot knock it over). The keeper
# listens on a unix socket beside its state file, so later passkey commands ask
# IT to add or read credentials instead of opening a WebAuthn session of their
# own. `passkey detach`, closing the tab, or the browser going away all end it.

PASSKEY_DIR = Path(env_get('TOPHAT_CDP_PASSKEYS', str(STATE_DIR / 'cdp/passkeys')))
VAULT_CLI = Path(env_get('TOPHAT_CDP_PASSKEY_STORE', '/nonexistent/set-TOPHAT_CDP_PASSKEY_STORE'))

# Verified working on this Chrome. "internal" makes it a platform authenticator,
# so isUserVerifyingPlatformAuthenticatorAvailable() is true and a site offers
# the passkey path at all; the two simulation flags are what remove the human.
AUTHENTICATOR_OPTIONS = {
    'protocol': 'ctap2',
    'transport': 'internal',
    'hasResidentKey': True,
    'hasUserVerification': True,
    'isUserVerified': True,
    'automaticPresenceSimulation': True,
}
# Newer Chromes also take these; a build that does not know them rejects the
# whole call, so they are tried first and dropped on error. Backup eligible and
# backed up is what a synced (iCloud/Google) passkey reports, which some relying
# parties check before offering the passkey flow.
AUTHENTICATOR_EXTRA = {'defaultBackupEligibility': True, 'defaultBackupState': True,
                       'ctap2Version': 'ctap2_1'}

# Installed on the page before an enrolment ceremony. See gotcha 9 in `enroll`.
ES256_ONLY_SHIM = """(() => {
  if (window.__tophatEs256Only) return 'already';
  const create = navigator.credentials.create.bind(navigator.credentials);
  navigator.credentials.create = options => {
    const key = options && options.publicKey;
    if (key && Array.isArray(key.pubKeyCredParams)) {
      const es256 = key.pubKeyCredParams.filter(p => p.alg === -7);
      key.pubKeyCredParams = es256.length ? es256 : [{type: 'public-key', alg: -7}];
    }
    return create(options);
  };
  window.__tophatEs256Only = true;
  return 'installed';
})()"""


def passkey_paths(job_name):
    check_job_name(job_name)
    base = PASSKEY_DIR / job_name
    socket_path = str(base) + '.sock'
    # AF_UNIX paths are capped near 104 bytes; a long job name hashes instead.
    if len(socket_path) > 100:
        import hashlib
        short = hashlib.sha1(job_name.encode()).hexdigest()[:12]
        socket_path = str(PASSKEY_DIR / ('k-' + short)) + '.sock'
    return {'state': str(base) + '.json', 'socket': socket_path, 'log': str(base) + '.log'}


def b64url_of(value):
    """DevTools base64 (padded, standard alphabet) -> the store's base64url."""
    raw = base64.b64decode(value + '=' * (-len(value) % 4))
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def b64_of(value):
    """The store's base64url -> DevTools base64."""
    raw = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    return base64.b64encode(raw).decode()


def node_binary():
    candidates = [env_get('TOPHAT_NODE'), str(Path.home() / '.local/bin/node'),
                  '/usr/local/bin/node', '/opt/homebrew/bin/node']
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    import shutil
    found = shutil.which('node')
    if not found:
        raise CdpError('node not found; set $TOPHAT_NODE. The passkey store is read through %s' % VAULT_CLI, EUSAGE)
    return found


def vault_cli(argv, payload=None):
    """Run the node side (the real EncryptedPasskeyStore) and parse its JSON."""
    import subprocess
    if not VAULT_CLI.exists():
        raise CdpError('passkey store CLI missing: set TOPHAT_CDP_PASSKEY_STORE to the store command (a node script speaking the list/credentials/put/touch/export/import JSON interface); tried %s' % VAULT_CLI, EUSAGE)
    text = '' if payload is None else json.dumps(payload)
    result = subprocess.run([node_binary(), str(VAULT_CLI)] + list(argv),
                            input=text, capture_output=True, text=True, timeout=60)
    line = (result.stdout or '').strip().splitlines()
    if not line:
        raise CdpError('passkey store said nothing (exit %s): %s'
                       % (result.returncode, (result.stderr or '').strip()[:300]), EUSAGE)
    try:
        data = json.loads(line[-1])
    except ValueError:
        raise CdpError('passkey store returned non-JSON: %s' % line[-1][:300], EUSAGE)
    if isinstance(data, dict) and data.get('error'):
        raise CdpError('passkey store: %s' % data['error'], EUSAGE)
    return data


def stored_credentials(rp_id=None, with_keys=False):
    command = 'credentials' if with_keys else 'list'
    argv = [command] + (['--rp-id', rp_id] if rp_id else [])
    data = vault_cli(argv)
    return data.get('credentials' if with_keys else 'passkeys', [])


def credential_for_cdp(entry):
    """A stored entry in the shape WebAuthn.addCredential wants."""
    credential = {'credentialId': b64_of(entry['id']), 'rpId': entry['rpId'],
                  'isResidentCredential': bool(entry.get('isResidentCredential', True)),
                  'privateKey': b64_of(entry['privateKey']),
                  'signCount': int(entry.get('signCount') or 0)}
    if entry.get('userHandle'):
        credential['userHandle'] = b64_of(entry['userHandle'])
    # Chrome 154 rejects the whole addCredential call on unknown Credential
    # fields; userName is one, so it is carried in the vault and not sent.
    return credential


def entry_from_cdp(credential, user_name=None):
    """A DevTools Credential in the shape the encrypted store validates."""
    handle = credential.get('userHandle') or None
    decoded = None
    if handle:
        try:
            text = base64.b64decode(handle + '=' * (-len(handle) % 4)).decode('utf-8')
            decoded = text if text.isprintable() and text.strip() else None
        except Exception:
            decoded = None
    name = user_name or credential.get('userName') or decoded or credential.get('rpId') or 'tophat'
    return {'id': b64url_of(credential['credentialId']), 'rpId': credential['rpId'],
            'userHandle': b64url_of(handle) if handle else None,
            'userName': str(name)[:200],
            'privateKey': b64url_of(credential['privateKey']),
            'signCount': int(credential.get('signCount') or 0),
            'isResidentCredential': bool(credential.get('isResidentCredential')),
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'source': 'tophat-cdp virtual authenticator'}


def redacted(entry):
    """Never print key material. Enough to tell two credentials apart."""
    return {'rpId': entry.get('rpId'), 'userName': entry.get('userName'),
            'credentialId': (entry.get('id') or '')[:12] + '...',
            'resident': entry.get('isResidentCredential'),
            'signCount': entry.get('signCount'), 'createdAt': entry.get('createdAt'),
            'lastUsedAt': entry.get('lastUsedAt'), 'source': entry.get('source')}


# --- keeper client --------------------------------------------------------

def keeper_state(job_name):
    try:
        return json.loads(Path(passkey_paths(job_name)['state']).read_text())
    except (OSError, ValueError):
        return None


def keeper_request(job_name, payload, timeout=30.0):
    import socket as socket_module
    paths = passkey_paths(job_name)
    client = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(paths['socket'])
        client.sendall((json.dumps(payload) + '\n').encode())
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if chunks[-1].endswith(b'\n'):
                break
        body = b''.join(chunks).decode().strip()
    except (OSError, socket_module.timeout) as error:
        raise CdpError('passkey keeper for job %s is not answering (%s). Attach again with '
                       '`tophat-cdp passkey attach --job %s`.' % (job_name, error, job_name), ETARGET)
    finally:
        client.close()
    if not body:
        raise CdpError('passkey keeper for job %s closed without answering' % job_name, ETARGET)
    data = json.loads(body.splitlines()[-1])
    if not data.get('ok'):
        raise CdpError('passkey keeper: %s' % data.get('error'), ETARGET)
    return data


class KeeperConn(object):
    """A Conn-shaped proxy that runs commands over the keeper's own session."""

    def __init__(self, job_name, timeout=20.0):
        self.job = job_name
        self.timeout = timeout
        self.events = []

    def send(self, method, params=None, timeout=None):
        wait = timeout or self.timeout
        data = keeper_request(self.job, {'cmd': 'cdp', 'method': method,
                                         'params': params or {}, 'timeout': wait},
                              timeout=wait + 15)
        return data.get('result', {})

    def focus_emulation(self, enabled=True):
        # The keeper already holds focus emulation on for the life of the tab;
        # that is what lets a WebAuthn ceremony run in a background tab at all.
        return True

    def drain(self, seconds=0.0):
        return self.events

    def close(self):
        return None


def keeper_proxy(target_id, timeout=20.0):
    """The live keeper owning this tab, as a Conn, or None."""
    if env_get('TOPHAT_CDP_NO_KEEPER_PROXY'):
        return None
    if not PASSKEY_DIR.exists():
        return None
    wanted = (target_id or '').upper()
    for path in PASSKEY_DIR.glob('*.json'):
        try:
            state = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if (state.get('targetId') or '').upper() != wanted:
            continue
        if not pid_alive(state.get('pid')) or not os.path.exists(state.get('socket') or ''):
            continue
        return KeeperConn(state['job'], timeout=timeout)
    return None


def keeper_live(job_name, target_id=None):
    """The keeper record if one is alive for this job (and this tab), else None."""
    state = keeper_state(job_name)
    if not state or not pid_alive(state.get('pid')):
        return None
    if target_id and (state.get('targetId') or '').upper() != (target_id or '').upper():
        return None
    try:
        return keeper_request(job_name, {'cmd': 'ping'}, timeout=5).get('state')
    except CdpError:
        return None


def keeper_cleanup(job_name):
    for key in ('state', 'socket'):
        try:
            os.unlink(passkey_paths(job_name)[key])
        except OSError:
            pass


def start_keeper(job_name, target_id, rp_id=None):
    import subprocess
    PASSKEY_DIR.mkdir(parents=True, exist_ok=True)
    keeper_cleanup(job_name)
    paths = passkey_paths(job_name)
    log = open(paths['log'], 'ab')
    argv = [sys.executable, os.path.realpath(__file__), 'passkey', '_keeper', job_name,
            '--target-id', target_id]
    if rp_id:
        argv += ['--rp-id', rp_id]
    try:
        subprocess.Popen(argv, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    finally:
        log.close()
    deadline = time.time() + 20
    while time.time() < deadline:
        state = keeper_state(job_name)
        if state and os.path.exists(paths['socket']):
            try:
                return keeper_request(job_name, {'cmd': 'ping'}, timeout=5).get('state')
            except CdpError:
                pass
        time.sleep(0.2)
    tail = ''
    try:
        tail = Path(paths['log']).read_text()[-600:]
    except OSError:
        pass
    raise CdpError('the passkey keeper did not come up for job %s; log %s:\n%s'
                   % (job_name, paths['log'], tail), ETARGET)


# --- the keeper process ---------------------------------------------------

def run_keeper(args):
    """Hold one DevTools session, own one virtual authenticator, serve requests.

    Everything here exists because of gotcha 8: the authenticator belongs to the
    session, so SOMETHING has to keep a session open for as long as the job needs
    the passkey. This process is that something, and it does nothing else.
    """
    import selectors
    import signal
    import socket as socket_module

    endpoint, _ = discover()
    job_name = args.name
    paths = passkey_paths(job_name)
    PASSKEY_DIR.mkdir(parents=True, exist_ok=True)

    conn = Conn(target_socket_url(endpoint, args.target_id), timeout=30)
    # Gotcha 9: a WebAuthn ceremony in a background tab fails with "The operation
    # is not allowed at this time because the page does not have focus." The spec
    # requires a focused document, and an agent's tab never is. Focus emulation
    # is session scoped, so the KEEPER has to hold it: it lasts exactly as long as
    # the authenticator does, and the owner's real window focus never moves.
    conn.focus_emulation(True)
    conn.send('WebAuthn.enable', {'enableUI': False})
    options = dict(AUTHENTICATOR_OPTIONS, **AUTHENTICATOR_EXTRA)
    try:
        authenticator_id = conn.send('WebAuthn.addVirtualAuthenticator',
                                     {'options': options})['authenticatorId']
    except CdpError:
        options = dict(AUTHENTICATOR_OPTIONS)
        authenticator_id = conn.send('WebAuthn.addVirtualAuthenticator',
                                     {'options': options})['authenticatorId']
    # Belt and braces: the options already say so, but a site that calls
    # setUserVerified-sensitive flows gets the same answer either way.
    for method, params in (('WebAuthn.setUserVerified', {'isUserVerified': True}),
                           ('WebAuthn.setAutomaticPresenceSimulation', {'enabled': True})):
        try:
            conn.send(method, dict(params, authenticatorId=authenticator_id))
        except CdpError:
            pass

    try:
        os.unlink(paths['socket'])
    except OSError:
        pass
    listener = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    listener.bind(paths['socket'])
    os.chmod(paths['socket'], 0o600)
    listener.listen(8)

    state = {'job': job_name, 'targetId': args.target_id, 'authenticatorId': authenticator_id,
             'focusEmulation': True, 'restores': 0,
             'pid': os.getpid(), 'socket': paths['socket'], 'endpoint': endpoint,
             'rpId': args.rp_id, 'since': now_iso(), 'options': options, 'events': []}
    # Everything the authenticator holds, mirrored here (private keys included,
    # in this process's memory only) so a torn-down environment can be rebuilt
    # exactly. See ensure() for why that happens.
    mirror = {}

    def write_state():
        tmp = paths['state'] + '.tmp'
        Path(tmp).write_text(json.dumps(state, indent=2, sort_keys=True))
        os.replace(tmp, paths['state'])

    write_state()
    sys.stderr.write('keeper up: job=%s target=%s authenticator=%s\n'
                     % (job_name, args.target_id, authenticator_id))
    sys.stderr.flush()

    def shutdown(remove=True):
        if remove:
            try:
                conn.send('WebAuthn.removeVirtualAuthenticator',
                          {'authenticatorId': state['authenticatorId']})
            except Exception:
                pass
        try:
            listener.close()
        except Exception:
            pass
        conn.close()
        keeper_cleanup(job_name)

    signal.signal(signal.SIGTERM, lambda *_: (shutdown(), os._exit(0)))

    def note_event(message):
        name = message.get('method', '')
        if not name.startswith('WebAuthn.'):
            return
        params = message.get('params') or {}
        credential = params.get('credential') or {}
        state['events'].append({'at': now_iso(), 'event': name,
                                'credentialId': credential.get('credentialId'),
                                'rpId': credential.get('rpId')})
        state['events'] = state['events'][-50:]
        write_state()

    def cdp(method, params, timeout=None):
        result = conn.send(method, params, timeout=timeout)
        for message in conn.events:
            note_event(message)
        conn.events = []
        return result

    GONE = ('has not been enabled for this session', 'Could not find a Virtual Authenticator')

    def refresh_mirror():
        for credential in cdp('WebAuthn.getCredentials',
                              {'authenticatorId': state['authenticatorId']}).get('credentials', []):
            mirror[credential['credentialId']] = credential
        return list(mirror.values())

    def restore():
        """Rebuild the authenticator after someone else's session killed it.

        Gotcha 8b, measured 2026-10-08: ANY other DevTools session closing on
        this tab disables the virtual authenticator environment for every
        session, including the one that created it, even when that other session
        never touched the WebAuthn domain. One `tophat-cdp text` against the tab
        was enough. tophat-cdp therefore routes its verbs through this keeper's
        session (see KeeperConn), and this is the net under that: the credentials
        are mirrored in memory, so a rebuild is invisible to the page."""
        conn.focus_emulation(True)
        conn.send('WebAuthn.enable', {'enableUI': False})
        state['authenticatorId'] = conn.send('WebAuthn.addVirtualAuthenticator',
                                             {'options': options})['authenticatorId']
        for credential in mirror.values():
            try:
                conn.send('WebAuthn.addCredential', {'authenticatorId': state['authenticatorId'],
                                                     'credential': credential})
            except CdpError as error:
                sys.stderr.write('restore: could not re-add a credential: %s\n' % error)
        state['restores'] += 1
        state['restoredAt'] = now_iso()
        write_state()
        sys.stderr.write('restored authenticator %s with %d credential(s) after an outside session '
                         'tore the environment down\n' % (state['authenticatorId'], len(mirror)))
        sys.stderr.flush()

    def ensure():
        try:
            refresh_mirror()
            return False
        except CdpError as error:
            if not any(marker in str(error) for marker in GONE):
                raise
        restore()
        return True

    def handle(request):
        command = request.get('cmd')
        if command == 'ping':
            ensure()
            return {'ok': True, 'state': {k: v for k, v in state.items() if k != 'options'}}
        if command == 'cdp':
            # Every tophat-cdp verb aimed at this tab comes through here, so the
            # tab has exactly ONE DevTools session for as long as a passkey is
            # attached and nothing else can tear the authenticator down.
            ensure()
            return {'ok': True, 'result': cdp(request['method'], request.get('params') or {},
                                              timeout=request.get('timeout'))}
        if command == 'credentials':
            ensure()
            return {'ok': True, 'credentials': refresh_mirror()}
        if command == 'add':
            ensure()
            added = []
            for credential in request.get('credentials', []):
                try:
                    cdp('WebAuthn.addCredential',
                        {'authenticatorId': state['authenticatorId'], 'credential': credential})
                except CdpError as error:
                    # Older builds reject the userName field; the credential
                    # itself is what matters, so retry without the extras.
                    trimmed = {k: v for k, v in credential.items()
                               if k not in ('userName', 'userDisplayName')}
                    cdp('WebAuthn.addCredential',
                        {'authenticatorId': state['authenticatorId'], 'credential': trimmed})
                    sys.stderr.write('addCredential retried without userName: %s\n' % error)
                    credential = trimmed
                mirror[credential['credentialId']] = credential
                added.append(credential['credentialId'])
            return {'ok': True, 'added': added}
        if command == 'remove':
            ensure()
            cdp('WebAuthn.removeCredential', {'authenticatorId': state['authenticatorId'],
                                              'credentialId': request['credentialId']})
            mirror.pop(request['credentialId'], None)
            return {'ok': True}
        if command == 'user-verified':
            ensure()
            cdp('WebAuthn.setUserVerified', {'authenticatorId': state['authenticatorId'],
                                             'isUserVerified': bool(request.get('value', True))})
            return {'ok': True}
        if command == 'note':
            state['rpId'] = request.get('rpId') or state.get('rpId')
            state['userName'] = request.get('userName') or state.get('userName')
            write_state()
            return {'ok': True, 'state': state}
        if command == 'stop':
            return {'ok': True, 'stopping': True}
        return {'ok': False, 'error': 'unknown keeper command %r' % command}

    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ, 'listener')
    selector.register(conn.ws.sock, selectors.EVENT_READ, 'cdp')
    while True:
        ready = selector.select(timeout=1.0)
        if not ready:
            # Idle tick: catch a teardown caused by someone else's session
            # before the page next needs the authenticator.
            try:
                ensure()
            except Exception as error:
                sys.stderr.write('keeper health check failed: %s\n' % error)
                shutdown(remove=False)
                return OK
            continue
        for key, _ in ready:
            if key.data == 'cdp':
                conn.ws.settimeout(1.0)
                try:
                    raw = conn.ws.recv()
                except Exception:
                    raw = None
                if raw is None or raw == '':
                    sys.stderr.write('devtools socket closed (tab gone?); keeper exiting\n')
                    shutdown(remove=False)
                    return OK
                try:
                    note_event(json.loads(raw))
                except ValueError:
                    pass
                continue
            client, _ = listener.accept()
            client.settimeout(30)
            try:
                buffer = b''
                while not buffer.endswith(b'\n'):
                    chunk = client.recv(65536)
                    if not chunk:
                        break
                    buffer += chunk
                request = json.loads(buffer.decode() or '{}')
                try:
                    response = handle(request)
                except CdpError as error:
                    response = {'ok': False, 'error': str(error)}
                client.sendall((json.dumps(response) + '\n').encode())
                if response.get('stopping'):
                    client.close()
                    shutdown()
                    return OK
            except Exception as error:
                try:
                    client.sendall((json.dumps({'ok': False, 'error': str(error)}) + '\n').encode())
                except Exception:
                    pass
            finally:
                client.close()


# --- passkey verbs --------------------------------------------------------

def passkey_job(args, action):
    """The job's tab, with the same ownership and drift checks every verb gets."""
    name = getattr(args, 'job', None) or env_get('TOPHAT_CDP_JOB')
    if not name:
        raise CdpError('this passkey verb needs --job NAME (one job is one tab); '
                       'claim one with `tophat-cdp job claim NAME --url URL`', EUSAGE)
    endpoint, _ = discover()
    target, job, _drift = resolve_job_target(endpoint, name)
    guard(target, args, action)
    owner = target_owner(endpoint, target['id'], exclude=name)
    if owner and not getattr(args, 'steal', False):
        raise CdpError('refusing to %s %s: it belongs to job %s' % (action, target['id'], owner['job']),
                       EREFUSED)
    return endpoint, target, name


def attach_authenticator(job_name, target_id, rp_id=None, inject=True, exclude_existing=False):
    state = keeper_live(job_name, target_id)
    if state is None:
        if keeper_state(job_name):
            keeper_cleanup(job_name)
        state = start_keeper(job_name, target_id, rp_id=rp_id)
    injected, skipped = [], []
    if inject:
        present = {c.get('credentialId') for c in
                   keeper_request(job_name, {'cmd': 'credentials'}).get('credentials', [])}
        wanted = stored_credentials(rp_id, with_keys=True)
        payload = []
        for entry in wanted:
            credential = credential_for_cdp(entry)
            if credential['credentialId'] in present:
                skipped.append(redacted(entry))
                continue
            payload.append(credential)
            injected.append(redacted(entry))
        if payload:
            keeper_request(job_name, {'cmd': 'add', 'credentials': payload})
    keeper_request(job_name, {'cmd': 'note', 'rpId': rp_id})
    return state, injected, skipped


def cmd_passkey(args):
    sub = args.passkey_command
    if sub == '_keeper':
        return run_keeper(args)
    if sub == 'list':
        rows = stored_credentials(getattr(args, 'rp_id', None))
        print(json.dumps({'passkeys': [redacted(row) for row in rows],
                          'store': 'encrypted vault (passkeys-index), never printed in the clear'},
                         indent=2, sort_keys=True))
        return OK
    if sub == 'forget':
        if not (args.rp_id or args.id):
            raise CdpError('passkey forget needs --rp-id RPID or --id CREDENTIAL_ID', EUSAGE)
        argv = ['forget'] + (['--rp-id', args.rp_id] if args.rp_id else []) + \
               (['--id', args.id] if args.id else [])
        print(json.dumps(vault_cli(argv)))
        return OK
    if sub == 'export':
        result = vault_cli(['export', '--file', args.file] +
                           (['--key-file', args.key_file] if args.key_file else []))
        result['warning'] = ('tophat-created credentials only. A passkey in iCloud Keychain or any '
                             'hardware authenticator cannot be exported, by design: its private key '
                             'never leaves the Secure Enclave. Both files are 0600; delete them after '
                             'the transfer.')
        print(json.dumps(result, indent=2))
        return OK
    if sub == 'import':
        result = vault_cli(['import', '--file', args.file] +
                           (['--key-file', args.key_file] if args.key_file else []))
        print(json.dumps(result))
        return OK
    if sub == 'status':
        rows = []
        for path in sorted(PASSKEY_DIR.glob('*.json')) if PASSKEY_DIR.exists() else []:
            try:
                state = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            rows.append({'job': state.get('job'), 'targetId': state.get('targetId'),
                         'authenticatorId': state.get('authenticatorId'),
                         'rpId': state.get('rpId'), 'since': state.get('since'),
                         'keeperPid': state.get('pid'), 'alive': pid_alive(state.get('pid')),
                         'events': state.get('events', [])[-5:]})
        print(json.dumps({'attached': rows, 'stateDir': str(PASSKEY_DIR),
                          'stored': len(stored_credentials())}, indent=2, sort_keys=True))
        return OK

    # Everything below acts on a job's tab.
    if sub == 'attach':
        endpoint, target, name = passkey_job(args, 'attach a virtual authenticator to')
        state, injected, skipped = attach_authenticator(
            name, target['id'], rp_id=args.rp_id, inject=not args.no_credentials)
        print(json.dumps({'job': name, 'targetId': target['id'],
                          'authenticatorId': state.get('authenticatorId'),
                          'keeperPid': state.get('pid'), 'injected': injected, 'alreadyPresent': skipped,
                          'note': 'the authenticator lives as long as this keeper and this tab; '
                                  'release it with `tophat-cdp passkey detach --job %s`' % name},
                         indent=2, sort_keys=True))
        return OK

    if sub == 'enroll':
        endpoint, target, name = passkey_job(args, 'attach a virtual authenticator to')
        state, injected, _ = attach_authenticator(name, target['id'], rp_id=args.rp_id,
                                                  inject=False)
        # Gotcha 9, measured on Chrome 154.0.8037.98: the virtual authenticator
        # will CREATE an Ed25519 (COSE alg -8) credential when a relying party
        # offers it, and then refuses to take the same key back through
        # WebAuthn.addCredential ("An error occurred trying to create the
        # credential"). P-256 (alg -7) round-trips fine. So every Ed25519
        # enrolment is unreplayable by construction, which is silent until the
        # next sign-in. Strip -8 from pubKeyCredParams before the ceremony.
        def force_es256(conn):
            return evaluate(conn, ES256_ONLY_SHIM, await_promise=False)
        try:
            with_target(endpoint, target, force_es256, timeout=20.0)
        except CdpError:
            pass
        keeper_request(name, {'cmd': 'note', 'rpId': args.rp_id, 'userName': args.user_name})
        before = {c.get('credentialId') for c in
                  keeper_request(name, {'cmd': 'credentials'}).get('credentials', [])}
        saved = []
        if args.wait:
            deadline = time.time() + args.wait
            while time.time() < deadline and not saved:
                time.sleep(1.0)
                saved = save_new_credentials(name, args.rp_id, args.user_name, before)
        print(json.dumps({'job': name, 'targetId': target['id'],
                          'authenticatorId': state.get('authenticatorId'),
                          'rpId': args.rp_id, 'userName': args.user_name, 'saved': saved,
                          'next': ('Now drive the site\'s "add a passkey" flow in this tab while it is '
                                   'ALREADY SIGNED IN (the ceremony needs no gesture; this authenticator '
                                   'answers it). Then `tophat-cdp passkey save --job %s` writes the new '
                                   'credential into the encrypted vault.') % name},
                         indent=2, sort_keys=True))
        return OK

    if sub == 'save':
        endpoint, target, name = passkey_job(args, 'read credentials from')
        known = {entry['id'] for entry in stored_credentials()}
        saved = save_new_credentials(name, args.rp_id, args.user_name,
                                     {b64_of(credential_id) for credential_id in known})
        print(json.dumps({'job': name, 'saved': saved,
                          'note': 'nothing saved means the page created no new credential in this '
                                  'authenticator; check the registration actually completed'
                                  if not saved else 'stored in the encrypted vault'},
                         indent=2, sort_keys=True))
        return OK

    if sub == 'detach':
        name = getattr(args, 'job', None) or env_get('TOPHAT_CDP_JOB')
        if not name:
            raise CdpError('passkey detach needs --job NAME', EUSAGE)
        state = keeper_state(name)
        if not state:
            print(json.dumps({'job': name, 'detached': False, 'note': 'no passkey keeper for this job'}))
            return OK
        counters = []
        if pid_alive(state.get('pid')) and not args.no_sync:
            try:
                known = {b64_of(entry['id']): entry for entry in stored_credentials()}
                live = keeper_request(name, {'cmd': 'credentials'}).get('credentials', [])
                updates = [{'id': b64url_of(c['credentialId']), 'signCount': int(c.get('signCount') or 0)}
                           for c in live if c.get('credentialId') in known]
                if updates:
                    counters = vault_cli(['touch'], payload=updates).get('updated', [])
                unsaved = [c for c in live if c.get('credentialId') not in known]
                if unsaved:
                    sys.stderr.write('warning: %d credential(s) in this authenticator are NOT in the '
                                     'vault and are about to be destroyed; `tophat-cdp passkey save --job %s` '
                                     'first if you want them.\n' % (len(unsaved), name))
            except CdpError as error:
                sys.stderr.write('warning: could not sync counters: %s\n' % error)
        try:
            keeper_request(name, {'cmd': 'stop'}, timeout=10)
        except CdpError:
            pass
        import signal as signal_module
        if pid_alive(state.get('pid')):
            deadline = time.time() + 5
            while time.time() < deadline and pid_alive(state.get('pid')):
                time.sleep(0.1)
            if pid_alive(state.get('pid')):
                try:
                    os.kill(int(state['pid']), signal_module.SIGTERM)
                except OSError:
                    pass
        keeper_cleanup(name)
        print(json.dumps({'job': name, 'detached': True, 'countersUpdated': counters}, indent=2))
        return OK

    raise CdpError('unknown passkey subcommand %r' % sub, EUSAGE)


def save_new_credentials(job_name, rp_id, user_name, before_ids):
    """Persist every credential in the job's authenticator we do not already have."""
    live = keeper_request(job_name, {'cmd': 'credentials'}).get('credentials', [])
    fresh = [c for c in live if c.get('credentialId') not in before_ids
             and (not rp_id or c.get('rpId') == rp_id)]
    if not fresh:
        return []
    entries = [entry_from_cdp(credential, user_name) for credential in fresh]
    vault_cli(['put', '--overwrite'], payload=entries)
    return [redacted(entry) for entry in entries]


# --- argument parsing -----------------------------------------------------

# Incident: `fill TARGET SEL "$P" --job X` was a usage error, and argparse
# echoed `unrecognized arguments: <the password>` into a chat transcript. The
# rules this block enforces (README top section has them too):
#   1. A secret never travels in argv. Use --secret-from VAULT_ID[:field]
#      (the tool reads tophat-pass itself; the value never reaches the agent's
#      shell), or --text-stdin / --text-env VAR / --text-file PATH.
#   2. Nothing this tool prints can contain a secret: argparse errors never echo
#      values, and stdout/stderr pass through a redactor that knows every
#      secret the process resolved plus every value read out of a
#      type=password field.
#   3. --secret-from (and --secret on the other sources) refuses to type unless
#      the tab is on --expect-url (or the job's sticky expectation), the origin
#      is not a chat/mail/AI site, and the focused element is a real
#      <input>/<textarea>, never a contenteditable chat box.

import difflib
import hashlib
import shlex
import subprocess

SECRET_VARIANTS = []
MIN_REDACT_LEN = 4

# A secret typed into any of these is the Discord failure: refuse, whatever
# --expect-url says. Substring match on the host.
CHAT_HOSTS = ('discord.com', 'discordapp.com', 'web.whatsapp.com', 'whatsapp.com', 'slack.com',
              'messenger.com', 'telegram.org', 'signal.org', 'mail.google.com', 'outlook.live.com',
              'outlook.office.com', 'claude.ai', 'chatgpt.com', 'openai.com', 'gemini.google.com',
              'x.com', 'twitter.com', 'reddit.com', 'imessage', 'beeper')

TEXT_SOURCE_FLAGS = ('--text-stdin', '--text-env', '--text-file', '--secret-from')


def register_secret(value):
    """Teach the stdout/stderr redactor a string it must never print."""
    if not isinstance(value, str) or len(value) < MIN_REDACT_LEN:
        return
    for form in (value, json.dumps(value)[1:-1], repr(value)[1:-1],
                 json.dumps(value, ensure_ascii=False)[1:-1]):
        if form and form not in SECRET_VARIANTS:
            SECRET_VARIANTS.append(form)
    SECRET_VARIANTS.sort(key=len, reverse=True)  # longest first, so a prefix cannot leave a tail


def redact_text(text):
    for form in SECRET_VARIANTS:
        if form in text:
            text = text.replace(form, '[redacted]')
    return text


class _Redactor(object):
    """Wraps a text stream; every write passes through redact_text."""

    def __init__(self, stream):
        self._stream = stream

    def write(self, text):
        return self._stream.write(redact_text(text) if SECRET_VARIANTS and isinstance(text, str) else text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def __getattr__(self, name):
        return getattr(self._stream, name)


def install_redaction():
    if not isinstance(sys.stdout, _Redactor):
        sys.stdout = _Redactor(sys.stdout)
    if not isinstance(sys.stderr, _Redactor):
        sys.stderr = _Redactor(sys.stderr)


def secret_placeholder(value):
    return '[redacted:%d chars]' % len(value) if isinstance(value, str) else value


def fetch_vault_secret(spec):
    """`VAULT_ID[:field]` -> the value, read by tophat-pass in a child process.
    `ID:totp` is the current one-time code. tophat-pass's own stderr is never
    forwarded: a failure says which entry and the exit code, nothing else."""
    entry, _, field = spec.partition(':')
    if not entry:
        raise CdpError('--secret-from wants VAULT_ID or VAULT_ID:field', EUSAGE)
    binary = env_get('TOPHAT_CDP_PASS_BIN')
    lead = [binary] if binary else ['node', str(Path(__file__).resolve().parent.parent / 'bin/tophat-pass.mjs')]
    if field == 'totp':
        cmd = lead + ['totp', entry]
    else:
        cmd = lead + ['get', entry, '--raw', '-n'] + (['--field', field] if field else [])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CdpError('could not run tophat-pass for %s: %s' % (entry, type(error).__name__), EUSAGE)
    value = proc.stdout
    if proc.returncode != 0 or not value:
        raise CdpError('tophat-pass could not read %s (exit %d); nothing was typed' % (spec, proc.returncode), EUSAGE)
    return value.rstrip('\r\n') if field != 'totp' else value.strip()


def add_text_sources(parser):
    parser.add_argument('--text-stdin', action='store_true',
                        help='read the text from stdin (one trailing newline stripped); never in argv or history')
    parser.add_argument('--text-env', metavar='VAR', help='read the text from environment variable VAR')
    parser.add_argument('--text-file', metavar='PATH', help='read the text from a file (one trailing newline stripped)')
    parser.add_argument('--secret-from', metavar='VAULT_ID[:field]',
                        help='SECRET: tophat-pass reads it inside this tool (ID:totp for the one-time code). '
                             'Needs --expect-url (or a job claimed with one); refuses chat/mail sites, '
                             'contenteditable boxes and unfocused fields; output never contains it')
    parser.add_argument('--secret', action='store_true',
                        help='treat --text-stdin/--text-env/--text-file text as a secret: same guard and redaction')


def resolve_text(args, verb):
    """-> (text, private, secret). `private` = the value must not be echoed;
    `secret` = the typing guard applies."""
    positional = getattr(args, 'text', None)
    given = [flag for flag, on in (('--text-stdin', getattr(args, 'text_stdin', False)),
                                   ('--text-env', getattr(args, 'text_env', None)),
                                   ('--text-file', getattr(args, 'text_file', None)),
                                   ('--secret-from', getattr(args, 'secret_from', None))) if on]
    if positional is not None and given:
        raise CdpError('%s: give the text exactly one way (positional TEXT or %s), not both' % (verb, given[0]), EUSAGE)
    if len(given) > 1:
        raise CdpError('%s: give the text exactly one way, got %s' % (verb, ' and '.join(given)), EUSAGE)
    if positional is None and not given:
        raise CdpError('%s needs text: a positional TEXT, or --text-stdin / --text-env VAR / --text-file PATH / '
                       '--secret-from VAULT_ID (a value starting with "-" goes after `--`)' % verb, EUSAGE)
    if positional is not None:
        return positional, False, False
    flag = given[0]
    if flag == '--text-stdin':
        text = sys.stdin.read()
    elif flag == '--text-env':
        if args.text_env not in os.environ:
            raise CdpError('--text-env: variable %s is not set' % args.text_env, EUSAGE)
        text = os.environ[args.text_env]
    elif flag == '--text-file':
        try:
            text = Path(args.text_file).expanduser().read_text()
        except OSError as error:
            raise CdpError('--text-file: cannot read %s (%s)' % (args.text_file, type(error).__name__), EUSAGE)
    else:
        text = fetch_vault_secret(args.secret_from)
    if flag != '--secret-from' and text.endswith('\n'):
        text = text[:-1]
        if text.endswith('\r'):
            text = text[:-1]
    secret = flag == '--secret-from' or bool(getattr(args, 'secret', False))
    register_secret(text)   # private sources are never echoed, by any path
    return text, True, secret


def origin_of(url):
    parsed = urllib.parse.urlparse(url or '')
    return '%s://%s' % (parsed.scheme, parsed.netloc) if parsed.scheme and parsed.netloc else ''


def check_secret_destination(url, expect):
    """Pure check of the tab URL against the expected prefix. Raises CdpError."""
    if not expect:
        raise CdpError('refusing: secret text needs --expect-url PREFIX (the page it is meant for, e.g. '
                       'https://dash.cloudflare.com/), or a job claimed with --expect-url. Nothing was typed.', EHIJACK)
    expect_origin = origin_of(expect)
    if not expect_origin or not (expect_origin.startswith('https://') or urllib.parse.urlparse(expect).hostname
                                 in ('localhost', '127.0.0.1')):
        raise CdpError('refusing: --expect-url %r must be an https:// URL with a host (or localhost). '
                       'Nothing was typed.' % expect, EHIJACK)
    host = (urllib.parse.urlparse(url or '').hostname or '').lower()
    for chat in CHAT_HOSTS + tuple(h.strip().lower() for h in env_get('TOPHAT_CDP_CHAT_HOSTS', '').split(',') if h.strip()):
        if chat in host:
            raise CdpError('refusing: the tab is on %s, a chat/mail/AI site; secrets are never typed there. '
                           'Nothing was typed.' % host, EHIJACK)
    if not (url or '').startswith(expect) or origin_of(url) != expect_origin:
        raise CdpError('refusing: the tab is on %s, not the expected %s. Nothing was typed.'
                       % ((url or '')[:90], expect), EHIJACK)


def secret_expectation(args, job):
    return getattr(args, 'expect_url', None) or ((job or {}).get('expectPrefix') if job else None)


TYPEABLE_INPUT_TYPES = ('text', 'password', 'email', 'tel', 'url', 'search', 'number', '')


def check_secret_element(element, active=True):
    """Pure check of the element a secret is about to be typed into."""
    tag = ((element or {}).get('tag') or '').upper()
    etype = ((element or {}).get('type') or '').lower()
    if tag not in ('INPUT', 'TEXTAREA'):
        raise CdpError('refusing: the focused element is <%s>, not an <input>/<textarea> (a contenteditable '
                       'chat box looks exactly like this). Nothing was typed.' % (tag.lower() or 'nothing'), EHIJACK)
    if tag == 'INPUT' and etype not in TYPEABLE_INPUT_TYPES:
        raise CdpError('refusing: the focused <input> has type=%s. Nothing was typed.' % etype, EHIJACK)
    if (element or {}).get('disabled'):
        raise CdpError('refusing: the focused element is disabled. Nothing was typed.', EHIJACK)
    if not active:
        raise CdpError('refusing: the page focus is not on the element, so the text would land elsewhere. '
                       'Nothing was typed.', EHIJACK)


ACTIVE_JS = r"""
(() => {
  let el = document.activeElement, opaque = false;
  for (let i = 0; i < 12 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (/^(IFRAME|FRAME)$/.test(el.tagName)) {
      let d = null; try { d = el.contentDocument; } catch (e) {}
      if (d && d.activeElement) { el = d.activeElement; continue; }
      opaque = true;
    }
    break;
  }
  if (!el || opaque) return {tag: opaque ? 'IFRAME' : null, opaque: opaque, url: location.href, focus: document.hasFocus()};
  return {tag: el.tagName, type: el.getAttribute('type'), disabled: !!el.disabled,
          editable: !!el.isContentEditable, url: location.href, focus: document.hasFocus()};
})()
"""


def guard_active_element(conn, args, job):
    """`type` / `keys` carry no selector: ask the page what holds the focus."""
    info = evaluate(conn, ACTIVE_JS).get('value') or {}
    check_secret_destination(info.get('url'), secret_expectation(args, job))
    if info.get('opaque'):
        raise CdpError('refusing: the focus is inside a frame this tool cannot inspect; use `fill SELECTOR` '
                       '(it resolves the frame chain) for secrets. Nothing was typed.', EHIJACK)
    check_secret_element(info, active=bool(info.get('focus')))
    return info


def scrub_argparse_message(message):
    """argparse echoes values in its errors ('unrecognized arguments: <value>',
    'invalid choice', 'invalid float value'). Replace every value."""
    m = re.match(r'^unrecognized arguments: (.*)$', message, re.S)
    if m:
        tokens = m.group(1).split(' ')
        options = [t for t in tokens if re.match(r'^--?[A-Za-z][A-Za-z0-9-]*$', t)]
        others = len(tokens) - len(options)
        out = 'unrecognized arguments:'
        if options:
            out += ' unknown option(s) %s;' % ', '.join(sorted(set(options)))
        if others:
            out += ' %d extra value(s) not shown' % others
        return out.rstrip(';')
    m = re.match(r"^(argument [^:]*): invalid choice: '.*?' \(choose from (.*)\)$", message, re.S)
    if m:
        choices = re.findall(r"'([^']*)'", m.group(2))
        raw = re.search(r"invalid choice: '(.*?)' \(choose from", message, re.S).group(1)
        close = difflib.get_close_matches(raw, choices, n=3, cutoff=0.5)
        return '%s: invalid choice (value not shown)%s' % (
            m.group(1), '; did you mean: %s' % ', '.join(close) if close else '; choose from: %s' % ', '.join(choices))
    m = re.match(r"^(argument [^:]*): (invalid .*? value|expected .*?|ignored explicit argument): .*$", message, re.S)
    if m:
        return '%s: %s (value not shown)' % (m.group(1), m.group(2))
    return re.sub(r"'[^']*'", '<arg>', message)


def secret_flag_hint():
    return ('hint: pass secrets with --secret-from VAULT_ID (or --text-stdin/--text-env/--text-file), '
            'never as an argument; a value starting with "-" goes after `--`; --job NAME stands in for the '
            'TARGET positional and may sit before or after the verb')



# Each is accepted now.

import argparse

VERB_ALIASES = {'nav': 'navigate', 'goto': 'navigate', 'go': 'navigate', 'js': 'eval', 'evaluate': 'eval',
                'ev': 'eval', 'shot': 'screenshot', 'ss': 'screenshot', 'ls': 'targets', 'tabs': 'targets'}

# positional dest -> the options that supply it instead (then it is not required)
POSITIONAL_SOURCES = {
    'text': TEXT_SOURCE_FLAGS,
    'js': ('--file', '--stdin', '--expr', '--expression', '--js', '--script', '-e', '--code'),
    'url': ('--url',),
    'out': ('--out', '--output', '-o'),
    'selector': ('--selector-file',),
}


class ForgivingParser(argparse.ArgumentParser):
    """argparse with an error() that never echoes argument values."""

    def error(self, message):
        self.print_usage(sys.stderr)
        shown = scrub_argparse_message(message)
        sys.stderr.write('%s: error: %s\n' % (self.prog, shown))
        if shown.startswith(('unrecognized', 'argument command', 'the following')) or 'expected' in shown:
            sys.stderr.write(secret_flag_hint() + '\n')
        sys.exit(EUSAGE)


def _soft(parser, dest):
    """Make a required positional optional (a flag can supply it instead)."""
    for action in parser._actions:
        if action.dest == dest and not action.option_strings:
            action.nargs = '?'
            action.required = False
            action.default = None
            action.tophat_unless = POSITIONAL_SOURCES[dest]
            return action
    raise KeyError(dest)


def _opt_arity(sub, opt):
    action = sub._option_string_actions.get(opt)
    if action is None:
        return None
    if action.nargs == 0:
        return 0
    return action.nargs if isinstance(action.nargs, int) else 1


def _scan_positionals(sub, tokens):
    """Indexes of the positional tokens in `tokens`, honouring `--` and the
    arity of the verb's own options."""
    found, i = [], 0
    while i < len(tokens):
        piece = tokens[i]
        if piece == '--':
            found.extend(range(i + 1, len(tokens)))
            break
        if piece.startswith('-') and len(piece) > 1 and not re.match(r'^-\d', piece):
            name = piece.split('=', 1)[0]
            arity = _opt_arity(sub, name)
            i += 1 + (0 if '=' in piece or arity is None else arity)
            continue
        found.append(i)
        i += 1
    return found


def _positional_shape(sub, rest_tokens):
    """(min, max) number of positionals the verb takes AFTER its target."""
    acts = [a for a in sub._actions if not a.option_strings and a.dest not in ('help',)]
    non_target = acts[1:] if acts and acts[0].dest == 'target' else acts
    low, high = 0, 0
    for action in non_target:
        if action.nargs in ('+', '*'):
            high = float('inf')
            low += 1 if action.nargs == '+' else 0
            if action.nargs == '*' and getattr(action, 'tophat_unless', None):
                pass
            continue
        unless = getattr(action, 'tophat_unless', None)
        high += 1
        if action.nargs is None:
            low += 1
        elif action.nargs == '?' and unless and not any(
                t == f or t.startswith(f + '=') for t in rest_tokens for f in unless):
            low += 1
    return low, high


def normalize_argv(argv, parser):
    """Make the command line mean what the agent meant.

    * `--job NAME` / `-j` anywhere (not after `--`) is lifted out; so is
      `--target X`, which is the target positional.
    * options sitting BEFORE the verb that the verb accepts (--steal,
      --expect-url, --timeout, --force, --json, ...) move after it.
    * verb aliases (nav, goto, js, shot, ...) resolve.
    * for a verb that takes a target: if the call names one (an id, or one
      positional more than the verb's own arguments), it is used and --job only
      exempts that job's own tab from the ownership check; if not, job=NAME (or
      the caller's default job) becomes the target. So `fill ID SEL TEXT --job X`,
      `--job X fill SEL TEXT` and `fill --job X SEL TEXT` all work.
    """
    subs = parser._subparsers._group_actions[0].choices if parser._subparsers else {}
    verb_at = None
    for index, piece in enumerate(argv):
        if piece == '--':
            break
        if piece in subs or piece in VERB_ALIASES:
            verb_at = index
            break
    if verb_at is None:
        return list(argv), None
    verb = VERB_ALIASES.get(argv[verb_at], argv[verb_at])
    sub = subs.get(verb)
    pre, rest = list(argv[:verb_at]), list(argv[verb_at + 1:])

    # lift --job / --target out of both halves
    name, explicit_target = None, None

    def lift(tokens, allow_target):
        nonlocal name, explicit_target
        out, i = [], 0
        while i < len(tokens):
            piece = tokens[i]
            if piece == '--':
                out.extend(tokens[i:])
                break
            if piece in ('--job', '-j') and i + 1 < len(tokens):
                name, i = tokens[i + 1], i + 2
                continue
            if piece.startswith('--job='):
                name, i = piece.split('=', 1)[1], i + 1
                continue
            if allow_target and verb not in ('job', 'passkey'):
                if piece == '--target' and i + 1 < len(tokens):
                    explicit_target, i = tokens[i + 1], i + 2
                    continue
                if piece.startswith('--target='):
                    explicit_target, i = piece.split('=', 1)[1], i + 1
                    continue
            out.append(piece)
            i += 1
        return out
    pre = lift(pre, False)
    rest = lift(rest, True)

    # pre-verb options the verb understands move after it
    moved, kept, i = [], [], 0
    while i < len(pre):
        piece = pre[i]
        flag = piece.split('=', 1)[0]
        arity = _opt_arity(sub, flag) if sub is not None and piece.startswith('-') else None
        if arity is not None:
            take = 1 if '=' in piece else 1 + arity
            moved.extend(pre[i:i + take])
            i += take
        else:
            kept.append(piece)
            i += 1
    if moved:
        stop = rest.index('--') if '--' in rest else len(rest)
        rest = rest[:stop] + moved + rest[stop:]   # after the positionals: argparse's '?' positionals bind early

    source = 'flag' if name else None
    if name:
        name = sanitize_job_name(name) or name
    else:
        name, source = default_job_name()
    out = kept + [verb] + rest
    if sub is None or verb == 'job':
        return out, None
    if verb == 'passkey':
        # only passkey subcommands that declare --job get one (`_keeper`, `import` do not)
        pk = next((a.choices.get(rest[0]) for a in sub._actions
                   if isinstance(a, argparse._SubParsersAction) and rest), None)
        if pk is None or '--job' not in pk._option_string_actions:
            return out, None
        return (kept + [verb] + rest + ['--job', name]), None
    if verb not in TARGET_VERBS:
        return out, None

    indexes = _scan_positionals(sub, rest)
    low, high = _positional_shape(sub, rest)
    count = len(indexes)
    if explicit_target is not None:
        target_present = False
        rest = [explicit_target] + rest
        has_explicit = True
    else:
        has_explicit = False
        first = rest[indexes[0]] if indexes else None
        if count > high:
            target_present = True
        elif count < low or low == high:
            target_present = False if source == 'flag' else bool(first and looks_like_target(first) and count > low)
        else:
            target_present = bool(first and looks_like_target(first) and count > low)
    if has_explicit or target_present:
        if source == 'flag':
            os.environ['TOPHAT_CDP_JOB_HINT'] = name
            os.environ['TOPHAT_CDP_JOB_SOURCE'] = 'flag'
        return kept + [verb] + _positionals_first(sub, rest), None
    os.environ['TOPHAT_CDP_JOB_SOURCE'] = source or 'flag'
    return kept + [verb] + ['job=' + name] + _positionals_first(sub, rest), name


def _positionals_first(sub, rest):
    """argparse binds an optional positional (`navigate TARGET [url]`) with the first positional chunk, so
    `navigate job=X --expect-url P URL` died with "unrecognized arguments: 1 extra value" while
    `navigate job=X URL` worked. Positionals first, options after;
    `--` and everything past it stays as written. Same function in rev6/tools/tophat-cdp.mjs."""
    if '--' in rest:
        return rest
    idx = set(_scan_positionals(sub, rest))
    return [t for i, t in enumerate(rest) if i in idx] + [t for i, t in enumerate(rest) if i not in idx]



TARGET_HELP = ('target id, unique id prefix, or url=/url^=/url*=/title*= selector. '
               'An ambiguous selector is an error listing every candidate (it is how a script once '
               'filled issue_number-ltr instead of number-ltr).')

EPILOG = """\
SECRETS (read before typing a password, token or card number):
  * never put a secret in argv: argv lands in shell history, process listings and, on a usage
    error, in transcripts. Use --secret-from VAULT_ID[:field] (ID:totp = one-time code): tophat-pass is
    read inside this tool, the value never enters your shell. Or --text-stdin, --text-env VAR,
    --text-file PATH (add --secret to get the same guard and redaction).
  * a secret source REQUIRES --expect-url PREFIX (an https:// page, or a job claimed with
    --expect-url), refuses chat/mail/AI sites (Discord, WhatsApp, Slack, Gmail, claude.ai, the
    the instance's own chat app...), refuses anything but a focused <input>/<textarea> (a contenteditable chat
    box is refused), and types nothing unless all of that holds.
  * output never carries the value: fill prints "[redacted:N chars]" for secret sources and for
    any type=password field, argparse errors never echo argument values, and stdout/stderr are
    scrubbed of every secret this process saw.
  * example: tophat-cdp --job cf claim ... then
      tophat-cdp fill --job cf 'input[type=password]' --secret-from import-d705e790:password --expect-url https://dash.cloudflare.com/

command line forgiveness: --job NAME (or --target ID) and --steal/--expect-url/--timeout/--json
may sit before OR after the verb; `fill ID SEL TEXT --job X` uses ID; verbs nav/goto/js/shot work;
eval takes --expr/--file/--stdin and --max-chars; navigate/new take --url; screenshot takes --out;
dom-click takes --text/--index; a value starting with '-' goes after `--`.

examples:
  tophat-cdp status
  tophat-cdp targets --type page --filter amazon
  tophat-cdp frames --filter checkout.pci
  ID=$(tophat-cdp new https://example.com); tophat-cdp eval $ID 'document.title'
  tophat-cdp eval $ID --file /tmp/snippet.js
  tophat-cdp screenshot $ID /tmp/page.png --full-page
  tophat-cdp fill $ID '#email' user@example.com
  tophat-cdp keys $ID Tab a b Enter
  tophat-cdp wait-for $ID --selector '#done' --timeout 30
  tophat-cdp close $ID

gotchas baked into this tool (see the module docstring and README-tophat-cdp.md):
  * websocket-client needs suppress_origin=True or Chrome answers 403.
  * /json/new is HTTP 405 here; `new` uses Target.createTarget on the browser socket.
  * any target attaches at ws://HOST/devtools/page/<id>, iframes included.
  * Input.* into an OOPIF is sometimes accepted and silently ignored; `fill`
    reads the value back and fails loudly, dom-click always works.
  * target selectors are anchored/unique; ambiguity is an error.
  * React/Shopify inputs ignore DOM value assignment; focus + Input.insertText works.
  * key events into an unfocused tab vanish unless focus emulation is on; the
    input verbs turn it on for you (--no-focus-emulation opts out).

jobs (one job = one owned tab, like a UI-automation job = one window):
  tophat-cdp job claim shop --url https://www.amazon.com   # create and own a tab
  tophat-cdp --job shop navigate https://www.amazon.com/cart
  tophat-cdp --job shop text '#nav-cart-count'
  tophat-cdp job list                                      # jobs, urls, drift, age
  tophat-cdp job release shop --close
  A mutating verb aimed at a tab another live job holds is REFUSED and names the
  holder; --steal overrides. The job warns on stderr when its tab has been moved
  off where the job left it, and --expect-url PREFIX makes that exit 6.

exit codes: 0 ok, 1 usage, 2 endpoint unreachable, 3 target/JS error, 4 timeout,
5 refused (protected target, or another job's tab), 6 the tab is not where the
job left it.
"""


def build_parser():
    import argparse

    parser = ForgivingParser(
        prog='tophat-cdp',
        description='Control the local Chrome over the DevTools Protocol. Endpoint comes from '
                    '$TOPHAT_CDP_ENDPOINT or browserCdp in the tophat config file (TOPHAT_CONFIG); '
                    'local http only, never guessed.',
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--job', metavar='NAME',
                        help='act on the tab owned by this job instead of naming a target id. Valid before or '
                             'after the verb; $TOPHAT_CDP_JOB sets it for a shell. Claim one with `job claim`.')
    subs = parser.add_subparsers(dest='command', parser_class=ForgivingParser)

    def add(name, help_text, **kwargs):
        sub = subs.add_parser(name, help=help_text, description=help_text,
                              formatter_class=argparse.RawDescriptionHelpFormatter, **kwargs)
        return sub

    add('status', 'Print endpoint, browser version, reachability and config source as JSON.').set_defaults(func=cmd_status)
    add('endpoint', 'Print the configured CDP endpoint URL.').set_defaults(func=cmd_endpoint)

    for name in ('targets', 'list'):
        p = add(name, 'List targets: id, type, title, url. Touches nothing (plain /json/list).')
        p.add_argument('--filter', help='substring of url+title (case-insensitive by default)')
        p.add_argument('--exact', action='store_true', help='--filter must equal the url exactly')
        p.add_argument('--prefix', action='store_true', help='--filter must be a url prefix')
        p.add_argument('--case-sensitive', action='store_true')
        p.add_argument('--type', help='comma list: page,iframe,worker,service_worker,browser_ui,other')
        p.add_argument('--json', action='store_true')
        p.add_argument('--full-url', action='store_true', help='do not truncate long urls in the table')
        p.add_argument('--max-url', type=int, default=160)
        p.set_defaults(func=cmd_targets)

    p = add('frames', 'List cross-origin iframe (OOPIF) targets by url. Several frames routinely SHARE one url '
                      '(six did on the Shopify checkout), so prefer `frame-map`, which names each one by the '
                      '<iframe> element that embeds it.')
    p.add_argument('--filter', help='substring of the frame url')
    p.add_argument('--json', action='store_true')
    p.add_argument('--full-url', action='store_true', help='do not truncate long urls in the table')
    p.add_argument('--max-url', type=int, default=160)
    p.set_defaults(func=cmd_frames)

    p = add('new', 'Create a tab and print its target id. Uses Target.createTarget because /json/new is 405 here.')
    p.add_argument('url', nargs='?', default='about:blank')
    p.add_argument('--url', dest='url_opt', metavar='URL', help='same as the positional')
    p.add_argument('--background', action='store_true', help='accepted, and the default: do not bring the new tab to the front')
    p.add_argument('--new-context', action='store_true', help='create it in a fresh browser context (separate cookies)')
    p.add_argument('--json', action='store_true')
    p.set_defaults(func=cmd_new)

    p = add('close', 'Close a target.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('--force', action='store_true', help='ignore the protected-target list')
    p.set_defaults(func=cmd_close)

    p = add('activate', 'Bring a tab to the front.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_activate)

    p = add('navigate', 'Navigate a target to a url (Page.navigate).')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('url', nargs='?')
    _soft(p, 'url')
    p.add_argument('--url', dest='url_opt', metavar='URL', help='same as the positional')
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_navigate)

    p = add('reload', 'Reload a target.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('--ignore-cache', action='store_true')
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_reload)

    p = add('dialog', 'Report an open JavaScript dialog (alert/confirm/prompt/beforeunload), and --accept or --dismiss it. '
                      'An open dialog is why every eval on a tab times out.')
    p.add_argument('target', help=TARGET_HELP)
    g = p.add_mutually_exclusive_group()
    g.add_argument('--accept', action='store_true')
    g.add_argument('--dismiss', action='store_true')
    p.add_argument('--prompt-text', default=None)
    p.add_argument('--wait', type=float, default=1.5, help='seconds to wait for the re-emitted dialog event')
    p.add_argument('--timeout', type=float, default=10.0)
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_dialog)

    p = add('info', 'Live url, title, readyState and viewport of a target.')
    p.add_argument('target', help=TARGET_HELP)
    p.set_defaults(func=cmd_info)

    p = add('eval', 'Runtime.evaluate with returnByValue and awaitPromise. JS from an argument, --file, or stdin. '
                    'A JavaScript exception exits 3 with the message.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('js', nargs='?', help='JavaScript expression')
    p.add_argument('--file', help='read the JavaScript from a file instead (no shell quoting pain)')
    p.add_argument('--stdin', action='store_true', help='read the JavaScript from stdin (also what happens with no JS argument)')
    p.add_argument('--expr', '--expression', '--js', '--script', '--code', '-e', dest='js_opt', metavar='JS',
                   help='same as the positional JS')
    p.add_argument('--max-chars', type=int, default=None, help='truncate the printed result')
    p.add_argument('--await', dest='await_ok', action='store_true', help='accepted and ignored: promises are awaited by default')
    p.add_argument('--no-await', action='store_true', help='do not await a returned promise')
    p.add_argument('--json', action='store_true', help='always JSON-encode the result, even strings')
    p.add_argument('--timeout', type=float, default=30.0)
    p.set_defaults(func=cmd_eval)

    p = add('html', 'outerHTML of a selector (default: the whole document).')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', nargs='?')
    p.add_argument('--max-chars', type=int, default=200000)
    p.set_defaults(func=cmd_html)

    p = add('text', 'innerText of a selector (default: body).')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', nargs='?')
    p.add_argument('--max-chars', type=int, default=200000)
    p.set_defaults(func=cmd_text)

    p = add('screenshot', 'PNG of a target to a file.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('out', nargs='?', help='output .png path')
    _soft(p, 'out')
    p.add_argument('--out', '--output', '-o', dest='out_opt', metavar='PATH', help='same as the positional')
    p.add_argument('--clip', help='x,y,w,h in CSS pixels')
    p.add_argument('--full-page', action='store_true', help='whole scrollable page (captureBeyondViewport)')
    p.add_argument('--scale', type=float, default=1.0)
    p.add_argument('--timeout', type=float, default=30.0)
    p.add_argument('--allow-secret-fields', action='store_true',
                   help='capture a tab that had a --secret-from fill WITHOUT blurring its fields (default: '
                        'inputs and iframes are blurred and a warning goes to stderr)')
    p.set_defaults(func=cmd_screenshot)

    p = add('pdf', 'Print a target to a PDF file (Page.printToPDF).')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('out', help='output .pdf path')
    p.add_argument('--timeout', type=float, default=30.0)
    p.set_defaults(func=cmd_pdf)

    p = add('download', 'Fetch URL inside the tab (with its cookies) and write the bytes to OUT.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('url', help='absolute, or relative to the tab')
    p.add_argument('out', help='output path')
    p.add_argument('--expect-pdf', action='store_true', help='exit 3 unless the bytes start with %%PDF-')
    p.add_argument('--timeout', type=float, default=40.0)
    p.set_defaults(func=cmd_download)

    p = add('click', 'Mouse click at x,y in CSS pixels (mouseMoved, mousePressed, mouseReleased). '
                     'On a FRAME target the coordinates are frame-local and the events are sent to the '
                     'embedding page, translated by the frame origin. `tap` is the verb that takes a '
                     'selector and hit-tests before clicking.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('x', type=float)
    p.add_argument('y', type=float)
    p.add_argument('--in-frame', action='store_true',
                   help='dispatch to the frame target itself, old behaviour, frame-local coordinates')
    p.add_argument('--button', default='left', choices=['left', 'right', 'middle'])
    p.add_argument('--clicks', type=int, default=1)
    p.add_argument('--force', action='store_true', help='dispatch even to a protected target')
    p.add_argument('--no-focus-emulation', action='store_true', help='do not turn on Emulation.setFocusEmulationEnabled first')
    p.set_defaults(func=cmd_click)

    p = add('upload', 'Attach local files to an <input type=file> (DOM.setFileInputFiles; no file dialog).')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', help='CSS selector of the file input, e.g. input[type=file]')
    p.add_argument('files', nargs='+')
    p.add_argument('--index', type=int, default=0)
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_upload)

    p = add('dom-click', 'Click a selector through the DOM (el.click()). This DOES work inside an OOPIF target.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', nargs='?')
    p.add_argument('--text', metavar='NEEDLE', default=None,
                   help='among the matches, click the one whose visible text contains NEEDLE')
    p.add_argument('--index', type=int, default=None, help='click the Nth (0-based) match')
    p.add_argument('--force', action='store_true')
    p.set_defaults(func=cmd_dom_click)

    p = add('type', 'Insert text at the focused element with Input.insertText (no per-key events). '
                    'A frame target is routed to its embedding page. Unverified by design; `fill` is the '
                    'verb that clicks a selector, replaces its value and checks the result.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('text', nargs='?')
    _soft(p, 'text')
    add_text_sources(p)
    p.add_argument('--in-frame', action='store_true', help='dispatch to the frame target itself (old behaviour)')
    p.add_argument('--force', action='store_true')
    p.add_argument('--no-focus-emulation', action='store_true')
    p.set_defaults(func=cmd_type)

    p = add('keys', 'Send key events (keyDown/char/keyUp) for each key: a single character, a named key '
                    '(Enter, Tab, Escape, Backspace, Delete, Space, Arrow*, Home, End, PageUp, PageDown), '
                    'optionally with Shift+/Ctrl+/Meta+/Alt+ modifiers.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('keys', nargs='*')
    add_text_sources(p)
    p.add_argument('--select-all', action='store_true',
                   help='select the focused field first, with Meta+a carrying the selectAll editing command '
                        '(the only form that selects inside an OOPIF)')
    p.add_argument('--in-frame', action='store_true', help='dispatch to the frame target itself (old behaviour)')
    p.add_argument('--delay', type=float, default=0, help='milliseconds between keys')
    p.add_argument('--force', action='store_true')
    p.add_argument('--no-focus-emulation', action='store_true')
    p.set_defaults(func=cmd_keys)

    p = add('fill', 'Replace a field\'s value for real. Clicks the element at hit-tested PAGE coordinates, '
                    'selects all with the selectAll editing command, inserts the text into the embedding page '
                    'target, reads the value back from the frame that owns the element, and checks the page for '
                    'a validation message about that field. The selector may pierce frames with >>>: '
                    '\'#card-fields-expiry >>> input\'. Exit 7 if it could not be put under the pointer, '
                    'exit 8 if the readback or the page disagrees.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', help='CSS selector, optionally frame-piercing: \'IFRAME_CSS >>> ELEMENT_CSS\'')
    p.add_argument('text', nargs='?')
    _soft(p, 'text')
    add_text_sources(p)
    p.add_argument('--selector-file', metavar='PATH', help='read the selector from a file')
    p.add_argument('--append', action='store_true', help='do not select-all first; add to what is there')
    p.add_argument('--no-click', action='store_true', help='do not click the element first (it must already be focused)')
    p.add_argument('--no-scroll', action='store_true', help='do not scroll it into view; fail instead')
    p.add_argument('--no-focus-check', action='store_true', help='type even if the click did not move focus to the element')
    p.add_argument('--allow-error', action='store_true', help='do not fail when the page shows a validation message for the field')
    p.add_argument('--settle', type=float, default=250, help='ms to wait before reading the value back (default 250)')
    p.add_argument('--input-target', help='obsolete, ignored: input always goes to the embedding page')
    p.add_argument('--dom-value', action='store_true', help='set .value through the native setter instead (plain forms only)')
    p.add_argument('--force', action='store_true')
    p.add_argument('--no-focus-emulation', action='store_true')
    p.set_defaults(func=cmd_fill)

    p = add('clear', 'Empty a field: click it, select all, insert nothing, verify it is empty. Never a '
                     'Backspace loop, which walks focus backwards through a segmented card input and eats '
                     'the neighbouring fields.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', help='CSS selector, optionally frame-piercing with >>>')
    p.add_argument('--no-click', action='store_true')
    p.add_argument('--no-scroll', action='store_true')
    p.add_argument('--no-focus-check', action='store_true')
    p.add_argument('--allow-error', action='store_true')
    p.add_argument('--settle', type=float, default=250)
    p.add_argument('--force', action='store_true')
    p.add_argument('--no-focus-emulation', action='store_true')
    p.set_defaults(func=cmd_clear)

    p = add('tap', 'Click an element for real: scroll whatever actually scrolls until it is in the page '
                   'viewport, hit-test the point, then dispatch the mouse events to the PAGE target at those '
                   'coordinates. This is what submits a form that ignores el.click(). Exit 7 if the point '
                   'does not reach the element; nothing is dispatched in that case.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', help='CSS selector, optionally frame-piercing with >>>')
    p.add_argument('--button', default='left', choices=['left', 'right', 'middle'])
    p.add_argument('--clicks', type=int, default=1)
    p.add_argument('--no-scroll', action='store_true')
    p.add_argument('--settle', type=float, default=120, help='ms to wait before reporting the result')
    add_pick_args(p)
    p.add_argument('--force', action='store_true')
    p.add_argument('--no-focus-emulation', action='store_true')
    p.set_defaults(func=cmd_tap)

    p = add('point', 'Where an element really is: the frame chain, the owning target, absolute page '
                     'coordinates, whether it is in view and what document.elementFromPoint finds there. '
                     'Scrolls it into view unless --no-scroll. Exit 7 if a click would not reach it.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('selector', help='CSS selector, optionally frame-piercing with >>>')
    p.add_argument('--no-scroll', action='store_true')
    p.add_argument('--page-errors', action='store_true', help='also report the page validation text near the field')
    add_pick_args(p)
    p.set_defaults(func=cmd_point)

    p = add('frame-map', 'Every iframe in a tab, named by the element that embeds it: a ready-to-use selector, '
                         'the child target id, size, position and url. Use this instead of matching frame urls, '
                         'which collide.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('--depth', type=int, default=3, help='how many levels of nested frames to walk (default 3)')
    p.add_argument('--json', action='store_true')
    p.set_defaults(func=cmd_frame_map)

    p = add('wait-for', 'Poll a target until a condition holds; exit 4 on timeout.')
    p.add_argument('target', help=TARGET_HELP)
    p.add_argument('--selector', help='wait until document.querySelector(SEL) exists')
    p.add_argument('--url-changes', action='store_true', help='wait until location.href differs from now')
    p.add_argument('--url-contains', help='wait until location.href contains this')
    p.add_argument('--text-contains', help='wait until body innerText contains this')
    p.add_argument('--timeout', type=float, default=30.0)
    p.add_argument('--poll', type=float, default=0.25)
    p.set_defaults(func=cmd_wait_for)

    add('protected', 'Show the target ids that mutating verbs refuse to touch, and whether they are still live.').set_defaults(func=cmd_protected)

    pk = add('passkey', 'Passkeys: a software (virtual) authenticator plugged into a job\'s tab through the '
                        'DevTools WebAuthn domain, with the private keys kept in the encrypted vault. '
                        'A passkey can only be ENROLLED on a site you are already signed in to; an existing '
                        'iCloud Keychain / Touch ID passkey can never be adopted, because its private key is '
                        'non-exportable by design. The authenticator belongs to one tab and one keeper '
                        'process: attach before the sign-in page, detach when done.')
    pk.set_defaults(func=cmd_passkey)
    pks = pk.add_subparsers(dest='passkey_command')

    def pk_add(name, help_text, job=True):
        sub = pks.add_parser(name, help=help_text, description=help_text,
                             formatter_class=argparse.RawDescriptionHelpFormatter)
        if job:
            sub.add_argument('--job', metavar='NAME',
                             help='the job whose tab gets the authenticator (one job = one tab)')
            sub.add_argument('--steal', action='store_true', help='act on a tab another live job owns')
            sub.add_argument('--force', action='store_true', help='ignore the protected-target list')
        return sub

    p = pk_add('list', 'Stored tophat passkeys by relying party and user name. Key material is never printed.')
    p.add_argument('--rp-id', help='only this relying party (e.g. webauthn.io)')

    p = pk_add('status', 'Which jobs currently have a virtual authenticator, and what it has seen.')

    p = pk_add('attach', 'Create the virtual authenticator for a job\'s tab and inject every stored credential '
                         'for the relying party, BEFORE navigating to the sign-in page. Idempotent: a second '
                         'attach reuses the live keeper and only injects what is missing.')
    p.add_argument('--rp-id', help='inject only this relying party\'s credentials (default: all stored)')
    p.add_argument('--no-credentials', action='store_true',
                   help='attach an empty authenticator (what `enroll` does)')

    p = pk_add('enroll', 'Attach an EMPTY authenticator so a registration ceremony on the page creates a new '
                         'credential inside it. The site must ALREADY BE SIGNED IN: enrolment is "add a passkey '
                         'to this account", not a way into an account you cannot reach. Afterwards run '
                         '`passkey save --job NAME`.')
    p.add_argument('--rp-id', required=True, help='relying party id, e.g. webauthn.io')
    p.add_argument('--user-name', help='label to store the credential under')
    p.add_argument('--wait', type=float, default=0,
                   help='poll this many seconds for a credential to appear and save it automatically')

    p = pk_add('save', 'Read the job\'s authenticator and persist any credential not already in the vault.')
    p.add_argument('--rp-id', help='only save credentials for this relying party')
    p.add_argument('--user-name', help='label to store them under')

    p = pk_add('detach', 'Destroy the job\'s virtual authenticator and stop its keeper. Signature counters are '
                         'written back to the vault first.')
    p.add_argument('--no-sync', action='store_true', help='do not write signature counters back')

    p = pk_add('forget', 'Delete stored credentials by relying party or credential id.', job=False)
    p.add_argument('--rp-id')
    p.add_argument('--id', help='credential id (base64url), as shown by `passkey list`')

    p = pk_add('export', 'Encrypted archive of the stored passkeys, for moving tophat-created credentials to '
                         'another machine. Apple/hardware passkeys are not in here and cannot be: their private '
                         'keys are non-exportable.', job=False)
    p.add_argument('--file', required=True)
    p.add_argument('--key-file', help='where the transfer key goes (default: FILE.key)')

    p = pk_add('import', 'Load an archive written by `passkey export`.', job=False)
    p.add_argument('--file', required=True)
    p.add_argument('--key-file')

    p = pks.add_parser('_keeper', help=argparse.SUPPRESS)
    p.add_argument('name')
    p.add_argument('--target-id', required=True)
    p.add_argument('--rp-id')

    job = add('job', 'Own a tab under a name, so concurrent agents stop yanking each other. One job is one tab, '
                     'exactly as an UI-automation job is one window; lockless, nothing waits.')
    job.set_defaults(func=cmd_job)
    jobs = job.add_subparsers(dest='job_command')

    jc = jobs.add_parser('claim', help='Create (or re-attach) a tab owned by NAME and print the record.')
    jc.add_argument('name')
    jc.add_argument('--url', help='open the tab here, and record it as the job fingerprint')
    jc.add_argument('--target', help='adopt this existing target instead of creating one')
    jc.add_argument('--steal', action='store_true', help='take a tab another live job holds')
    jc.add_argument('--new', action='store_true', help='always a fresh tab, even if the job already has one')
    jc.add_argument('--foreground', action='store_true', help='bring the new tab to the front (default: background)')
    jc.add_argument('--new-context', action='store_true', help='fresh browser context (separate cookies)')
    jc.add_argument('--ephemeral', action='store_true', help='mark it short-lived (a caller releases it on exit)')
    jc.add_argument('--expect-url', metavar='PREFIX', help='store a sticky expectation: every later command on '
                                                           'this job fails (exit 6) if the tab leaves PREFIX')

    ja = jobs.add_parser('adopt', help='Take ownership of an existing tab under NAME.')
    ja.add_argument('name')
    ja.add_argument('--target', required=True, help=TARGET_HELP)
    ja.add_argument('--steal', action='store_true')
    ja.add_argument('--expect-url', metavar='PREFIX')

    jr = jobs.add_parser('release', help='Give up the job. The tab stays open unless --close.')
    jr.add_argument('name')
    jr.add_argument('--close', action='store_true', help='close the tab as well')

    jl = jobs.add_parser('list', help='Jobs with their target id, current url, drift and age. Reaps dead entries.')
    jl.add_argument('--all', action='store_true', help='include UI-automation window jobs from the shared namespace')
    jl.add_argument('--keep-stale', action='store_true', help='do not reap entries whose tab is gone')

    js = jobs.add_parser('show', help='One job, re-resolved, with its drift.')
    js.add_argument('name')

    jy = jobs.add_parser('sync', help='Adopt the tab\'s current url as the job fingerprint (silences drift).')
    jy.add_argument('name')

    je = jobs.add_parser('expect', help='Set or clear the sticky url-prefix expectation.')
    je.add_argument('name')
    je.add_argument('prefix', nargs='?')
    je.add_argument('--clear', action='store_true')

    jobs.add_parser('reap', help='Drop registry entries whose tab no longer exists.')

    # Flags every target-taking verb shares, added once so no verb forgets them.
    for verb, sub in subs.choices.items():
        if verb not in TARGET_VERBS:
            continue
        sub.add_argument('--steal', action='store_true',
                         help='act even on a tab another live job owns (names the holder otherwise)')
        sub.add_argument('--expect-url', metavar='PREFIX',
                         help='refuse (exit 6) unless the tab is on PREFIX: the anti-yank check')

    return parser


def apply_job_flag(argv, parser=None):
    """Compatibility shim: the logic lives in normalize_argv."""
    return normalize_argv(argv, parser or build_parser())[0]


def main(argv):
    install_redaction()
    parser = build_parser()
    if not argv:
        argv = ['status']
    argv, _auto_job = normalize_argv(argv, parser)
    args = parser.parse_args(argv)
    args.job_source = env_get('TOPHAT_CDP_JOB_SOURCE')
    if not getattr(args, 'func', None):
        parser.print_help()
        return EUSAGE
    if args.func is cmd_wait_for and not (args.selector or args.url_changes or args.url_contains or args.text_contains):
        parser.error('wait-for needs --selector, --url-changes, --url-contains or --text-contains')
    try:
        return args.func(args)
    except CdpError as error:
        sys.stderr.write('tophat-cdp: %s\n' % error)
        return error.code
    except BrokenPipeError:
        return OK
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # keep the old one-line failure shape
        sys.stderr.write('tophat-cdp: %s\n' % error)
        return EUSAGE


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
