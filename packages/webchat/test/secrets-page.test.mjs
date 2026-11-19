// /secrets page contract, read from the source the way archive-shortcut-close.test.mjs reads the chat page (the page has no
// component harness): the data-loss paths a user hit on 2026-11-18 stay closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/routes/secrets/+page.svelte', import.meta.url), 'utf8');
const form = readFileSync(new URL('../src/lib/ui/SecretForm.svelte', import.meta.url), 'utf8');
const script = page.slice(0, page.indexOf('</script>'));
const style = page.slice(page.indexOf('<style>'));
const body = (name) => {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const next = script.indexOf('\n  function ', start + 10);
  const asyncNext = script.indexOf('\n  async function ', start + 10);
  const end = [next, asyncNext].filter((n) => n > 0).sort((a, b) => a - b)[0];
  return script.slice(start, end ?? undefined);
};

test('the page-wide shortcut goes through the shared keybind layer, not a window keydown handler of its own', () => {
  assert.match(script, /bindGlobalKeys\(\{ '\/': /);
  assert.doesNotMatch(page, /svelte:window[^>]*onkeydown/);
  assert.doesNotMatch(script, /event\.key === '\/'/);
});

test('searching only filters: it never changes mode, scope away from the list, the selection or a draft', () => {
  const onSearch = body('onSearchInput');
  assert.doesNotMatch(onSearch, /mode\s*=|selectedId\s*=|draft|blank/);
  assert.match(script, /let selected = \$derived\(entries\.find\(\(entry\) => entry\.id === selectedId\)/);
  assert.doesNotMatch(script, /let selected = \$derived\(shown/);
  assert.match(body('onSearchKeydown'), /query = ''/);
});

test('the New credential button never resets a draft, and go() never clears the selection', () => {
  assert.doesNotMatch(page, /draft = blank\(\)/);
  assert.doesNotMatch(body('go'), /selectedId\s*=\s*null/);
  assert.match(body('startNew'), /if \(!box\.dirty\) box\.set/);
});

test('Save clears the draft only after the vault accepted it, and a failure keeps it', () => {
  const save = body('saveForm');
  assert.ok(save.indexOf('await post(') > 0 && save.indexOf('box.clear()') > save.indexOf('await post('), 'clear comes after the post');
  assert.match(save, /catch \(cause\) \{ failed\(cause, 'Could not save\. What you typed is still here\.'\)/);
  assert.ok(save.indexOf('if (!built.ok)') < save.indexOf('await post('), 'invalid input stops before the post, keeping the draft');
});

test('closing the form keeps the draft; only the confirmed Discard clears it', () => {
  assert.doesNotMatch(body('closeForm'), /clear\(\)/);
  assert.match(body('discardForm'), /box\?\.clear\(\)/);
  assert.match(form, /Discard what you typed\?/);
  assert.match(form, /confirming = true/);
});

test('leaving the tab with an unsaved draft asks first, and flushes the draft to the tab storage', () => {
  assert.match(script, /addEventListener\('beforeunload', beforeUnload\)/);
  const unload = body('beforeUnload');
  assert.match(unload, /event\.preventDefault\(\)/);
  assert.match(unload, /\.flush\(\)/);
});

test('the form keeps nothing of its own: every field reads and writes the draft store', () => {
  assert.doesNotMatch(form, /bind:value/);
  assert.match(form, /draft\.patch\(\{ \[item\]: e\.currentTarget\.value \}\)/);
  assert.doesNotMatch(form, /onkeydown[^}]*Tab/);
});

test('the title and the section pill are stacked, not side by side', () => {
  assert.match(style, /\.brand \{[^}]*flex-direction: column/);
});

test('secrets stay masked: password-type inputs until Show, nothing in a URL, nothing logged', () => {
  assert.match(form, /type=\{spec\.secret && !reveal\[item\] \? 'password' : 'text'\}/);
  assert.match(form, /masked/);
  assert.doesNotMatch(page + form, /console\.(log|info|debug|warn)/);
  assert.doesNotMatch(page + form, /location\.(href|search)\s*=|goto\(|searchParams\.set/);
  assert.match(script, /setTimeout\(\(\) => \(revealed = null\), 60_000\)/);
});

test('deleting asks first', () => {
  assert.match(page, /Delete \{selected\.name\} for good\?/);
  assert.match(page, /data-testid="delete-yes"/);
});
