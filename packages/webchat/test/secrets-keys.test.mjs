// "/" focuses the search box on /secrets, and it must never do that from inside a field (2026-11-18: a "/" typed in the note field
// moved focus to the search box, the rest of the note went into the filter and the list emptied). The rule is in core/keys.js
// bindGlobalKeys, which every page binds its shortcuts through; these tests pin it on a real DOM (jsdom).
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bindGlobalKeys, globalKeyBlocked, isTextEntry } from '../src/lib/core/keys.js';

function page() {
  const dom = new JSDOM(`<body><input id=search type=search><input id=text type=text><input id=pw type=password><textarea id=ta></textarea>
    <select id=sel><option>a</option></select><div id=ce contenteditable="true">x</div><div id=tb role="textbox" tabindex=0></div>
    <input id=cb type=checkbox><button id=btn>b</button><div id=plain tabindex=0>p</div></body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const hits = [];
  const unbind = bindGlobalKeys({ '/': () => hits.push('slash'), 'mod+k': () => hits.push('modk') }, { target: window, mac: true });
  const press = (el, init = {}) => {
    el.focus();
    const event = new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  return { window, hits, press, unbind, $: (id) => window.document.getElementById(id) };
}

test('a "/" typed in any text-entry control goes to that control and fires no shortcut', () => {
  const p = page();
  for (const id of ['search', 'text', 'pw', 'ta', 'sel', 'ce', 'tb']) {
    const event = p.press(p.$(id));
    assert.equal(event.defaultPrevented, false, `${id}: the browser's own handling is never prevented`);
  }
  assert.deepEqual(p.hits, []);
});

test('outside a field the shortcut fires once and is prevented', () => {
  const p = page();
  for (const id of ['plain', 'btn', 'cb']) {
    p.hits.length = 0;
    const event = p.press(p.$(id));
    assert.equal(event.defaultPrevented, true, id);
    assert.deepEqual(p.hits, ['slash'], id);
  }
});

test('input-method composition and key repeat never fire a shortcut', () => {
  const p = page();
  p.press(p.$('plain'), { isComposing: true });
  p.press(p.$('plain'), { keyCode: 229 });
  p.press(p.$('plain'), { repeat: true });
  assert.deepEqual(p.hits, []);
});

test('a bare key never fires on a ctrl/meta/alt chord; mod+k fires only with the modifier', () => {
  const p = page();
  p.press(p.$('plain'), { ctrlKey: true });
  p.press(p.$('plain'), { metaKey: true });
  p.press(p.$('plain'), { key: 'k' });
  assert.deepEqual(p.hits, []);
  p.press(p.$('plain'), { key: 'k', metaKey: true });
  assert.deepEqual(p.hits, ['modk']);
});

test('unbinding removes the listener', () => {
  const p = page();
  p.unbind();
  p.press(p.$('plain'));
  assert.deepEqual(p.hits, []);
});

test('the focused field blocks the key even when the event target is the document', () => {
  const p = page();
  p.$('ta').focus();
  const event = new p.window.KeyboardEvent('keydown', { key: '/', bubbles: true });
  assert.equal(globalKeyBlocked(event, p.window.document), true);
  assert.equal(isTextEntry(p.$('btn')), false);
  assert.equal(isTextEntry(p.$('cb')), false);
});
