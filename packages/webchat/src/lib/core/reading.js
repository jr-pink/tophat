

export const BOTTOM_SLACK = 120;

export function positionFrom({ scrollTop, viewport, scrollHeight, rows }) {
  const atBottom = scrollTop + viewport >= scrollHeight - BOTTOM_SLACK;
  if (atBottom || !rows?.length) return { itemId: null, frac: 0, atBottom: true };
  const row = rowAt(rows, scrollTop);
  if (!row) return { itemId: null, frac: 0, atBottom: false };
  
  
  const frac = row.height > 0 ? clamp((scrollTop - row.top) / row.height, 0, 1) : 0;
  return { itemId: row.id, frac, atBottom: false };
}

export function scrollTopFor(position, { scrollHeight, viewport, rows }) {
  if (!position) return null;
  if (position.atBottom) return Math.max(0, scrollHeight - viewport);
  const row = rows?.find((candidate) => candidate.id === position.itemId);
  
  
  
  
  if (!row) return null;
  const target = row.top + (Number.isFinite(position.frac) ? clamp(position.frac, 0, 1) : 0) * row.height;
  return clamp(Math.round(target), 0, Math.max(0, scrollHeight - viewport));
}

export function shouldAdopt(local, remote, { deviceId } = {}) {
  if (!remote?.at) return false;
  if (deviceId && remote.deviceId === deviceId) return false;
  if (!local?.at) return true;
  return remote.at > local.at;
}


export function samePlace(a, b) {
  if (!a || !b) return false;
  if (a.atBottom || b.atBottom) return Boolean(a.atBottom) === Boolean(b.atBottom);
  return a.itemId === b.itemId && Math.abs((a.frac || 0) - (b.frac || 0)) < 0.02;
}

function rowAt(rows, scrollTop) {
  let low = 0;
  let high = rows.length - 1;
  let found = rows[0];
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row.top + row.height <= scrollTop) low = mid + 1;
    else { found = row; high = mid - 1; }
  }
  return found;
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
