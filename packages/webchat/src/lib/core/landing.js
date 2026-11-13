import { marker } from '../../../../runner/tools/docstore-kit/lib/recipes.js';


export const NIGHT_FROM = 23;
export const NIGHT_UNTIL = 5;

export function isNight(hour) {
  return hour >= NIGHT_FROM || hour < NIGHT_UNTIL;
}

/** Where a cold open lands, or null to stay where the URL already points.
 *
 * One rule is left: between 23:00 and 05:00 the app opens on fire-and-forget, once per tab per day.
 *
 * It used to take `today` and `seen` as well, for the brief cache that went with that page, and
 * read neither; the shell was still reading the dead `tophat-brief-seen` key out of localStorage on
 * every boot to fill `seen`. Both are gone. `landed` is this tab's own marker for today, which the
 * shell still keeps (below), and `chat`, `stay` and `path` are read off the URL.
 */
export function landingFor({ hour, path = '/', stay = false, landed = false, chat = null }) {
  if (stay || landed || chat || path !== '/') return null;
  if (isNight(hour)) return '/fnf';
  return null;
}

// removed in phase 6 of the UI-state migration. A stored copy on a device is left where it is.

// Whether this tab has already landed today (the night jump happens once per tab per day): the kit's `marker` recipe
// on the tab's storage; the old `tophat-landed` sessionStorage key is imported once, then archived.
export const landedDecl = marker('landed', { storage: 'tab', legacyKey: 'tophat-landed' });

export const SLOW_BRIEF_MS = 3_500;
