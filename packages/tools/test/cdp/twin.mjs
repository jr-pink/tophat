// The Python old twin as a JSON-line child process; call(req) -> the decoded {ok|raised} reply.
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// websocket-client lives in the real user site; under scripts/test.sh HOME is a temp dir, so name the user
// base explicitly, and forbid the uv re-exec (a twin that cannot import fails loudly instead).
export function pythonEnv(env = {}) {
  const real = process.env.TOPHAT_TEST_REAL_HOME || os.homedir();
  const base = spawnSync('python3', ['-c', 'import site;print(site.getuserbase())'], { encoding: 'utf8', env: { ...process.env, HOME: real } }).stdout.trim();
  return { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUSERBASE: base, TOPHAT_CDP_BOOTSTRAPPED: '1', ...env };
}
// python3 when it can import websocket-client, else `uv run --with websocket-client python`.
export function pythonCmd(env = process.env) {
  const e = pythonEnv();
  if (spawnSync('python3', ['-c', 'import websocket'], { env: e }).status === 0) return ['python3'];
  const uv = [env.TOPHAT_UV, path.join(os.homedir(), '.local/bin/uv'), 'uv'].filter(Boolean).find((c) => spawnSync(c, ['--version']).status === 0);
  if (!uv) throw new Error('python3 has no websocket-client and uv is not installed');
  return [uv, 'run', '--quiet', '--with', 'websocket-client', 'python'];
}
export function oldTwin(env = {}) {
  const [cmd, ...lead] = pythonCmd();
  const child = spawn(cmd, [...lead, path.join(path.dirname(fileURLToPath(import.meta.url)), 'oldtwin.py')], { env: pythonEnv(env), stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.(JSON.parse(line)));
  return {
    pid: () => child.pid,
    call: (req) => new Promise((resolve) => { waiting.push(resolve); child.stdin.write(`${JSON.stringify(req)}\n`); }),
    close: () => child.stdin.end(),
  };
}
/** Python-side value cleaning, mirrored: non-finite floats become strings. */
export function clean(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}
