// The server-down page with its bar charts filled in: fallback.html's <!--chart:KEY--> markers replaced by the SVG charts from charts.mjs.
// Shipped with the release (unlike edge/, which is the maintainers' own deployment): the edge build inlines this page into its Worker,
// and the demo origin serves it at /_fallback.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCharts } from './charts.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function renderFallback() {
  const charts = renderCharts(JSON.parse(readFileSync(path.join(HERE, 'memory-bench-charts.json'), 'utf8')));
  let page = readFileSync(path.join(HERE, 'fallback.html'), 'utf8');
  for (const [k, svg] of Object.entries(charts)) {
    if (!page.includes(`<!--chart:${k}-->`)) throw new Error('fallback.html lacks the ' + k + ' chart marker');
    page = page.replace(`<!--chart:${k}-->`, () => svg);
  }
  return page;
}
