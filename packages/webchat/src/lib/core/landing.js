import { marker } from '../../../../runner/tools/docstore-kit/lib/recipes.js';


export const NIGHT_FROM = 23;
export const NIGHT_UNTIL = 5;

export function isNight(hour) {
  return hour >= NIGHT_FROM || hour < NIGHT_UNTIL;
}

export function landingFor({ hour, today, seen, path = '/', stay = false, landed = false, chat = null }) {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  if (stay || landed || chat || path !== '/') return null;
  if (isNight(hour)) return '/fnf';
  // the app opens on the chats unless it is night.
  return null;
}

// removed in phase 6 of the UI-state migration. A stored copy on a device is left where it is.

// Whether this tab has already landed today (the night jump happens once per tab per day): the kit's `marker` recipe
// on the tab's storage; the old `tophat-landed` sessionStorage key is imported once, then archived.
export const landedDecl = marker('landed', { storage: 'tab', legacyKey: 'tophat-landed' });

export const SLOW_BRIEF_MS = 3_500;
