// The one script the demo adds to the real webchat page. It renders no chat UI: it
//   1. runs the human check in the background (Turnstile) and, if it fails or times out, replaces the page with the textual one;
//   2. types the scripted opener into the real composer, at the cadence of the owner's own recorded keystrokes, and presses the real send button (the server answers it, see serve.mjs); it ends sent or on the textual page, never as a blank chat. On a first visit the typing is staged as the opening motion (intro.css): black, only the bar, zoomed, the caret fixed at the middle of the screen with the bar sliding under it, a beat, the send button pressed, then the app and the message fly back to their real places;
//   3. shows the gray-out overlay once the visitor's turns are used up and the last answer has finished;
//   4. lands on the static fallback page when the app never boots.
(() => {
  const FAIL_URL = '/_demo/text?why=check';
  // (window.__demo* are test switches: the scratch-instance test shortens the waits)
  const CHECK_TIMEOUT_MS = window.__demoCheckTimeoutMs || 60_000, BOOT_TIMEOUT_MS = 25_000, INTRO_DEADLINE_MS = window.__demoIntroDeadlineMs || 40_000;
  let st = null, failed = false, overlayShown = false, checkDeadline = null;

  const getState = async () => {
    try { const r = await fetch('/_demo/state', { credentials: 'same-origin', cache: 'no-store' }); if (r.status === 401) return { gone: true }; return r.ok ? await r.json() : null; } catch { return null; }
  };
  // The first state of a load. Where the visitor is on an intro chat (or on none), the server also plays the intro again when they have sent nothing
  // (idempotent, uncounted). The page's own head script starts this request while the page is still parsing (serve.mjs); a page the app served from
  // its cache has no such script and starts it here.
  const wantsIntro = () => { const c = new URLSearchParams(location.search).get('chat'); return !c || /^opener-/.test(c); };
  const bootState = () => window.__demoBoot || (window.__demoBoot = (async () => {
    if (!wantsIntro()) return getState();
    try { const r = await fetch('/_demo/intro', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }); if (r.status === 401) return { gone: true }; return r.ok ? await r.json() : null; } catch { return null; }
  })());
  const fail = (why) => { if (failed) return; failed = true; try { navigator.sendBeacon('/_demo/fail', new Blob([JSON.stringify({ why: 'gave-up:' + String(why).slice(0, 70) })], { type: 'application/json' })); } catch { /* best effort */ } try { sessionStorage.setItem('demo-fail', String(why || 'unknown')); } catch { /* storage off */ } location.replace(FAIL_URL); };

  // ---- 1. the human check, in the background ----
  // Not one hiccup sends a person away: a Cloudflare error, a failed verify or a blocked script is retried (twice), the clock only runs
  // while the tab is visible, and the reason is sent to the server before the page is replaced, so a failure can be diagnosed.
  const report = (why) => { try { navigator.sendBeacon('/_demo/fail', new Blob([JSON.stringify({ why: String(why).slice(0, 80), visible: document.visibilityState })], { type: 'application/json' })); } catch { /* best effort */ } };
  async function humanCheck() {
    if (st.verified) return;
    let tries = 0, widget = null, visibleMs = 0;
    const tick = setInterval(() => { if (document.visibilityState === 'visible') visibleMs += 1000; if (visibleMs >= CHECK_TIMEOUT_MS) { clearInterval(tick); report('timeout'); fail('timeout'); } }, 1000);
    checkDeadline = tick;
    const retry = (why) => {
      report('retry:' + why);
      if (++tries > 2) { clearInterval(tick); fail(why); return; }
      setTimeout(() => { try { widget != null ? window.turnstile.reset(widget) : start(); } catch { start(); } }, 800 * tries);
    };
    const done = async (token) => {
      const r = await fetch('/_demo/verify', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnstile: token || '' }) }).catch(() => null);
      if (r && r.ok) { clearInterval(tick); checkDeadline = null; st = await r.json(); update(); }
      else if (r && r.status === 503) { clearInterval(tick); checkDeadline = null; st.resting = true; update(); }
      else retry('verify-' + (r ? r.status : 'net'));
    };
    if (!st.siteKey) return done('');
    const host = document.createElement('div');
    host.id = 'demo-check'; host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000';
    document.body.appendChild(host);
    function start() {
      const render = () => {
        widget = window.turnstile.render(host, { sitekey: st.siteKey, appearance: 'interaction-only', callback: (t) => { host.remove(); done(t); },
          'error-callback': (e) => { retry('error-' + e); return true; },
          // Cloudflare asks for a click only when it doubts the browser: show it plainly, and give the visitor the whole bounded window
          'before-interactive-callback': () => { dropIntro(); host.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483000;background:var(--bg-raised,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);border-radius:10px;padding:8px 10px;font:12px var(--sans,system-ui);box-shadow:0 4px 20px #0003'; host.insertAdjacentText('afterbegin', 'one quick check that you are a person'); },
          'timeout-callback': () => window.turnstile.reset(widget) });
      };
      if (window.turnstile) return render();
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' + (tries ? '&retry=' + Date.now() : '');
      s.async = true; s.onerror = () => retry('script'); s.onload = render;
      document.head.appendChild(s);
    }
    start();
  }

  // ---- 2. the opener, typed into the real composer ----
  // Whatever the human check does (pass, fail, hang), the intro ends one of two ways: sent (the server has the visitor's message and streams the
  // first answer) or the failed-check page. It is never left as an empty chat: the composer being rebuilt under the typing (the app loads the
  // chat after the composer is up and resets its draft), a send button that stays disabled, a send that does not arrive: each is retried, and
  // when the intro is still not sent at INTRO_DEADLINE_MS the visitor is sent to the textual page. Only the visitor's own input (a trusted event
  // in the composer) ends the script's part: what they write is theirs.
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const composer = () => document.querySelector('[data-testid="composer"]');
  let visitorActed = false;
  for (const ev of ['keydown', 'beforeinput', 'paste', 'drop']) document.addEventListener(ev, (e) => { if (e.isTrusted && e.target && e.target.matches && e.target.matches('[data-testid="composer"]')) { visitorActed = true; dropIntro(); } }, true);
  // the visitor acting anywhere (a trusted key, click or touch) ends the opening motion at once and shows the normal app
  for (const ev of ['keydown', 'pointerdown', 'touchstart']) document.addEventListener(ev, (e) => { if (e.isTrusted) dropIntro(); }, true);

  // ---- the opening motion (intro.css holds the look; this holds the numbers) ----
  // One duration and one easing for everything that moves back: the app's scale and slide, the black, the bar's width, the message.
  const INTRO_MS = 900, INTRO_EASE = 'cubic-bezier(.55,0,.25,1)';
  const root = document.documentElement;
  let visual = null;
  const cleanupVisual = () => {
    const v = visual; if (!v) return; visual = null;
    clearTimeout(v.timer); clearTimeout(v.idle);
    root.classList.remove('demo-intro', 'demo-ready', 'demo-intro-out', 'demo-intro-in', 'demo-measure', 'demo-bare', 'demo-send');
    for (const k of ['ox', 'oy', 'dx', 'dy', 's', 'pl', 'ms', 'ease', 'delay', 'flight', 'in']) root.style.removeProperty('--di-' + k);
    v.caret.remove(); v.mirror.remove(); if (v.clone) v.clone.remove();
    if (v.bubble) v.bubble.style.visibility = '';
    window.removeEventListener('resize', v.onResize);
  };
  const dropIntro = () => { if (visual) cleanupVisual(); else { root.classList.remove('demo-intro', 'demo-bare', 'demo-send'); const c = document.getElementById('demo-caret'); if (c) c.remove(); } };
  /** Measures the real layout (the app untransformed) and sets the scale, the origin and the narrow bar. Idempotent: a resize measures again. */
  function layoutVisual(v) {
    const { field, bar, send, app, text } = v, cs = getComputedStyle(field);
    root.classList.add('demo-measure');
    root.style.removeProperty('--di-pl');
    const pad = (el, side) => parseFloat(getComputedStyle(el)['padding' + side]) || 0;
    const fieldPad = pad(field, 'Left') + (parseFloat(cs.borderLeftWidth) || 0);
    const real = field.getBoundingClientRect(), barRect = bar.getBoundingClientRect();
    v.mirror.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;white-space:pre;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};letter-spacing:${cs.letterSpacing}`;
    v.textW = v.width(text);
    // the field is just the text plus its padding, so the send button sits right after the end of the full line (the bar itself is invisible)
    const gap = send.getBoundingClientRect().left - real.right; // from the field's right edge to the send button
    const wantW = 1.6 * v.textW + fieldPad - gap; // the send button starts 1.6x the line's length from the line's left edge
    const extras = barRect.width - 2 * pad(bar, 'Left') - real.width; // attach button, send button and gaps
    root.style.setProperty('--di-pl', (barRect.width - (wantW + extras)) / 2 + 'px');
    const t = field.getBoundingClientRect(), sd = send.getBoundingClientRect(), ar = app.getBoundingClientRect();
    const vw = root.clientWidth, vh = window.innerHeight;
    v.cx = vw / 2; v.cy = vh / 2; // the typed line is centred on the screen and grows outward from the middle
    v.p0x = t.left + fieldPad; v.p0y = t.top + t.height / 2;
    // the zoom: the whole typed line spans about a third of the screen's width
    v.S = Math.min(3.6, Math.max(1.2, (vw * 0.3) / Math.max(1, v.textW)));
    v.lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    v.color = cs.color;
    root.style.setProperty('--di-s', String(v.S));
    root.style.setProperty('--di-ox', v.p0x - ar.left + 'px'); root.style.setProperty('--di-oy', v.p0y - ar.top + 'px');
    root.style.setProperty('--di-dy', v.cy - v.p0y + 'px');
    root.classList.remove('demo-measure');
    Object.assign(v.caret.style, { left: v.cx + 'px', top: v.cy + 'px', width: Math.max(2, v.S) + 'px', height: v.lineH * v.S * 0.85 + 'px', background: v.color });
    slideVisual(v, field.value);
  }
  /** The bar slides left by half the width of what is typed, so the typed line stays centred; the caret rides its end. */
  function slideVisual(v, typed) {
    const w = v.S * v.width(typed);
    v.dx = v.cx - v.p0x - w / 2;
    root.style.setProperty('--di-dx', v.dx + 'px');
    v.caret.style.left = v.cx + w / 2 + 'px';
  }
  function startVisual(text) {
    if (visual) return visual;
    if (!root.classList.contains('demo-intro')) return null;
    try {
      const field = composer(), bar = field && field.closest('.composer'), send = document.querySelector('[data-testid="send"]'), app = field && field.closest('.app');
      if (!field || !bar || !send || !app) return null;
      const mirror = document.createElement('span'), early = document.getElementById('demo-caret'), caret = early || document.createElement('div'); // the early script drew the caret at the first paint: keep it (moving it would restart its blink)
      caret.id = 'demo-caret'; if (!early) caret.className = 'idle'; root.classList.add('demo-bare'); // bare text on black from the first paint (the early script set it); only the send button comes in once typed
      document.body.append(mirror); if (!early) document.body.append(caret);
      const v = { field, bar, send, app, text, mirror, caret, width: (s) => { mirror.textContent = s; return mirror.getBoundingClientRect().width; }, timer: 0, idle: 0, clone: null, bubble: null };
      let rt = 0; v.onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (visual === v && !root.classList.contains('demo-intro-out')) layoutVisual(v); }, 120); };
      window.addEventListener('resize', v.onResize);
      visual = v;
      window.__demoIntroOwned = true; root.classList.add('demo-opener');
      layoutVisual(v);
      root.classList.add('demo-ready');
      return v;
    } catch (e) { cleanupVisual(); root.classList.remove('demo-intro', 'demo-bare', 'demo-send'); return null; }
  }
  /** One typed character: the text, then the bar's slide, in the same task (one paint). */
  const typedVisual = (typed) => {
    const v = visual; if (!v || root.classList.contains('demo-intro-out')) return;
    // the app rebuilds its composer when the chat finishes loading: measure the new one
    const f = composer();
    if (f && f !== v.field) { v.field = f; v.bar = f.closest('.composer') || v.bar; v.send = document.querySelector('[data-testid="send"]') || v.send; v.app = f.closest('.app') || v.app; layoutVisual(v); }
    slideVisual(v, typed); if (typed.length >= v.text.length - 7) root.classList.add('demo-send'); // the send button fades in over the last word, in the corner of the eye, riding the bar as the line slides
    v.caret.classList.remove('idle'); clearTimeout(v.idle); v.idle = setTimeout(() => v.caret.classList.add('idle'), 450);
  };
  /** The send button pressed in, visibly, a moment before the real click. */
  async function pressVisual(send) {
    send.style.transition = 'transform 110ms ease-out, filter 110ms ease-out';
    send.style.transform = 'scale(.8)'; send.style.filter = 'brightness(.88)';
    await pause(150);
  }
  const releaseVisual = (send) => { send.style.transition = 'transform 200ms ease-out, filter 200ms ease-out'; send.style.transform = ''; send.style.filter = ''; setTimeout(() => { send.style.transition = ''; }, 260); };
  /** The first user message in the transcript, as soon as the app draws it (or null after a moment). */
  const watchBubble = () => new Promise((res) => {
    const find = () => document.querySelector('[data-testid="user-text"]');
    const mo = new MutationObserver(() => { const b = find(); if (b) { mo.disconnect(); clearTimeout(to); res(b); } });
    const to = setTimeout(() => { mo.disconnect(); res(find()); }, 1500);
    mo.observe(document.body, { childList: true, subtree: true });
  });
  /**
   * The send-off, one continuous motion. The world stays black (a few stars drift down past it). The message is the hero, in its own colours
   * the whole way: a quick dip (anticipation), then up along a gentle curve bowing toward the middle of the screen, slow to start, fast, long
   * slowing, one small overshoot and settle in its place. Meanwhile the bar fades to half and slides down to its place and width. When the
   * message has landed the interface comes in (`demo-intro-in`: the black, the bar's fade and the window frame go away).
   */
  const FLIGHT_MS = 1000, DIP_MS = 120, IN_MS = 320, LAND_AT = 0.78; // LAND_AT: the share of the climb after which it has reached its place and only the bounce is left
  const bezier = (x1, y1, x2, y2) => (t) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    let a = t;
    for (let i = 0; i < 8; i++) { const x = ((ax * a + bx) * a + cx) * a - t, d = (3 * ax * a + 2 * bx) * a + cx; if (Math.abs(x) < 1e-5) break; a -= x / (d || 1); }
    return ((ay * a + by) * a + cy) * a;
  };
  const flightEase = bezier(.55, 0, .25, 1); // the same curve as INTRO_EASE: the bar and the message arrive together
  /** The message's path as one keyframe per ~16 ms: top-left corner and scale, so the curve, the dip and the settle are plain arithmetic. */
  function flightFrames(P0, P1, S, vw) {
    const travel = Math.hypot(P1.x - P0.x, P1.y - P0.y), bow = Math.min(vw * 0.1, 90) * Math.min(1, travel / 400);
    const dip = Math.min(16, Math.max(8, S * 3)), over = Math.min(26, Math.max(10, travel * 0.045)), n = Math.round(FLIGHT_MS / 16), frames = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n * FLIGHT_MS;
      let x, y, sc;
      if (t < DIP_MS) { // anticipation: down and a touch smaller
        const k = Math.sin(Math.PI / 2 * (t / DIP_MS)); x = P0.x; y = P0.y + dip * k; sc = S * (1 - 0.03 * k);
      } else {
        const u = (t - DIP_MS) / (FLIGHT_MS - DIP_MS), p = flightEase(Math.min(1, u / LAND_AT)), rest = 1 - p;
        x = P0.x + (P1.x - P0.x) * p - bow * Math.sin(Math.PI * p); // the bow leans toward the middle (left), then it swings into its place
        y = P0.y + (P1.y - P0.y) * p + dip * rest * rest;
        sc = S + (1 - S) * p;
        const w = Math.max(0, (u - LAND_AT) / (1 - LAND_AT)); // the landing: one overshoot past its place (up) and a small swell, settling to rest
        if (w > 0) { const b = Math.sin(Math.PI * w) * (1 - 0.3 * w); y -= over * b; sc *= 1 + 0.05 * b; }
      }
      frames.push({ transform: `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${sc.toFixed(4)})`, offset: i / n });
    }
    return frames;
  }
  function exitVisual(bubble) {
    const v = visual; if (!v) return;
    const S = v.S;
    root.style.setProperty('--di-flight', FLIGHT_MS + 'ms'); root.style.setProperty('--di-in', IN_MS + 'ms');
    root.style.setProperty('--di-delay', DIP_MS + 'ms'); root.style.setProperty('--di-ms', FLIGHT_MS - DIP_MS + 'ms'); root.style.setProperty('--di-ease', INTRO_EASE);
    let landing = null;
    if (bubble) {
      // where the bubble will rest once the app is back (its layout box: undo the app's current transform), and where it starts (the typed text, on the bar)
      const br = bubble.getBoundingClientRect(), hadQueued = bubble.classList.contains('queued');
      bubble.classList.remove('queued'); // its colours as they will be, not as the pending message is drawn
      const bs = getComputedStyle(bubble), st0 = {};
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'borderTopWidth', 'borderTopColor', 'boxShadow', 'whiteSpace', 'overflowWrap', 'textAlign', 'backgroundColor', 'color']) st0[k] = bs[k];
      if (hadQueued) bubble.classList.add('queued');
      const pageBg = getComputedStyle(root).getPropertyValue('--bg').trim() || '#fff'; // the bubble is a tint over the page: on black it must stay the colour it is on the page
      const fx = v.p0x + (br.left - v.p0x - v.dx) / S, fy = v.p0y + (br.top - v.p0y - (v.cy - v.p0y)) / S, fw = br.width / S, fh = br.height / S;
      const clone = document.createElement('div');
      clone.textContent = bubble.textContent;
      Object.assign(clone.style, st0, { opacity: '1', borderStyle: 'solid', borderWidth: st0.borderTopWidth, borderColor: st0.borderTopColor, backgroundColor: 'transparent', backgroundImage: `linear-gradient(${st0.backgroundColor},${st0.backgroundColor}), linear-gradient(${pageBg},${pageBg})`, position: 'fixed', left: '0', top: '0', margin: '0', boxSizing: 'border-box', width: fw + 'px', height: fh + 'px', zIndex: '2147482500', pointerEvents: 'none', transformOrigin: '0 0', willChange: 'transform' });
      const x0 = v.cx - v.textW * S - (parseFloat(st0.paddingLeft) || 0) * S, y0 = v.cy - fh * S / 2;
      document.body.append(clone);
      const frames = flightFrames({ x: x0, y: y0 }, { x: fx, y: fy }, S, root.clientWidth);
      const fly = clone.animate(frames, { duration: FLIGHT_MS, easing: 'linear', fill: 'both' });
      // the bubble takes its colours in the dip and keeps them: full colour, the one thing in view
      clone.animate([{ opacity: 0.0, color: v.color }, { opacity: 1, color: st0.color }], { duration: DIP_MS, easing: 'linear', fill: 'both' });
      bubble.style.visibility = 'hidden'; v.bubble = bubble; v.clone = clone;
      landing = fly.finished.then(() => land(v), () => land(v));
    }
    v.caret.classList.remove('idle'); v.caret.classList.add('gone');
    root.classList.add('demo-intro-out'); root.classList.remove('demo-intro');
    if (!landing) v.timer = setTimeout(() => land(v), FLIGHT_MS);
    else v.timer = setTimeout(() => land(v), FLIGHT_MS + 400); // never later than this, whatever the animation does
  }
  /** The message is in its place: the interface comes in around it. */
  function land(v) {
    if (visual !== v || root.classList.contains('demo-intro-in')) return;
    clearTimeout(v.timer);
    if (v.bubble) v.bubble.style.visibility = '';
    // the flying copy stays on top, whole, until the black has gone (cleanupVisual removes it): the real bubble comes up under it as the interface fades in
    root.classList.add('demo-intro-in'); root.classList.remove('demo-bare', 'demo-send');
    v.timer = setTimeout(cleanupVisual, IN_MS + 120);
  }
  async function introFlow() {
    const t0 = Date.now(), text = st.openerText + ' '; // typed with a trailing space, as he types; the server trims it
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const put = (f, v) => { setter.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
    let sends = 0;
    while (!failed && !visitorActed) {
      if (Date.now() - t0 > INTRO_DEADLINE_MS) return fail('intro-stalled');
      // the server's state decides whether the intro is still owed (another tab, or the visitor, may have sent it) and which chat it belongs in
      const cur = await getState();
      if (!cur) { await pause(500); continue; }
      if (cur.gone) return dropIntro();
      st = cur;
      if (!st.intro) return dropIntro();
      if (new URLSearchParams(location.search).get('chat') !== st.opener) return location.replace('/?chat=' + encodeURIComponent(st.opener));
      // our message is already in the chat (a slow or reconnecting connection is still delivering it): wait for the server, never type and send it again
      if (sends > 0 && [...document.querySelectorAll('[data-testid="user-text"]')].some((e) => e.textContent.trim() === text.trim())) { await pause(500); continue; }
      let field = composer();
      if (!field) { await pause(100); continue; }
      if (field.value && field.value !== text && !text.startsWith(field.value)) return; // a draft that is not ours: leave it to the visitor
      if (field.value !== text) {
        const v = startVisual(text);
        // the opening: the bar alone on black for a beat, then the typing, replaying the recorded gaps (no randomness) against one clock so they do not drift
        await pause(v ? Math.max(0, 700 - (performance.now() - (window.__demoCaretAt || performance.now()))) : 250); // one 700 ms blink from the first paint before the first key (it overlaps the app's boot)
        let typed = field.value;
        const gaps = Array.isArray(st.openerGaps) && st.openerGaps.length === text.length - 1 ? st.openerGaps.concat(150) : Array.from(text, () => 60);
        let due = performance.now();
        for (const ch of text.slice(typed.length)) {
          field = composer();
          due += gaps[typed.length] * 0.6; // his recorded cadence, at 0.6x: the whole intro stays under 3 s
          const wait = due - performance.now(); if (wait > 0) await pause(wait);
          if (!field || visitorActed || failed || field.value !== typed) break;
          typed += ch; put(field, typed); typedVisual(typed);
        }
        field = composer();
        if (visitorActed || failed) return;
        if (!field || field.value !== text) { await pause(400); continue; } // the app reset the composer under the typing: type again
      }
      root.classList.add('demo-send');
      await pause(visual ? 420 : 300); // a beat before the click; the caret goes off as the button is pressed
      const send = document.querySelector('[data-testid="send"]');
      if (!send || send.disabled) { await pause(500); continue; }
      if (sends >= 3) return fail('intro-unsent');
      if (visual) await pressVisual(send);
      if (visitorActed || failed) return;
      const bubbleWatch = visual && !root.classList.contains('demo-intro-out') ? watchBubble() : null;
      send.click(); sends++;
      if (bubbleWatch) { const b = await bubbleWatch; if (visual) exitVisual(b); }
      if (visual || send.style.transform) releaseVisual(send);
      for (let i = 0; i < 16 && !failed && !visitorActed; i++) { // the intro is sent once the server holds the message
        await pause(500);
        const s = await getState();
        if (s && !s.gone && !s.intro) { st = s; update(); return; }
      }
    }
  }

  // ---- 3. the gray-out ----
  function overlay() {
    if (overlayShown) return; overlayShown = true;
    const o = document.createElement('div');
    o.id = 'demo-limit';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--bg,#fff) 60%,transparent);backdrop-filter:grayscale(1) blur(1px);-webkit-backdrop-filter:grayscale(1) blur(1px);font-family:var(--sans,system-ui)';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:min(560px,100%);max-height:92%;overflow:auto;background:var(--bg-raised,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);border-radius:12px;padding:16px 18px;box-shadow:0 6px 30px #0003';
    const head = document.createElement('div');
    head.style.cssText = 'font:600 17px/1.4 var(--sans,system-ui)';
    head.textContent = st.resting && st.turns < st.cap ? 'the demo is resting for today; you can still run it yourself' : "ok, that's the demo. try downloading it";
    card.append(head); o.append(card); document.body.append(o);
  }

  // ---- state: after every turn and on a slow poll ----
  function update() {
    if (!st) return;
    if (st.verified && checkDeadline) { clearInterval(checkDeadline); checkDeadline = null; const h = document.getElementById('demo-check'); if (h) h.remove(); }
    // the opener's answer has finished: its pending-state rules (intro.css) end
    // (the page's own view, not only the server's: a pending label stays hidden until the activity line has left its queued and starting phases)
    const phase = (document.querySelector('[data-testid="activity"]') || {}).dataset?.phase;
    if (!st.intro && !st.running && !visual && st.turns === 0 && phase !== 'queued' && phase !== 'starting') root.classList.remove('demo-opener');
    if (st.turns >= st.cap && !st.running) overlay();
    else if (st.resting && !st.running && st.turns >= 1) overlay();
  }
  async function refresh() { const s = await getState(); if (s && !s.gone) { st = s; update(); } else if (s && s.gone) { fetch('/_demo/session', { method: 'POST', credentials: 'same-origin' }).then(() => location.reload()).catch(() => {}); } }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await nativeFetch(...a);
    try { const url = String(a[0] && a[0].url || a[0]); if (url.includes('/api/actions') && (r.headers.has('x-demo-turns') || r.status === 429 || r.status === 503)) setTimeout(refresh, r.status === 429 ? 0 : 1500); } catch { /* never break the app */ }
    return r;
  };

  // The human check is not on the way to the first sight of the app: it starts once the composer is up (the page's script and the app's boot are
  // not competing with Cloudflare's), or after 4 s whatever happens.
  // A message to a starter chat continues in the visitor's own fork of it (serve.mjs rewrites the send); the page follows it there: on a send in a
  // starter chat, open the fork's row once the sidebar has it (st.forks names it ahead of time), the way a click on that row would.
  function followForks() {
    let want = null;
    const here = () => new URLSearchParams(location.search).get('chat');
    const arm = () => { const f = st && st.forks && st.forks[here()]; if (f) want = { id: f, until: Date.now() + 20_000 }; };
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target && e.target.closest && e.target.closest('[data-testid="composer"]') && String(e.target.value || '').trim()) arm(); }, true);
    document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('[data-testid="send"]')) arm(); }, true);
    setInterval(() => {
      if (!want) return;
      if (Date.now() > want.until || here() === want.id) { want = null; return; }
      const row = document.querySelector(`[data-testid="chat-row"][data-chat="${CSS.escape(want.id)}"]`);
      if (row) { want = null; setTimeout(() => row.click(), 150); }
    }, 200);
  }
  const whenBooted = (fn) => { let n = 0; const t = setInterval(() => { if (document.querySelector('[data-testid="composer"]') || ++n > 80) { clearInterval(t); setTimeout(fn, 300); } }, 50); };
  const newSession = async (fresh) => {
    const r = await fetch('/_demo/session' + (fresh ? '?fresh=1' : ''), { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (r && r.ok) { const n = await r.json(); return location.replace('/?chat=' + encodeURIComponent(n.opener)); }
    return fail('no-session-' + (r ? r.status : 'net'));
  };

  (async () => {
    // `?fresh=1` is a brand-new guest (new cookie, new starting chats); the server does this for a page it serves, this is for one the app served from its cache
    if (new URLSearchParams(location.search).get('fresh') === '1') return newSession(true);
    st = await bootState();
    // no session (the page came from the app's cache after the cookie expired): ask for one, then load the app again with it
    if (st && st.gone) return newSession(false);
    if (!st) return fail('state-unreachable');
    if (!st.intro) dropIntro(); else root.classList.add('demo-opener'); // the opener never shows a pending label, motion or not
    // a page of the app's own cache can name an intro chat that has since been played and replaced, or none at all: go to the live one
    const here = new URLSearchParams(location.search).get('chat');
    if (st.intro && wantsIntro() && here !== st.opener) return location.replace('/?chat=' + encodeURIComponent(st.opener));
    whenBooted(humanCheck);
    followForks();
    introFlow();
    update();
    setInterval(refresh, 2500);
    // the app never came up: land on the static page
    setTimeout(() => { if (!document.querySelector('[data-testid="composer"]') && !document.querySelector('[data-testid="sidebar"]') && !failed) location.replace('/_fallback'); }, BOOT_TIMEOUT_MS);
  })();
})();
