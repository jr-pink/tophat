// The server-down page: the site's own copy (content/description.md), one closed line per feature, the live answer's figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFallback, boxes, FRAMED, DESCRIPTION } from '../fallback/render.mjs';
import { sections } from '../src/answer.mjs';
const WIDGETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'widgets');

test('one closed box per bold feature heading, its summary that heading alone', () => {
  const page = renderFallback();
  const headings = [...sections(DESCRIPTION).features.map((f) => f.body).join('\n').matchAll(/^\*\*(\d+)\.\s+([^*]+)\*\*/gm)].map((m) => m[2].trim());
  const summaries = [...page.matchAll(/<summary>.*?<span class="line">(.*?)<\/span>/g)].map((m) => m[1]);
  assert.equal(headings.length, 6);
  assert.deepEqual(summaries, headings.map((h) => h.replace(/&/g, '&amp;')));
  assert.equal((page.match(/<details class="box"[^>]*\bopen\b/g) || []).length, 0, 'every box starts closed');
  assert.ok(!/<!--(lead|intro|boxes|install)-->/.test(page), 'every marker filled');
});

test('every paragraph of the copy is on the page, and every figure of the live answer is framed or inlined', () => {
  const page = renderFallback();
  const b = boxes();
  assert.equal(b.length, 6);
  assert.match(page, /I'm your <b>exobrain<\/b>, for <b>you<\/b>, <b>forever<\/b>\./);
  assert.match(page, /This system is state of the art against both research memory systems and production products\./);
  assert.match(page, /Scan this repo for privacy, security, and malintent; then help me install it:\n<a href="https:\/\/github.com\/tophat-md\/tophat">/);
  for (const name of FRAMED) {
    // a built widget (memory-graph) ships as its template; its .html is generated from a private snapshot and gitignored, so a release tree has only the template
    assert.ok(existsSync(path.join(WIDGETS_DIR, name + '.html')) || existsSync(path.join(WIDGETS_DIR, name + '.template.html')), name);
    assert.match(page, new RegExp(`src="/_fallback/w/${name}"`));
  }
  assert.ok(FRAMED.includes('memory-bench'), 'Fig. 2 is on the page');
  assert.match(page, /<img class="shot"[^>]+src="data:image\/jpeg;base64,/);
});

test('white with rose highlights, light only, no dashes', () => {
  const page = renderFallback();
  assert.match(page, /--bg:#fff;/);
  assert.match(page, /--rose:#b45c6e/);
  assert.ok(!/prefers-color-scheme:\s*dark/.test(page));
  assert.ok(!page.includes('\u2014') && !page.includes('\u2013'));
});
