// Path-loaded files: a module that reads, spawns or compiles a sibling file by path (OCR.swift, containers.py, a .wav
// probe, models.json) never imports it, so an import closure misses it. This finds those references in a module's text.
//
// Recognised bases, resolved to the module's directory (each extra dirname() wrapping goes one level up):
//   import.meta.dirname, __dirname, [path.]dirname(fileURLToPath(import.meta.url)), and a const bound to one of these
//   (optionally through [path.]resolve(base, 'relative')).
// Recognised references: [path.]join|resolve(BASE, 'a', 'b', ...) with only string literals after the base, and
//   new URL('literal', import.meta.url). A template literal or a variable segment is not followed.
// Returns posix paths relative to the module's directory, e.g. 'OCR.swift', '../rev6/pull/models.json'.
import path from 'node:path';

const FILE_URL = String.raw`(?:url\.)?fileURLToPath\(\s*import\.meta\.url\s*\)`;
const LIT = String.raw`(['"])([^'"\n$]+)\1`;

/** Depth (levels above the module directory) of a base expression, or null when it is not one. */
function baseDepth(expr, names) {
  let e = expr.trim(), depth = 0;
  for (;;) {
    const m = /^(?:path\.(?:posix\.)?)?dirname\(\s*([\s\S]*)\)$/.exec(e);
    if (!m) break;
    e = m[1].trim();
    depth++;
  }
  if (new RegExp(`^${FILE_URL}$`).test(e)) return depth >= 1 ? { up: depth - 1, rel: '' } : null; // the file itself
  if (/^(?:import\.meta\.dirname|__dirname)$/.test(e)) return { up: depth, rel: '' };
  if (Object.hasOwn(names, e)) { const b = names[e]; return { up: b.up + depth, rel: b.rel }; }
  const r = new RegExp(String.raw`^(?:path\.)?resolve\(\s*([^,]+?)\s*,\s*${LIT}\s*\)$`).exec(e);
  if (r) { const b = baseDepth(r[1], names); if (b && depth === 0) return { up: b.up, rel: path.posix.join(b.rel, r[3]) }; }
  return null;
}

const baseDir = (b) => path.posix.normalize(path.posix.join(...Array(b.up).fill('..'), b.rel || '.'));

export function pathRefs(text) {
  const names = {};
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+?)\s*;?\s*$/gm)) {
    const b = baseDepth(m[2], names);
    if (b) names[m[1]] = b;
  }
  const refs = new Set();
  const call = /\b(?:path\.(?:posix\.)?)?(?:join|resolve)\(\s*(import\.meta\.dirname|__dirname|[A-Za-z_$][\w$]*|(?:path\.)?dirname\((?:[^()]|\([^()]*\))*\))\s*((?:,\s*(['"])[^'"\n$]+\3\s*)+)\)/g;
  for (const m of text.matchAll(call)) {
    const b = baseDepth(m[1], names);
    if (!b) continue;
    const segs = [...m[2].matchAll(/(['"])([^'"\n]+)\1/g)].map((x) => x[2]);
    refs.add(path.posix.normalize(path.posix.join(baseDir(b), ...segs)));
  }
  for (const m of text.matchAll(new RegExp(String.raw`new URL\(\s*${LIT}\s*,\s*import\.meta\.url\s*\)`, 'g'))) {
    refs.add(path.posix.normalize(path.posix.join('.', m[2])));
  }
  return [...refs].filter((r) => r && r !== '.' && !r.endsWith('/')).sort();
}
