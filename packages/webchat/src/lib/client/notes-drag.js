/** Delegated gesture: moving immediately selects/scrolls; holding still picks up a subtree.
 *
 * What travels is a unit, not a line: the line and the bullets under it, and on the first line of
 * a block the whole block, which then lands beside another block rather than inside its words.
 * While it travels the document says so, because on a phone the drop is the hard part: everything
 * being carried is greyed out, every line is clamped to one row however long it is, levels deeper
 * than the one being dragged are hidden, and holding the finger at the top or bottom edge keeps
 * scrolling on its own so a long move does not need a dozen separate drags.
 */
const EDGE = 72;        // how close to the end of the screen the finger starts pulling the document
const MAX_SPEED = 26;   // px per frame at the very edge

export function lineDrag(node, options) {
  let cleanup = () => {};
  let suppressUntil = 0;
  function down(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const line = event.target.closest('[data-line]');
    const handle = event.target.closest('[data-drag-handle]');
    if (!line || event.target.closest('[data-fold], [data-marker], [data-await], a')) return;
    cleanup();
    const source = options.source(Number(line.dataset.line));
    if (!source) return;
    let active = false, destination = null, frame = 0;
    let x = event.clientX, y = event.clientY;
    const startX = x, startY = y;
    const abort = new AbortController();
    const listen = (name, fn, extra = {}) => window.addEventListener(name, fn, { signal: abort.signal, ...extra });
    const indicator = document.createElement('div');
    indicator.className = 'notes-drop-indicator';
    indicator.dataset.testid = 'notes-drop-indicator';
    const scroller = node.closest('.scroller');

    // Everything the gesture is carrying, as rows on the screen: the line and its children, or
    // every line of the block once the drop has left that block.
    const block = line.closest('[data-block]');
    const rowsOf = (indices) => (indices || [Number(line.dataset.line)])
      .map((index) => block?.querySelector(`[data-line="${index}"]`))
      .filter(Boolean);
    const subtree = rowsOf(source.rows);
    const everything = rowsOf(source.blockRows);
    let carried = subtree;
    const depth = Number(line.dataset.depth || 0);
    const grey = (rows) => {
      if (rows === carried) return;
      for (const row of carried) if (!rows.includes(row)) row.classList.remove('drag-source');
      carried = rows;
      for (const row of carried) row.classList.add('drag-source');
    };

    const activate = () => {
      active = true;
      const wasAt = line.getBoundingClientRect().top;   // where the grabbed line sits before collapse
      suppressUntil = Date.now() + 1000;
      if (document.activeElement?.matches('[data-testid="notes-box"]')) document.activeElement.blur();
      window.getSelection()?.removeAllRanges();
      node.classList.add('dragging-lines');
      document.body.classList.add('notes-dragging');
      document.body.classList.add('drag-compact');
      for (const row of carried) row.classList.add('drag-source');
      // On a phone the grip and chevron are put away until asked for; a held row is asked for.
      line.classList.add('grip-held');
      // Deeper levels are not landing spots for this move, so they fold away for its duration. A
      // line being carried stays visible: he has to see what is in his hand. A retired 2pt line
      // stays too: the drag view draws the document with the normal renderer, and a checked-off
      // line folding away under a grab is what made the page jump.
      for (const row of document.querySelectorAll('.line[data-depth]')) {
        if (carried.includes(row) || row.classList.contains('retired')) continue;
        if (Number(row.dataset.depth || 0) > depth) row.classList.add('drag-deep');
      }
      document.body.append(indicator);
      // Collapsing the document moves it under his finger, so the line he grabbed is pinned: the
      // scroll takes up exactly what the collapse removed above it.
      if (scroller) scroller.scrollTop += line.getBoundingClientRect().top - wasAt;
      frame = requestAnimationFrame(roll);
    };
    // The grip carries the line as soon as it moves; a grip pressed and let go without moving is a
    // click, and arming at the press collapsed wrapped lines and scrolled the page under that click.
    const timer = handle ? null : setTimeout(activate, 500);
    cleanup = () => {
      clearTimeout(timer); cancelAnimationFrame(frame); abort.abort(); indicator.remove();
      node.classList.remove('dragging-lines');
      for (const row of everything) row.classList.remove('drag-source');
      line.classList.remove('grip-held');
      for (const row of document.querySelectorAll('.line.drag-deep')) row.classList.remove('drag-deep');
      document.body.classList.remove('drag-compact');
      if (active) document.body.classList.remove('notes-dragging');
      if (active) suppressUntil = Date.now() + 500;
      cleanup = () => {};
    };
    if (handle) event.preventDefault();

    /** Where the finger is now, as a place in the document. */
    const place = () => {
      const hit = document.elementFromPoint(x, y)?.closest('[data-line]');
      destination = null; indicator.style.display = 'none';
      if (!hit) return;
      const rect = hit.getBoundingClientRect();
      const under = hit.closest('[data-block]');
      const after = y > rect.top + rect.height / 2;
      const target = options.target(under?.dataset.block, Number(hit.dataset.line));
      // The block rule only means anything once the drop has left the block it started in.
      const whole = source.first === true && under?.dataset.block !== source.block;
      const mine = whole ? source.blockIds : source.ids;
      if (!target || mine.includes(target.id)) return;
      grey(whole ? everything : subtree);
      destination = { line: source.id, target: target.id, after, whole };
      Object.assign(indicator.style, {
        display: 'block', position: 'fixed', pointerEvents: 'none', zIndex: '1000', height: '2px',
        background: 'var(--accent, #8b80ec)', left: `${rect.left}px`, width: `${rect.width}px`,
        top: `${after ? rect.bottom : rect.top}px`
      });
    };

    /** The edge pull. A finger held still at the bottom of the screen still fires no events, so
     *  the scrolling is a frame loop rather than something hung off pointermove. */
    const roll = () => {
      frame = requestAnimationFrame(roll);
      if (!active || !scroller) return;
      const bounds = scroller.getBoundingClientRect();
      const view = window.visualViewport;
      // The soft keyboard covers the bottom of the layout viewport; the floor is what he can see.
      const floor = view ? Math.min(bounds.bottom, view.offsetTop + view.height) : bounds.bottom;
      const ceiling = bounds.top;
      let step = 0;
      if (y < ceiling + EDGE) step = -speed(ceiling + EDGE - y);
      else if (y > floor - EDGE) step = speed(y - (floor - EDGE));
      if (!step) return;
      const was = scroller.scrollTop;
      scroller.scrollTop = was + step;
      if (scroller.scrollTop !== was) place();
    };
    const speed = (into) => Math.min(MAX_SPEED, 3 + Math.max(0, into) / 3);

    listen('pointermove', e => {
      if (e.pointerId !== event.pointerId) return;
      x = e.clientX; y = e.clientY;
      if (!active) {
        const moved = Math.hypot(x - startX, y - startY);
        if (handle && moved > 3) activate();
        else {
          if (moved > 6) cleanup();
          return;
        }
      }
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      place();
    }, { passive: false });
    listen('touchmove', e => { if (active) e.preventDefault(); }, { passive: false });
    listen('contextmenu', e => { if (active) e.preventDefault(); });
    listen('pointerup', e => {
      if (e.pointerId !== event.pointerId) return;
      const move = active && destination;
      cleanup();
      if (move) options.move(move);
      // A grip pressed and let go where it was is a click on the line behind it, and the page's
      // click handler puts the caret there; only a real drag swallows the click.
      else if (handle && Math.hypot(x - startX, y - startY) <= 6) suppressUntil = 0;
    });
    listen('pointercancel', cleanup);
    listen('blur', cleanup);
    listen('keydown', e => { if (e.key === 'Escape') cleanup(); });
  }
  const suppress = event => {
    const grip = event.target.closest('[data-drag-handle]');
    if (Date.now() < suppressUntil || (grip && event.type !== 'click')) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('mousedown', suppress, true);
  node.addEventListener('mouseup', suppress, true);
  node.addEventListener('click', suppress, true);
  return { update(value) { options = value; }, destroy() { cleanup(); node.removeEventListener('pointerdown', down); for (const name of ['mousedown', 'mouseup', 'click']) node.removeEventListener(name, suppress, true); } };
}
