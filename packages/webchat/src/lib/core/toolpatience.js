

export const PATIENCE_MS = 10_000;

export const DEFAULT_BACKGROUND_MS = 600_000;

const BACKGROUNDABLE = new Set(['Bash']);


export function isBackgrounded(item) {
  return Boolean(item?.input?.run_in_background);
}


export function backgroundBudget(item) {
  const asked = Number(item?.input?.timeout);
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_BACKGROUND_MS;
}


export function isTimed(item) {
  return Boolean(item) && item.type === 'tool' && item.state === 'running'
    && BACKGROUNDABLE.has(item.tool);
}

export function hasBackgrounded(item, now) {
  if (!isTimed(item)) return false;
  if (isBackgrounded(item)) return true;
  const started = Date.parse(item.at ?? '');
  return Number.isFinite(started) && now - started >= PATIENCE_MS;
}

export function ringFor(item, now) {
  if (!isTimed(item)) return null;
  const started = Date.parse(item?.at ?? '');
  if (!Number.isFinite(started)) return null;
  const elapsed = Math.max(0, now - started);
  const explicit = isBackgrounded(item);

  if (!explicit && elapsed < PATIENCE_MS) {
    return {
      tone: 'foreground',
      fraction: elapsed / PATIENCE_MS,
      remainingMs: PATIENCE_MS - elapsed
    };
  }

  const budget = backgroundBudget(item);
  
  
  const since = explicit ? elapsed : elapsed - PATIENCE_MS;
  return {
    tone: 'background',
    fraction: budget > 0 ? Math.min(1, since / budget) : 1,
    remainingMs: Math.max(0, budget - since),
    over: since >= budget
  };
}

export function backgroundedRunning(items, now = Date.now()) {
  return (items || []).filter((item) => hasBackgrounded(item, now));
}

export function tickDeadline(items) {
  let deadline = null;
  for (const item of items || []) {
    if (!isTimed(item)) continue;
    const started = Date.parse(item?.at ?? '');
    if (!Number.isFinite(started)) continue;
    
    
    
    const end = started + (isBackgrounded(item) ? 0 : PATIENCE_MS) + backgroundBudget(item);
    if (deadline === null || end > deadline) deadline = end;
  }
  return deadline;
}

export const COLLAPSE_ABOVE = 2;

export const RING_CIRCUMFERENCE = 40.84; 

export function ringDash(fraction) {
  const spent = Math.min(1, Math.max(0, Number(fraction) || 0));
  return {
    dasharray: RING_CIRCUMFERENCE,
    dashoffset: -RING_CIRCUMFERENCE * spent,
    transform: 'rotate(-90 8 8)'
  };
}
