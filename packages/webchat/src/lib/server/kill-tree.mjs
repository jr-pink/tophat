































import { spawn } from 'node:child_process';









export const liveChildren = new Set();








export function killTree(child, kill = process.kill.bind(process)) {
  return signalTree(child, 'SIGKILL', kill);
}







export function signalTree(child, signal, kill = process.kill.bind(process)) {
  if (!child) return false;
  // A handle with no pid is a fork that failed, and it is never signalled. In the same tick as the
  // failed spawn, child.kill() hands libuv's still-zero pid to kill(2), and kill(0, sig) signals the
  // caller's whole process group: that is what took a test run's server, playwright and 27 spec
  // files down together as exit 143. A tick later the same call is merely useless.
  if (!(child.pid > 0)) return false;
  try { kill(-child.pid, signal); return true; } catch {  }
  try { child.kill(signal); return true; } catch { return false; }
}






export function spawnGroup(command, args, options = {}, spawnFn = spawn) {
  const child = spawnFn(command, args, { ...options, detached: true });
  if (child?.pid > 0) {
    liveChildren.add(child);
    const forget = () => { liveChildren.delete(child); };
    child.once('exit', forget);
    child.once('error', forget);
  }
  return child;
}










export function onSignal(getChildren = () => liveChildren, kill = killTree, exit = (code) => process.exit(code)) {
  return (signal) => {
    const held = getChildren();
    const children = held == null ? [] : (typeof held[Symbol.iterator] === 'function' ? [...held] : [held]);
    for (const child of children) {
      try { kill(child); } catch {  }
    }
    exit(130, signal);
  };
}












export function resignal({
  off = () => {},
  kill = process.kill.bind(process),
  pid = () => process.pid,
  exit = (code) => process.exit(code),
} = {}) {
  return (code, signal) => {
    if (!signal) { exit(code); return; }
    off(signal);
    try { kill(pid(), signal); } catch { exit(code); }
  };
}







export function installSignalKill(getChildren = () => liveChildren, {
  signals = ['SIGINT', 'SIGTERM'],
  on = process.on.bind(process),
  off = process.removeListener.bind(process),
  exit = null,
} = {}) {
  let handler;
  const strategy = exit ?? resignal({ off: (signal) => off(signal, handler) });
  handler = onSignal(getChildren, killTree, strategy);
  for (const sig of signals) on(sig, handler);
  return handler;
}
