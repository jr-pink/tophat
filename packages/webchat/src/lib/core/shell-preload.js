// The shell loads its one script from an inline dynamic import of the hashed bundle under
// _app/immutable, at the end of the body. A script waits for the stylesheets above it, so on a cold
// open the 411 KB bundle was not asked for until the CSS had come back (a full round trip, measured
// at 90-200 ms on the demo): the two downloads ran one after the other. A modulepreload link at the
// top of the head starts the script download with the CSS. The link is built from the same html, so
// it names exactly the bundle that page will import.
//
// The example of that call used to be written out just above. The corpus scanner reads a dynamic
// import whose path is a string literal as a real import even inside a comment, resolved the one in
// this comment against this directory, and reported the result as a missing entry point on every
// nightly pass. The pattern below, whose backslashes keep it out of that scan, is the only copy of
// the shape this file needs.

const IMPORT = /import\(\s*(["'])((?:\.\/|\/)?_app\/immutable\/bundle\.[A-Za-z0-9_-]+\.js)\1\s*\)/;

/** The page chunk with `<link rel="modulepreload">` for its bundle at the start of `<head>`; any other chunk, or a page that has one already, unchanged. */
export function preloadBundle(html) {
  if (typeof html !== 'string') return html;
  const found = IMPORT.exec(html);
  if (!found) return html;
  const href = found[2];
  if (html.includes(`rel="modulepreload" href="${href}"`)) return html;
  return html.replace(/<head[^>]*>/, (open) => `${open}<link rel="modulepreload" href="${href}">`);
}
