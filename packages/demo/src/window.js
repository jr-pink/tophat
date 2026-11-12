// The desktop window of very large screens: the three traffic lights (window.css draws the bar, the chip and the closed screen).
//   green   the app becomes the whole screen, as on a small display: no title bar, no lights; Escape brings the window back
//   yellow  shrinks the window into the tophat app icon at the bottom centre; the icon brings it back
//   red     fades the window out and leaves a line of text on the empty desk; a click (or Enter) brings it back, so does a reload
// All of it is the one object `state` and the one function `set(patch)`: the attributes on <html> are a projection of it, never read back.
(function () {
  if (window.__thWindow) return; window.__thWindow = true;
  var EASE = 'cubic-bezier(.4,0,.2,1)';                 // one easing for every motion here
  var MS = { min: 360, close: 180, full: 280 };
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;
  var state = { full: false, view: 'open', hidden: false, busy: false }; // view: open | min | closed; hidden: the window is painted away; busy: a motion is running

  var bar = el('div', { id: 'th-bar' }, '<div class="bg"></div><div class="lights"><button data-act="close" aria-label="Close"></button><button data-act="min" aria-label="Minimize"></button><button data-act="full" aria-label="Full screen"></button></div><div class="title">tophat</div>');
  var chip = el('button', { id: 'th-chip', 'aria-label': 'Show tophat' }, '<img src="/dock-icon-rose.png" alt="" draggable="false">'); // the app icon (the 3D hat in rose felt, tophat-site scripts/render-hat.html?finish=rose), as in the dock
  var closed = el('div', { id: 'th-closed' }, 'ya played yourself'); // closing is final until a reload: the text is not a way back
  document.body.append(bar, chip, closed);
  var parts = { bg: bar.querySelector('.bg'), lights: bar.querySelector('.lights'), title: bar.querySelector('.title') };
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); e.innerHTML = html; return e; }
  var app = function () { return document.querySelector('body>div[style*="contents"]'); };

  function paint() {
    root.toggleAttribute('data-th-full', state.full);
    root.toggleAttribute('data-th-hidden', state.hidden);
    root.setAttribute('data-th-view', state.view);
  }
  function play(e, keys, ms, origin) {
    if (origin) e.style.transformOrigin = origin;
    var a = e.animate(keys, { duration: reduce ? 0 : ms, easing: EASE, fill: 'both' });
    return a.finished.then(function () { return a; }, function () { return a; });
  }
  function done(anims) { anims.forEach(function (a) { try { a.cancel(); } catch (e) {} }); [bar, parts.bg, parts.lights, parts.title].concat([].slice.call(document.body.children)).forEach(function (e) { if (e && e.style) e.style.transformOrigin = ''; }); }
  function win() { var b = bar.getBoundingClientRect(), a = app() ? app().getBoundingClientRect() : b; var l = Math.min(a.left, b.left), t = Math.min(a.top, b.top), r = Math.max(a.right, b.right), bt = Math.max(a.bottom, b.bottom); return { x: (l + r) / 2, y: (t + bt) / 2 }; }
  // the window toward a point and a scale (and out), or back from it: the bar and the app move as one, about the window's centre
  function collapse(to, ms, forward) {
    // every element on the page moves as one (the bar, the app and anything the app floats directly in <body>), so nothing is left behind
    var c = win(), els = [].slice.call(document.body.children).filter(function (e) { return e !== chip && e !== closed && !/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(e.tagName); });
    var end = 'translate(' + (to.x - c.x) + 'px,' + (to.y - c.y) + 'px) scale(' + to.s + ')', start = 'translate(0px,0px) scale(1)';
    var keys = forward ? [{ transform: start, opacity: 1 }, { transform: end, opacity: 0 }] : [{ transform: end, opacity: 0 }, { transform: start, opacity: 1 }];
    return Promise.all(els.map(function (e) { var r = e.getBoundingClientRect(); return play(e, keys, ms, (c.x - r.left) + 'px ' + (c.y - r.top) + 'px'); }));
  }
  function chipPoint() { var r = chip.getBoundingClientRect(), w = app() ? app().getBoundingClientRect().width : innerWidth; return { x: r.left + r.width / 2, y: r.top + r.height / 2, s: Math.max(0.02, r.width / w) }; }
  // the green light: the layout changes at once and every piece is moved from where it was (position and size), so no layout is animated
  function flip(before) {
    var after = snap(), a = app(), out = [];
    function one(e, b, n, withScale) {
      var dx = b.left - n.left, dy = b.top - n.top, sx = withScale ? b.width / n.width : 1, sy = withScale ? b.height / n.height : 1;
      out.push(play(e, [{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')' }, { transform: 'translate(0px,0px) scale(1,1)' }], MS.full, '0 0'));
    }
    if (a) one(a, before.app, after.app, true);
    // full screen has no bar at all; coming back, the bar fades in at its place while the app shrinks under it
    if (!state.full) out.push(play(bar, [{ opacity: 0 }, { opacity: 1 }], MS.full));
    return Promise.all(out);
  }
  function snap() { var a = app(); return { app: a ? a.getBoundingClientRect() : bar.getBoundingClientRect(), bg: parts.bg.getBoundingClientRect(), lights: parts.lights.getBoundingClientRect(), title: parts.title.getBoundingClientRect() }; }

  // the one function: apply a patch to the state, paint it, and run the motion the change calls for
  function set(patch) {
    if (state.busy) return;
    var was = { full: state.full, view: state.view };
    var next = Object.assign({}, was, patch);
    if (next.full === was.full && next.view === was.view) return;
    state.busy = true;
    var leaving = was.view === 'open' && next.view !== 'open', entering = was.view !== 'open' && next.view === 'open';
    var motion;
    if (leaving) {
      // the window moves away first; the chip or the closed screen begins to appear with it, and the window is painted away when it has gone
      var toChip = next.view === 'min';
      Object.assign(state, next); paint();
      motion = collapse(toChip ? chipPoint() : Object.assign(win(), { s: 0.97 }), toChip ? MS.min : MS.close, true).then(function (anims) {
        state.hidden = true; paint(); done(anims);
      });
    } else if (entering) {
      var fromChip = was.view === 'min', pt = fromChip ? chipPoint() : Object.assign(win(), { s: 0.97 });
      Object.assign(state, next, { hidden: false }); paint();
      motion = collapse(pt, fromChip ? MS.min : MS.close, false).then(done);
    } else {
      var before = snap(); Object.assign(state, next); paint();
      motion = flip(before).then(done);
    }
    motion.then(function () { state.busy = false; }, function () { state.busy = false; });
  }

  bar.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'full') set({ full: !state.full }); else if (act === 'min') set({ view: 'min' }); else if (act === 'close') set({ view: 'closed' });
  });
  chip.addEventListener('click', function () { set({ view: 'open' }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.full && state.view === 'open') set({ full: false }); }); // Escape leaves full screen, as on a Mac
  paint();
  window.__thWindowState = state; // read-only handle for tests
})();
