// A cold open used to ask for the notes only after the app's JavaScript had arrived and run: four
// dependent round trips (document, entry, chunks, route node) before the first request for the
// document the page exists to show. The document now starts that request itself (src/app.html),
// before any script has loaded, and the page takes the answer from here instead of asking again.
// Only the notes' present view is started early, with exactly the query loadPresent sends
// (early.test.js holds the three places to the same string).

export const EARLY_NOTES_PRESENT = '/api/notes?view=present&rollover=1&limit=200&past=6&future=120';

/** The response promise the document already started for this url, once, or null. */
export function takeEarly(url, scope = globalThis) {
  const table = scope.__tophatEarly;
  const pending = table?.[url];
  if (!pending) return null;
  delete table[url];
  return pending;
}
