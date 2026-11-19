// Image right-click: "Copy Image" is the first item and copies the bytes as PNG (owner request, 2026-11-15 16:04 PST: "also what
// happened in another chat i told it to add copy image to the image right click ctx menu pls fix"). "Copy Image Address" stays
// below it. The menu is a Svelte fallback provider, so these read ContextMenuHost.svelte's source, like folder-menu.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/lib/ui/ContextMenuHost.svelte', import.meta.url), 'utf8');
const ids = [...src.slice(src.indexOf("provideMenu('app'")).matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);

test('Copy Image is the first item of the app menu, shown only for an image', () => {
  assert.equal(ids[0], 'copy-image-data');
  assert.match(src, /x\.src && \{ id: 'copy-image-data', label: 'Copy Image',/);
});

test('Copy Image Address stays, below Copy Image', () => {
  assert.ok(ids.indexOf('copy-image') > ids.indexOf('copy-image-data'));
  assert.match(src, /id: 'copy-image', label: 'Copy Image Address'/);
});

test('the clipboard gets image/png; other types are redrawn through a canvas', () => {
  assert.match(src, /new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(src, /blob\.type === 'image\/png'\) return blob/);
  assert.match(src, /createImageBitmap\(blob\)/);
  assert.match(src, /canvas\.toBlob\((?:.*)'image\/png'\)/);
});
