// The notes page as an instrument, for the interaction model check (tests/notes-parity.spec.js).
// Inert unless localStorage `notes-harness` is '1', which only the checker sets: it then hangs
// `window.__notesHarness` off the page so a sequence of real key presses can start from a known
// document and caret without a reload, and its outcome can be read back in the page's own terms.
//
// Nothing here edits the document. A reset goes through the page's own load path against the
// scratch server the checker seeded, and the caret is placed by the page's own focusBlock, so what
// is checked is the code that runs for the owner, not a copy of it.

/**
 * @param {object} page accessors the page hands over: `blocks()`, `isText`, `zoneOf`, `lines`,
 *   `focusId()`, `caretLine()`, `theBox()`, `scroller()`, `busy()` (true while a write is queued or
 *   in flight), `drained()` (the write chain's promise), `reset()` (clear the page's transient
 *   state and reload the document), `clearFocus()`, `focusBlock(id, bodyCaret)`,
 *   `renderedPoint(block, line, offset)`, `tick`.
 */
import { linePoint } from './notes-range.js';

export function installNotesHarness(page) {
  if (typeof window === 'undefined') return () => {};
  try { if (window.localStorage?.getItem('notes-harness') !== '1') return () => {}; }
  catch { return () => {}; }

  const settle = async ({ quick = false } = {}) => {
    // After a typed character the page is meant to hold the save back for the rest of the run, so
    // the check reads the screen without forcing the write out.
    if (quick) {
      await page.tick();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
    // Two frames and the page's write queue drained: a keydown handler is async and paints after
    // its awaits, so reading straight after the key would read the state before it.
    for (let round = 0; round < 200; round += 1) {
      page.flushNow?.();
      await page.drained();
      await page.tick();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!page.busy() && (page.ready?.() ?? true)) return true;
    }
    return false;
  };

  const snapshot = () => {
    const blocks = page.blocks().map((block) => ({
      id: block.id, zone: page.zoneOf(block), kind: block.kind, body: String(block.body ?? ''), ord: block.ord,
      lineIds: (block.lines || []).map((line) => line?.id ?? null)
    }));
    const active = document.activeElement;
    const box = page.theBox();
    let caret = null;
    if (box && active === box && page.focusId()) {
      const block = page.blocks().find((entry) => entry.id === page.focusId());
      const row = block ? page.lines(block)[page.caretLine()] : null;
      caret = {
        block: page.focusId(), line: page.caretLine(),
        start: box.selectionStart ?? null, end: box.selectionEnd ?? null,
        direction: box.selectionDirection ?? 'none', value: box.value ?? box.textContent ?? '',
        head: row?.head ?? ''
      };
    }
    let gap = null;
    if (active?.hasAttribute?.('data-gap-editor')) {
      gap = { before: active.dataset.before || null, after: active.dataset.after || null,
        boundary: active.dataset.boundary || null, at: active.selectionStart ?? 0 };
    }
    let selection = null;
    const range = window.getSelection();
    if (!caret && range && !range.isCollapsed && range.rangeCount) {
      selection = { anchor: linePoint(range.anchorNode, range.anchorOffset), focus: linePoint(range.focusNode, range.focusOffset) };
    }
    // What the eye reads top to bottom: every line and every blank between notes, the same list
    // the page's own ↑ and ↓ walk (adjacentSurface).
    const surfaces = [...(page.scroller()?.querySelectorAll('[data-line], [data-gap-editor]') || [])].map((node) => {
      if (node.hasAttribute('data-gap-editor')) {
        return { gap: true, before: node.dataset.before || null, after: node.dataset.after || null, boundary: node.dataset.boundary || null };
      }
      const owner = node.closest('[data-block]');
      return { block: owner?.dataset.block ?? null, zone: owner?.dataset.zone ?? null, line: Number(node.dataset.line) };
    });
    return {
      blocks, caret, gap, selection, surfaces, outbox: page.outbox?.() ?? 0, kept: page.kept?.() ?? null, history: page.history?.() ?? null,
      active: active ? `${active.tagName}${active.dataset?.testid ? `#${active.dataset.testid}` : ''}` : null
    };
  };

  window.__notesHarness = {
    settle,
    snapshot,
    /** Vim mode's engine as the page holds it (null when vim is off or untouched). */
    vim: () => page.vim?.() ?? null,
    /** Reload the document from the scratch store with nothing of the last sequence left over. */
    async reset() {
      await settle();
      await page.reset();
      await settle();
      return snapshot();
    },
    /** The caret into one line's words, as the page itself would put it there. */
    async caret(blockId, line, offset) {
      const block = page.blocks().find((entry) => entry.id === blockId);
      if (!block) return false;
      const row = page.lines(block)[line];
      if (!row) return false;
      const lineStart = String(block.body).split('\n').slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
      await page.focusBlock(blockId, lineStart + row.head.length + Math.min(offset, row.text.length));
      await settle();
      return true;
    },
    /** A selection inside the caret's line, anchor first, as Shift+arrows would leave it. */
    async select(start, end) {
      const box = page.theBox();
      if (!box) return false;
      box.setSelectionRange(Math.min(start, end), Math.max(start, end), start <= end ? 'forward' : 'backward');
      await settle();
      return true;
    },
    /** A document selection across rendered lines, as a drag would leave it. */
    async selectLines(anchor, focus) {
      document.activeElement?.blur?.();
      await page.clearFocus();
      await settle();
      const from = page.renderedPoint(anchor.block, anchor.line, anchor.offset);
      const to = page.renderedPoint(focus.block, focus.line, focus.offset);
      if (!from || !to) return false;
      window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
      await settle();
      return true;
    }
  };
  return () => { delete window.__notesHarness; };
}
