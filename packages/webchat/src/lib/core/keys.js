

const APPLE_RE = /mac|iphone|ipad|ipod/i;

let apple = null;

export function isApple() {
  if (apple === null) {
    if (typeof navigator === 'undefined') return false; 
    apple = APPLE_RE.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  }
  return apple;
}


export function isMod(event) {
  return isApple() ? event.metaKey : event.ctrlKey;
}


export const MAC_TEXT_KEYS = new Set(['a', 'b', 'd', 'e', 'f', 'h', 'k', 'n', 'o', 'p', 't', 'v', 'y']);

export function isMacTextBinding(event, { listNavigation = false } = {}) {
  if (!isApple()) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = String(event.key || '').toLowerCase();
  if (listNavigation && (key === 'n' || key === 'p')) return false;
  return MAC_TEXT_KEYS.has(key);
}


export function isListDown(event) {
  return event.key === 'ArrowDown' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === 'n');
}


export function isListUp(event) {
  return event.key === 'ArrowUp' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key?.toLowerCase() === 'p');
}
