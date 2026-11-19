// Cmd-E on a chat that is already archived still closes its open tab (the owner, 2026-11-18). The page has no component harness,
// so this reads routes/+page.svelte the way folder-menu.test.mjs reads the sidebar: the closing is ONE helper that archiveChat
// and the shortcut both use, and the shortcut's archived branch never archives again or records an undo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { nextAfterArchive } from '../src/lib/core/archive-select.js';

const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const body = (name) => {
  const start = page.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const next = page.indexOf('\n  function ', start + 10);
  return page.slice(start, next < 0 ? undefined : next);
};

test('closing a chat he put away is one helper, through the pane reducer', () => {
  const helper = body('closeChatTab');
  assert.match(helper, /pane\('pane\.drop', \{ ids: \[id\] \}\)/);
  assert.match(helper, /settlePanes\(\)/);
  assert.match(helper, /openTransient\(\)/);
  assert.match(body('archiveChat'), /closeChatTab\(id, next\)/);
  assert.doesNotMatch(body('archiveChat'), /pane\('pane\.drop'/);
});

test('the shortcut closes an open archived chat and leaves a closed one alone', () => {
  const shortcut = body('archiveShortcut');
  assert.match(shortcut, /archivedNow && !openChatIds\.includes\(id\)\) return;/);
  assert.match(shortcut, /if \(archivedNow\) closeChatTab\(id, nextAfterArchive\(/);
  assert.match(shortcut, /else archiveChat\(id, true\)/);
  const archivedBranch = shortcut.slice(shortcut.indexOf('if (archivedNow) closeChatTab'), shortcut.indexOf('else archiveChat'));
  assert.doesNotMatch(archivedBranch, /session\.archive|rememberUndo/);
});

test('an archived chat is not in the sidebar order, so the next chat is the first one', () => {
  assert.equal(nextAfterArchive(['a', 'b'], 'gone'), 'a');
  assert.equal(nextAfterArchive([], 'gone'), null);
});
