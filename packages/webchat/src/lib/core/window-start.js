// A browser window that opens straight onto a chat starts with the chat list tucked away; the list
// comes back as an overlay when the pointer rests on the left edge. `seen` is a per-window marker
// (sessionStorage): a reload keeps the window's own state, and only a window's first load counts as
// an opening.
export function startsSidebarHidden({ chatInUrl, opener, seen }) {
  if (seen) return false;
  // A bare ?chat= URL is also what a reload, a restored tab or a pasted link looks like, so only a
  // window another window opened (window.opener) counts: otherwise a reload lands with no chat list.
  return Boolean(opener);
}

export const SEEN_KEY = 'tophat.window-seen';
