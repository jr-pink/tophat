

export function waited(sinceIso, nowMs = Date.now(), { floorMs = 3_000 } = {}) {
  if (!sinceIso) return '';
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return '';
  const ms = nowMs - since;
  if (!(ms >= floorMs)) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
