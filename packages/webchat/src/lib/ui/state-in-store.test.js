// Owner rule, 2026-11-10: every fold lives in the store from the first commit. A fold kept only in the DOM
// (<details open> bound to compiled markdown) snapped shut on every streamed chunk and every scroll. Every <details> in the
// app takes its open state from the fold store (disclosure.svelte.js), and the DOM never owns it (no bind:open).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const files = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.svelte') ? [p] : []; });

describe('UI state lives in the store', () => {
  for (const file of files(ROOT)) {
    const src = readFileSync(file, 'utf8');
    const tags = [...src.matchAll(/<details\b[^>]*>/g)].map((m) => m[0]);
    if (!tags.length) continue;
    it(`${path.relative(ROOT, file)}: every <details> reads its open state from the fold store`, () => {
      expect(src).toMatch(/from ['"][^'"]*disclosure\.svelte\.js['"]/);
      for (const tag of tags) {
        expect(tag, tag).not.toMatch(/bind:open/);
        expect(tag, tag).toMatch(/\bopen=\{/);
      }
    });
  }
});
