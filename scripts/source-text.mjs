// Text of a module with its whole-line comments blanked, for scanning imports: a comment that quotes an import
// (`// loads import("./_app/immutable/bundle.<hash>.js")`) is not a dependency and must not stop the assembly.
// Only comments that begin a line are blanked (// ... and /* ... */ blocks), so a `//` or `/*` inside a string or URL is never touched.
// Line count is kept, so positions in messages still line up.
export function withoutLineComments(text) {
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
