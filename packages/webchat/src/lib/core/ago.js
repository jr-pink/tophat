

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function messageAgo(at, nowMs = Date.now()) {
  const then = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(then)) return '';
  const ms = nowMs - then;
  
  
  
  if (ms < SECOND) return 'just now';

  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s ago`;
  if (ms < HOUR) return pair(Math.floor(ms / MINUTE), 'm', Math.floor((ms % MINUTE) / SECOND), 's');
  if (ms < DAY) return pair(Math.floor(ms / HOUR), 'h', Math.floor((ms % HOUR) / MINUTE), 'm');
  return pair(Math.floor(ms / DAY), 'd', Math.floor((ms % DAY) / HOUR), 'h');
}

function pair(big, bigUnit, small, smallUnit) {
  return small > 0 ? `${big}${bigUnit} ${small}${smallUnit} ago` : `${big}${bigUnit} ago`;
}

export function agoTickMs(at, nowMs = Date.now()) {
  const then = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(then)) return null;
  const ms = nowMs - then;
  
  
  
  if (ms < SECOND) return SECOND - ms;
  if (ms < HOUR) return SECOND - (ms % SECOND) || SECOND;
  if (ms < DAY) return MINUTE - (ms % MINUTE) || MINUTE;
  return HOUR - (ms % HOUR) || HOUR;
}
