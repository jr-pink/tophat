// The server-down page: fallback.html's markers filled from the site's one copy file, content/description.md (the same words the live
// demo's first answer streams), each feature a closed one-line box (its bold heading) with the rest of its copy and its figures below.
// Figures are the live answer's own widgets (src/answer.mjs FIGURES, placed by <!-- figure:NAME --> in the copy), framed from /_fallback/w/<name>, which the edge Worker serves;
// a plain image is inlined. Shipped with the release (unlike edge/, the maintainers' own deployment): the edge build inlines this page
// into its Worker, and the demo origin serves it at /_fallback.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sections, FIGURES } from '../src/answer.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(HERE, '..');
export const DESCRIPTION = path.join(DEMO, 'content', 'description.md');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** The inline markdown the copy uses: links, **bold**, *italic*. */
export const inline = (s) => esc(s)
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>');
const paras = (md) => md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inline(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('\n');

/** The widget names the page frames (served by the edge at /_fallback/w/<name>), in page order; images are inlined instead. */
export const FRAMED = [...sections(DESCRIPTION).intro.matchAll(/^<!--\s*figure:([\w-]+)\s*-->/gm)].map((m) => FIGURES[m[1]]?.[0]).filter((f) => f && f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));

function figure(n) {
  const w = FIGURES[n];
  if (!w) return '';
  const [file, title] = w, name = file.replace(/\.[a-z]+$/, '');
  if (file.endsWith('.html')) return `<iframe class="w w-${name}" loading="lazy" sandbox="allow-scripts" title="${esc(title)}" src="/_fallback/w/${name}"></iframe>`;
  const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const b64 = readFileSync(path.join(DEMO, 'widgets', file)).toString('base64');
  return `<img class="shot" loading="lazy" alt="${esc(title)}" src="data:${type};base64,${b64}">`;
}

/** The boxes: one per <details> section of the copy, its summary the bold numbered line, its body the copy and figures in order. */
const DETAILS = /^<details(?:\s+open)?(?:\s+data-stream="closed")?>\s*\n<summary>\*\*(\d+)\.\s+(.+?)\*\*<\/summary>\s*\n([\s\S]*?)^<\/details>\s*$/gm;
export function boxes(s = sections(DESCRIPTION)) {
  return [...s.intro.matchAll(DETAILS)].map((m) => {
    const bits = m[3].split(/^<!--\s*figure:([\w-]+)\s*-->\s*$/m);
    return { n: m[1], line: m[2].trim(), parts: bits.map((b, i) => (i % 2 ? figure(b) : paras(b))) };
  });
}
/** The copy before the first section, without the top install block (the page has its own). */
const preface = (s) => s.intro.split(/^<details/m)[0].replace(/^<!--[^>]*-->\s*$/gm, '').replace(/^Install:\s*$/m, '');

export function renderFallback() {
  const s = sections(DESCRIPTION);
  const [title, ...sub] = s.lead.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const install = /^([\s\S]*?)```\s*\n([\s\S]*?)\n```/.exec(s.install);
  if (!title || !install) throw new Error('content/description.md lacks its lead or its install block');
  const fill = {
    lead: `<h1>${inline(title)}</h1>\n${sub.map((p) => `<p class="sub">${inline(p)}</p>`).join('\n')}`,
    intro: paras(preface(s)),
    boxes: boxes(s).map((b) => `<details class="box" id="f${b.n}">
<summary><span class="n">${b.n}.</span><span class="line">${inline(b.line)}</span><span class="tog" aria-hidden="true"></span></summary>
<div class="more">
${b.parts.filter(Boolean).join('\n')}
</div>
</details>`).join('\n\n'),
    install: `<h2>${inline(install[1].trim())}</h2>
<div class="code"><pre id="install">${esc(install[2].trim()).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</pre></div>`
  };
  let page = readFileSync(path.join(HERE, 'fallback.html'), 'utf8');
  for (const [k, v] of Object.entries(fill)) {
    if (!page.includes(`<!--${k}-->`)) throw new Error(`fallback.html lacks the <!--${k}--> marker`);
    page = page.replace(`<!--${k}-->`, () => v);
  }
  return page;
}
