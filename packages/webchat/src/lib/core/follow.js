

import { BOTTOM_SLACK as SLACK } from './reading.js';
export { BOTTOM_SLACK } from './reading.js';

export const AT_END = 24;

export const DELIVERY_MS = 250;

export function followBand(rate, clientHeight) {
  return Math.max(SLACK, Math.min(clientHeight, rate * DELIVERY_MS));
}

export function followDecision(s) {
  const before = s.seenHeight || s.scrollHeight;
  
  
  
  const clamp = Math.max(0, (before - s.clientHeight) - (s.scrollHeight - s.clientHeight));
  const upwards = s.scrollTop < s.seenTop - clamp - 1;
  const moved = s.scrollTop - (s.seenTop - clamp);
  
  
  const rate = s.seenAt ? Math.max(0, s.scrollHeight - before) / Math.max(1, s.now - s.seenAt) : 0;
  const seen = { height: s.scrollHeight, top: s.scrollTop, at: s.now };
  
  if (s.wrote >= 0 && Math.abs(s.scrollTop - s.wrote) < 1.5) {
    return { seen, ours: true, stick: s.following, room: 0, band: 0, moved, upwards, rate };
  }
  
  
  
  
  
  const room = s.following
    ? Math.min(before, s.scrollHeight) - s.scrollTop - s.clientHeight
    : s.scrollHeight - s.scrollTop - s.clientHeight;
  const band = followBand(rate, s.clientHeight);
  
  
  const arrived = room < AT_END || (!s.following && moved > 1 && moved >= room && room < band);
  return { seen, ours: false, stick: !upwards && arrived, room, band, moved, upwards, rate };
}

/**
 * While following, has the view left the end since we last wrote scrollTop? Only a move up counts: a parked view the
 * page moved down (scroll anchoring as a row above the viewport takes its real height, applied in the layout a
 * scrollTop read forces, a frame before its scroll event) is still at the end, and dropping the follow there left the
 * pane short of the end when that frame carried the last growth of a stream (follow.test.js).
 */
export function leftEndWhileFollowing({ scrollTop, wrote }) {
  return wrote >= 0 && scrollTop < wrote - 1.5;
}
