// Bars are labelled with raw counts (correct/n) and sized by correct/n; no percentages anywhere.
// Draws the memory-bench bar charts as inline SVG (static, no script) for the fallback page.
// Data: memory-bench-charts.json, the personal and LongMemEval charts of the memory benchmark's public-charts.json, with our row named tophat and flagged ours: true, and the assistant that held only the evidence named generically and flagged separate: true.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const W = 360, ROW = 31, TOP = 4, BAR_H = 9;

function chart(key, d, { title, apart: footed }) {
  // Rows on the same input are ranked; a row marked `separate` (a different, smaller input) goes last, below a rule, hatched
  // and footnoted. `ours` marks the tophat row.
  const all = d.rows.map((r) => ({ ...r, label: r.system, ours: Boolean(r.ours), apart: Boolean(r.separate) }));
  const byScore = (a, b) => b.correct / b.n - a.correct / a.n;
  const main = all.filter((r) => !r.separate).sort(byScore), apart = all.filter((r) => r.separate).sort(byScore);
  const rows = [...main, ...apart], GAP = apart.length ? 12 : 0;
  const H = TOP + rows.length * ROW + GAP + 2;
  let g = '';
  if (apart.length) g += `<line x1="0" x2="${W}" y1="${TOP + main.length * ROW + GAP / 2 + 1}" y2="${TOP + main.length * ROW + GAP / 2 + 1}" class="sep"/>`;
  rows.forEach((r, i) => {
    const y = TOP + i * ROW + (r.separate ? GAP : 0), w = (W * r.correct) / r.n, label = r.apart ? `${r.label} *` : r.label;
    g += `<text x="0" y="${y + 11}" class="lb${r.ours ? ' us' : ''}">${esc(label)}</text>`
      + `<text x="${W}" y="${y + 11}" text-anchor="end" class="pc${r.ours ? ' us' : ''}">${r.correct}/${r.n}</text>`
      + `<rect x="0" y="${y + 16}" width="${W}" height="${BAR_H}" class="tr"/>`
      + `<rect x="0" y="${y + 16}" width="${w.toFixed(1)}" height="${BAR_H}" class="bar${r.ours ? ' us' : ''}${r.apart ? ' apart' : ''}"${r.apart ? ` style="fill:url(#hatch-${key})"` : ''}/>`;
  });
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t-${key}"><title id="t-${key}">${esc(title)}: ${rows.map((r) => `${r.label} ${r.correct} of ${r.n}`).join('; ')}</title>`
    + (footed ? '<defs><pattern id="hatch-' + key + '" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hl"/></pattern></defs>' : '') + g + '</svg>';
  const k = rows.find((r) => r.apart);
  const foot = footed && k ? `<p class="fn">* ${esc(k.label)} is not ranked with the rest: it was given only the 137 events that contain the answers, not the flooded haystack every other row holds, and was asked the ${k.n} questions whose evidence those events carry. Its bar is a smaller, easier input.</p>` : '';
  return `<figure class="chart"><figcaption><b>${esc(title)}</b> ${esc(d.caption)}</figcaption>${svg}${foot}</figure>`;
}

export function renderCharts(data) {
  return {
    personal: chart('personal', data.personal_flooded_with_services, { title: 'Personal history, flooded haystack.', apart: true }),
    hard15: chart('hard15', data.setB_longmemeval_hard15, { title: 'LongMemEval-S, hardest questions.' })
  };
}
