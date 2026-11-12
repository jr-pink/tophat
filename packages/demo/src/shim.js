// The one script the demo adds to the real webchat page. It renders no chat UI: it
//   1. runs the human check in the background (Turnstile) and, if it fails or times out, replaces the page with the textual one;
//   2. plays the opening motion on its own overlay (typed at the cadence of the owner's own recorded keystrokes) while, independently, it sends the scripted opener through the real composer and send button (the server answers it, see serve.mjs); it ends sent or on the textual page, never as a blank chat. On a first visit the typing is staged as the opening motion (intro.css): black, only the bar, zoomed, the caret fixed at the middle of the screen with the bar sliding under it, a beat, the send button pressed, then the app and the message fly back to their real places;
//   3. (no end screen: once the turns are used up the server answers with a fixed reply, serve.mjs LIMIT_ANSWER);
//   4. lands on the static fallback page when the app never boots.
(() => {
  const FAIL_URL = '/_demo/text?why=check';
  // (window.__demo* are test switches: the scratch-instance test shortens the waits)
  const CHECK_TIMEOUT_MS = window.__demoCheckTimeoutMs || 60_000, BOOT_TIMEOUT_MS = 25_000, INTRO_DEADLINE_MS = window.__demoIntroDeadlineMs || 40_000;
  let st = null, failed = false, checkDeadline = null;

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
  const fail = (why) => { if (failed || window.__demoBounce) return; // a reload on another chat is on its way to the opener (guest-reset.js): its aborted requests are not a failed check
     failed = true; try { navigator.sendBeacon('/_demo/fail', new Blob([JSON.stringify({ why: 'gave-up:' + String(why).slice(0, 70) })], { type: 'application/json' })); } catch { /* best effort */ } try { sessionStorage.setItem('demo-fail', String(why || 'unknown')); } catch { /* storage off */ } location.replace(FAIL_URL); };

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
  for (const ev of ['keydown', 'beforeinput', 'paste', 'drop']) document.addEventListener(ev, (e) => { if (!TUNE_ON && e.isTrusted && e.target && e.target.matches && e.target.matches('[data-testid="composer"]')) { visitorActed = true; dropIntro(); } }, true);
  // the visitor acting anywhere (a trusted key, click or touch) ends the opening motion at once and shows the normal app
  for (const ev of ['keydown', 'pointerdown', 'touchstart']) document.addEventListener(ev, (e) => { if (!TUNE_ON && e.isTrusted && !(e.target && e.target.closest && e.target.closest('#demo-tuner'))) dropIntro(); }, true);

  // ---- the opening motion: one self-contained animation on its own overlay (intro.css), independent of the app ----
  // The page's first script draws the overlay (black, a centred line, a blinking caret) at the first paint. The typing, the send button, the
  // flight and the reveal all happen on that overlay with compositor animations (transform and opacity only), so a busy main thread while the
  // app boots underneath cannot freeze or skip them. Nothing here measures, styles or waits for the app; the opener is sent to the app
  // separately (sendOpener). The only link: if the app has drawn the message by the time it flies, the flight lands exactly on it.
  const root = document.documentElement;
  // The intro's beats after the last typed character, in ms (one table: change a number, reload): a short beat, the press, and the flight leaves
  // from the bottom of the press; the answer appears the moment the message lands (landAt in playVisual).
  // Every timing and position of the intro, in one table. tophat.md/?tune=1 opens a panel over the page that edits these (kept in
  // sessionStorage 'demo-tune', which the per-load wipe leaves alone), replays, scrubs and copies them; the defaults below are the shipped values.
  const TUNE_DEFAULTS = {
    speed: 1,            // global time scale: 0.25 is 4x slow motion
    typing: 0.6,         // multiplier on his recorded keystroke gaps
    beat: 450,           // ms from the last letter to the press
    press: 220,          // press duration, ms
    pressDown: 0.45,     // fraction of the press at its deepest point; the flight leaves there
    pressScale: 0.8,     // button scale at the bottom of the press
    sendDist: 2,         // button distance from the text's left anchor, in full-line widths
    sendSize: 1.1,       // button diameter, em
    sendFadeStart: 0.75, // the button starts fading in this far through the typing (0 = first letter, 1 = last letter)
    sendFade: 1600,      // its fade, ms
    lineSize: 4.2,       // typed line font size, vw (clamped 24..48 px)
    lineY: 50,           // typed line vertical position, % of the screen
    flight: 1000,        // ms
    dip: 120,            // ms of the downward dip before the flight
    dipPx: 12,           // px
    landAt: 0.78,        // fraction of the flight at which it reaches its place (then overshoots and settles)
    overshoot: 26,       // max px of the overshoot
    bow: 90,             // max px the path bows toward the middle
    targetRight: 28,     // landing spot when the real message is not drawn yet: px from the right edge
    targetTop: 72,       // and px from the top
    fadeIn: 450,         // black and stars fade as it lands, ms
    answerDelay: 0,      // ms after landing that the answer appears
    answerIn: 380,       // answer rise, ms
    answerRise: 6,       // px
  };
  const TUNE = (() => { try { return { ...TUNE_DEFAULTS, ...JSON.parse(sessionStorage.getItem('demo-tune') || '{}') }; } catch { return { ...TUNE_DEFAULTS }; } })();
  const sp = (ms) => ms / (TUNE.speed || 1);
  let BEAT_MS, PRESS_MS, PRESS_DOWN, ANSWER_IN_MS, FLIGHT_MS, DIP_MS, LAND_AT, IN_MS;
  const retune = (t) => { Object.assign(TUNE, t || {}); BEAT_MS = sp(TUNE.beat); PRESS_MS = sp(TUNE.press); PRESS_DOWN = TUNE.pressDown; ANSWER_IN_MS = sp(TUNE.answerIn);
    FLIGHT_MS = sp(TUNE.flight); DIP_MS = sp(TUNE.dip); LAND_AT = TUNE.landAt; IN_MS = sp(TUNE.fadeIn); };
  retune();
  // tune mode (tophat.md/#tune): the intro alone on a bare stage, no app, no send, nothing that ends it early; replays in place
  const TUNE_ON = (() => { try { if (/(^|[#&])tune\b/.test(location.hash)) sessionStorage.setItem('demo-tune-on', '1'); return sessionStorage.getItem('demo-tune-on') === '1'; } catch { return false; } })();
  if (TUNE_ON && !('hold' in TUNE)) TUNE.hold = true;
  const OVERLAY_HTML = '<div class="bg"></div><div class="stars"></div><div class="line"><span class="msg"></span><i class="caret idle"></i><b class="send"></b></div>';
  let visual = null; // the overlay, while the intro is playing on it
  const diag = (why) => { try { navigator.sendBeacon('/_demo/fail', new Blob([JSON.stringify({ why: 'diag:' + why })], { type: 'application/json' })); } catch {} };
  const overlayEl = () => {
    let o = document.getElementById('demo-intro');
    if (!o) { o = document.createElement('div'); o.id = 'demo-intro'; o.innerHTML = OVERLAY_HTML; root.appendChild(o); }
    return o;
  };
  const cleanupVisual = () => {
    const v = visual; visual = null; if (v) clearTimeout(v.timer);
    document.getElementById('demo-intro')?.remove();
    root.classList.remove('demo-intro', 'demo-intro-out', 'demo-bare', 'demo-send', 'demo-landed'); root.classList.add('demo-zoomed'); unzoom();
  };
  // the visitor acting anywhere ends the motion at once: the overlay fades out over the app as it is
  const dropIntro = () => {
    const o = document.getElementById('demo-intro');
    if (!o || o.dataset.dropping) { if (!o) cleanupVisual(); return; }
    o.dataset.dropping = '1'; o.style.pointerEvents = 'none';
    o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' }).finished.then(cleanupVisual, cleanupVisual);
  };
  function startVisual() {
    if (!root.classList.contains('demo-intro')) return null;
    const o = overlayEl();
    window.__demoIntroOwned = true;
    visual = { o, msg: o.querySelector('.msg'), caret: o.querySelector('.caret'), send: o.querySelector('.send'), line: o.querySelector('.line'), timer: 0, idle: 0 };
    return visual;
  }
  const typedVisual = (v, typed, total) => {
    v.msg.textContent = typed;
    // the button is part of the line, already there at the end of the full text; the typed text slides left under the fixed caret and the caret runs into it
    if (v.full == null) { const probe = v.msg.cloneNode(); probe.textContent = total; v.msg.parentNode.appendChild(probe); probe.style.visibility = 'hidden'; v.full = probe.getBoundingClientRect().width; probe.remove(); }
    // an invisible textbox behind the line: the button sits at a fixed distance from the text's LEFT anchor (twice the full line's width), so it moves left exactly as the text grows and the caret only meets it at the end
    v.send.style.left = (2 * v.full - v.msg.getBoundingClientRect().width) + 'px';
    if (typed.length >= total.length - 5) v.send.classList.add('on'); // a slow fade over the last words
    v.caret.classList.remove('idle'); clearTimeout(v.idle); v.idle = setTimeout(() => v.caret.classList.add('idle'), 250);
  };
  const bezier = (x1, y1, x2, y2) => (t) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    let a = t;
    for (let i = 0; i < 8; i++) { const x = ((ax * a + bx) * a + cx) * a - t, d = (3 * ax * a + 2 * bx) * a + cx; if (Math.abs(x) < 1e-5) break; a -= x / (d || 1); }
    return ((ay * a + by) * a + cy) * a;
  };
  const flightEase = bezier(.55, 0, .25, 1);
  /** The message's path, one keyframe per ~16 ms (translate of its top-left corner and scale): a dip, a curve bowing toward the middle, one overshoot and settle. */
  function flightFrames(P0, P1, k, vw) {
    const travel = Math.hypot(P1.x - P0.x, P1.y - P0.y), bow = Math.min(vw * 0.1, TUNE.bow) * Math.min(1, travel / 400);
    const dip = TUNE.dipPx, over = Math.min(TUNE.overshoot, Math.max(10, travel * 0.045)), n = Math.round(FLIGHT_MS / 16), frames = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n * FLIGHT_MS;
      let x, y, sc;
      if (t < DIP_MS) { const q = Math.sin(Math.PI / 2 * (t / DIP_MS)); x = P0.x; y = P0.y + dip * q; sc = 1 - 0.03 * q; }
      else {
        const u = (t - DIP_MS) / (FLIGHT_MS - DIP_MS), p = flightEase(Math.min(1, u / LAND_AT)), rest = 1 - p;
        x = P0.x + (P1.x - P0.x) * p - bow * Math.sin(Math.PI * p);
        y = P0.y + (P1.y - P0.y) * p + dip * rest * rest;
        sc = 1 + (k - 1) * p;
        const w = Math.max(0, (u - LAND_AT) / (1 - LAND_AT));
        if (w > 0) { const b = Math.sin(Math.PI * w) * (1 - 0.3 * w); y -= over * b; sc *= 1 + 0.05 * b; }
      }
      frames.push({ transform: `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${sc.toFixed(4)})`, offset: i / n });
    }
    return frames;
  }
  /** The whole visible intro, scheduled once on the compositor at its start: the typing (each character a step of a transform, at his recorded
   *  cadence), the send button tracking the text and fading in, the press, the flight, the stars and the black fading as it lands. Nothing after
   *  this call waits on a timer for its timing, so the app booting underneath (a busy main thread) cannot delay or stutter any beat; the timers
   *  left only swap classes or clean up. */
  async function playVisual(v, text) {
    await pause(Math.max(0, 700 - (performance.now() - (window.__demoCaretAt || performance.now()))));
    if (visual !== v || visitorActed || failed) return;
    const o = v.o, vw = root.clientWidth, n = text.length;
    const gaps = Array.isArray(st.openerGaps) && st.openerGaps.length === n - 1 ? st.openerGaps.concat(150) : Array.from(text, () => 60);
    // the typed line: the full text laid out once inside a window that ends at the caret; each step slides it left by one character's width
    v.line.style.fontSize = `clamp(24px, ${TUNE.lineSize}vw, 48px)`; v.line.style.top = TUNE.lineY + '%';
    v.msg.textContent = text;
    const node = v.msg.firstChild, range = document.createRange(), widths = [0];
    for (let i = 1; i <= n; i++) { range.setStart(node, 0); range.setEnd(node, i); widths.push(range.getBoundingClientRect().width); }
    const full = widths[n];
    const win = document.createElement('span'); win.className = 'win';
    v.msg.parentNode.insertBefore(win, v.msg); win.appendChild(v.msg);
    Object.assign(v.msg.style, { position: 'relative', right: 'auto', top: '0', marginTop: '0' });
    Object.assign(win.style, { position: 'absolute', right: '0', top: '50%', marginTop: '-0.82em', overflow: 'hidden', width: v.msg.offsetWidth + 'px', height: v.msg.offsetHeight + 'px' });
    const times = [0]; let t = 0;
    for (let i = 1; i <= n; i++) { t += sp(gaps[i - 1] * TUNE.typing); times.push(t); }
    const typeEnd = times[n];
    const steps = (fn) => { const k = [{ transform: fn(0), offset: 0, easing: 'steps(1, end)' }]; for (let i = 1; i <= n; i++) k.push({ transform: fn(i), offset: Math.min(1, times[i] / typeEnd), easing: 'steps(1, end)' }); return k; };
    v.msg.animate(steps((i) => `translateX(${(full - widths[i]).toFixed(2)}px)`), { duration: typeEnd, fill: 'both' });
    // the send button sits twice the line's width from the text's left anchor, so it moves left exactly as the text grows; it fades in over the last words
    v.send.style.left = (TUNE.sendDist * full) + 'px'; v.send.style.width = v.send.style.height = TUNE.sendSize + 'em'; v.send.style.transition = 'none';
    v.send.animate(steps((i) => `translateX(${(-widths[i]).toFixed(2)}px)`), { duration: typeEnd, fill: 'both' });
    v.send.animate([{ opacity: 0 }, { opacity: 1 }], { delay: typeEnd * Math.min(1, Math.max(0, TUNE.sendFadeStart)), duration: sp(TUNE.sendFade), easing: 'ease-in', fill: 'both' });
    // the caret is solid while typing and blinks once the typing stops
    v.caret.classList.remove('idle');
    v.caret.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0, offset: .56 }, { opacity: 0 }], { delay: typeEnd + sp(250), duration: sp(700), iterations: Infinity });
    // a beat, the press, and the flight leaves from the bottom of the press
    const pressAt = typeEnd + BEAT_MS, flightAt = pressAt + PRESS_MS * PRESS_DOWN;
    v.send.animate([{ transform: `translateX(${-full}px) scale(1)` }, { transform: `translateX(${-full}px) scale(${TUNE.pressScale})`, offset: PRESS_DOWN }, { transform: `translateX(${-full}px) scale(1)` }], { delay: pressAt, duration: PRESS_MS, easing: 'ease-out', composite: 'replace' });
    // the flying bubble: a copy of the typed words in the user bubble's look, from exactly where the words end up, to where the message will sit
    const mcs = getComputedStyle(v.msg), fs = parseFloat(mcs.fontSize) || 40, wr = win.getBoundingClientRect();
    const r = { left: wr.right - v.msg.offsetWidth, top: wr.top, width: v.msg.offsetWidth, height: wr.height };
    const real = [...document.querySelectorAll('[data-testid="user-text"]')].find((e) => e.textContent.trim() === text.trim());
    let br = real && real.getBoundingClientRect();
    const rfs = real ? parseFloat(getComputedStyle(real).fontSize) || 14.5 : 14.5, k = rfs / fs;
    if (!br || !(br.width > 0) || br.bottom < 0 || br.top > innerHeight) br = null;
    const padY = 9 / k, padX = 13 / k; // Message.svelte's bubble padding at the line's size
    const w = br ? br.width / k : r.width + 2 * padX, h = br ? br.height / k : r.height * 0.82 + 2 * padY;
    const P0 = { x: r.left - padX - (1 / k - 1), y: r.top + r.height / 2 - h / 2 }, P1 = br ? { x: br.left, y: br.top } : { x: root.clientWidth - TUNE.targetRight - w * k, y: TUNE.targetTop };
    const fly = document.createElement('span'); fly.className = 'msg bubble'; fly.textContent = text;
    Object.assign(fly.style, { fontFamily: mcs.fontFamily, fontSize: mcs.fontSize, fontWeight: mcs.fontWeight, fontStyle: mcs.fontStyle, letterSpacing: mcs.letterSpacing, position: 'fixed', left: '0', top: '0', right: 'auto', margin: '0', boxSizing: 'border-box', width: w + 'px', height: h + 'px', padding: `${padY}px ${padX}px`, borderRadius: `${14 / k}px ${14 / k}px ${4 / k}px ${14 / k}px`, borderWidth: 1 / k + 'px', lineHeight: (h - 2 * padY) + 'px', transformOrigin: '0 0', transform: `translate(${P0.x}px,${P0.y}px)`, opacity: '0' });
    o.appendChild(fly);
    const at = (el, keys, opts) => el.animate(keys, { fill: 'both', ...opts });
    at(fly, flightFrames(P0, P1, k, vw), { delay: flightAt, duration: FLIGHT_MS, easing: 'linear' });
    at(fly, [{ opacity: 0 }, { opacity: 1 }], { delay: flightAt, duration: 1 });
    at(v.msg, [{ opacity: 1 }, { opacity: 0 }], { delay: flightAt, duration: 1, composite: 'replace' });
    at(v.caret, [{ opacity: 0 }, { opacity: 0 }], { delay: flightAt, duration: 1 });
    v.line.animate([{ opacity: 1, transform: 'translateY(-50%)' }, { opacity: 0, transform: 'translateY(calc(-50% + 40px))' }], { delay: flightAt, duration: 300, easing: 'ease-in', fill: 'forwards' });
    o.querySelector('.stars').animate([{ opacity: 0, transform: 'translate3d(0,0,0)' }, { opacity: 1, offset: .18 }, { opacity: 1, transform: 'translate3d(0,400px,0)' }], { delay: flightAt, duration: FLIGHT_MS, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'forwards' });
    const landAt = flightAt + DIP_MS + (FLIGHT_MS - DIP_MS) * LAND_AT;
    for (const el of [o.querySelector('.bg'), o.querySelector('.stars')]) el.animate([{ opacity: 1 }, { opacity: 0 }], { delay: landAt, duration: IN_MS, easing: 'ease-out', fill: 'forwards', composite: 'replace' });
    const handover = fly.animate([{ opacity: 1 }, { opacity: 0 }], { delay: flightAt + FLIGHT_MS + IN_MS - 150, duration: 200, easing: 'linear', fill: 'forwards' });
    // class swaps only (no timing rides on these): the page under the overlay is the app's own again once the flight leaves
    setTimeout(() => { if (visual !== v) return; root.classList.add('demo-intro-out'); root.classList.remove('demo-intro'); o.classList.add('out'); o.style.pointerEvents = 'none'; }, flightAt);
    // the answer is held hidden (intro.css, html:not(.demo-landed)) until the message lands, then rises in
    setTimeout(() => {
      root.classList.add('demo-landed');
      for (const el of document.querySelectorAll('main [data-role="assistant"]')) el.animate([{ opacity: 0, transform: `translateY(${TUNE.answerRise}px)` }, { opacity: 1, transform: 'none' }], { duration: ANSWER_IN_MS, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }, landAt + sp(TUNE.answerDelay));
    // the end keyframe lands on the real message: if the app drew it somewhere other than where we aimed, glide the last pixels onto it before the hand-over
    setTimeout(() => {
      const re = [...document.querySelectorAll('[data-testid="user-text"]')].find((e) => e.textContent.trim() === text.trim()), b = re && re.getBoundingClientRect();
      if (!b || !(b.width > 0) || b.bottom < 0 || b.top > innerHeight || (Math.abs(b.left - P1.x) < 1 && Math.abs(b.top - P1.y) < 1 && Math.abs(b.width - w * k) < 1)) return;
      fly.animate([{ transform: `translate(${P1.x}px,${P1.y}px) scale(${k})` }, { transform: `translate(${b.left}px,${b.top}px) scale(${b.width / w})` }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    }, flightAt + FLIGHT_MS);
    window.__demoIntroTotal = flightAt + FLIGHT_MS + IN_MS + 50; // the tuner's scrub range
    if (TUNE.hold) return; // the tuner's "hold": the overlay stays on its last frame so it can be scrubbed
    handover.finished.then(cleanupVisual, cleanupVisual);
    v.timer = setTimeout(cleanupVisual, flightAt + FLIGHT_MS + IN_MS + 1500); // a backstop only
  }
  /** The opener into the real app, with no visuals: put the text in the composer and press send, retried until the server holds it. */
  async function sendOpener(text) {
    const t0 = Date.now();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const put = (f, val) => { setter.call(f, val); f.dispatchEvent(new Event('input', { bubbles: true })); };
    let sends = 0;
    while (!failed && !visitorActed) {
      if (Date.now() - t0 > INTRO_DEADLINE_MS) return fail('intro-stalled');
      const cur = await getState();
      if (!cur) { await pause(500); continue; }
      if (cur.gone) return dropIntro();
      st = cur;
      if (!st.intro) return;
      if (new URLSearchParams(location.search).get('chat') !== st.opener) return location.replace('/?chat=' + encodeURIComponent(st.opener));
      if (sends > 0 && [...document.querySelectorAll('[data-testid="user-text"]')].some((e) => e.textContent.trim() === text.trim())) { await pause(500); continue; }
      const field = composer();
      if (!field) { await pause(150); continue; }
      if (field.value && field.value !== text && !text.startsWith(field.value)) return; // a draft that is not ours: leave it to the visitor
      if (field.value !== text) put(field, text);
      await pause(120);
      const send = document.querySelector('[data-testid="send"]');
      if (!send || send.disabled || composer() !== field || field.value !== text) { await pause(300); continue; } // the app rebuilt or reset the composer: again
      if (sends >= 3) return fail('intro-unsent');
      root.setAttribute('data-hold-scroll', ''); // the answer streams in below the question without dragging the view to the bottom (Transcript.svelte)
      send.click(); sends++;
      for (let i = 0; i < 16 && !failed && !visitorActed; i++) {
        await pause(500);
        const s = await getState();
        if (s && !s.gone && !s.intro) { st = s; update(); return; }
      }
    }
  }
  // The load-in: the real app, zoomed onto its message bar; the opener is typed into the real composer at his recorded cadence, the real send
  // button is pressed, and the view zooms back out while the answer generates. (The earlier overlay-and-flight intro is git tag demo-intro-flight-v1.)
  const ZOOM = { typing: 0.6, beat: 350, press: 180, out: 1100, minScale: 1.3, maxScale: 2.6, fill: 0.8, depth: 0.5, outAfter: null, hold: 250 };
  let zoomAnim = null;
  const unzoom = () => { const b = document.body; if (zoomAnim) { try { zoomAnim.cancel(); } catch {} zoomAnim = null; } if (b) { b.style.transform = ''; b.style.transformOrigin = ''; } };
  async function zoomIntro(text) {
    window.__demoIntroOwned = true;
    const t0 = Date.now();
    let field = composer();
    while (!field && Date.now() - t0 < 15000 && !failed && !visitorActed) { await pause(50); field = composer(); }
    if (!field || failed || visitorActed) { root.classList.add('demo-zoomed'); root.classList.remove('demo-intro'); return; }
    // camera: the message bar centred and scaled to fill most of the width, set before the page is shown
    const bar = field.closest('form') || field.parentElement || field, r = bar.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    const k = 1 + (Math.max(ZOOM.minScale, Math.min(ZOOM.maxScale, (vw * ZOOM.fill) / Math.max(1, r.width))) - 1) * ZOOM.depth; // depth 0.5: half the zoom that would fill the width
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // crop: centred on the bar, but when the zoomed bar is wider than the screen slide the crop left so its right end (the send button) stays 12px inside the edge
    const tx = Math.min(vw / 2 - cx, vw - 12 - cx - (k * r.width) / 2);
    const from = `translate(${tx}px, ${vh / 2 - cy}px) scale(${k})`;
    const b = document.body; b.style.transformOrigin = `${cx}px ${cy}px`; b.style.transform = from;
    root.classList.add('demo-zoomed');
    await pause(ZOOM.hold);
    // the zoom out starts the moment the word ZOOM.outAfter is typed and runs on under the rest of the typing
    const zoomOutAt = !ZOOM.outAfter ? -1 : (() => { const j = text.indexOf(ZOOM.outAfter); return j < 0 ? 1 : j + ZOOM.outAfter.length; })();
    const zoomOut = () => { if (zoomAnim) return; zoomAnim = b.animate([{ transform: from }, { transform: 'translate(0px, 0px) scale(1)' }], { duration: ZOOM.out, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }); zoomAnim.finished.then(() => unzoom(), () => {}); };
    // typing into the real composer
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const gaps = Array.isArray(st.openerGaps) && st.openerGaps.length === text.length - 1 ? st.openerGaps.concat(150) : Array.from(text, () => 60);
    let due = performance.now();
    field.focus({ preventScroll: true });
    for (let i = 1; i <= text.length; i++) {
      if (failed || visitorActed) return;
      const f = composer(); if (!f) break;
      setter.call(f, text.slice(0, i)); f.dispatchEvent(new Event('input', { bubbles: true }));
      if (i === zoomOutAt) zoomOut();
      due += gaps[i - 1] * ZOOM.typing; const wait = due - performance.now(); if (wait > 0) await pause(wait);
    }
    await pause(ZOOM.beat);
    // the press on the real send button, then the send (sendOpener clicks it and retries if the app reset the composer)
    const send = document.querySelector('[data-testid="send"]');
    if (send) send.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)', offset: .45 }, { transform: 'scale(1)' }], { duration: ZOOM.press, easing: 'ease-out' });
    await pause(ZOOM.press * 0.45);
    const sending = sendOpener(text);
    root.classList.remove('demo-intro'); root.classList.add('demo-landed');
    await pause(ZOOM.press * 0.55); // the zoom out starts the moment the button is back up
    zoomOut();
    await sending;
  }
  async function introFlow() {
    const text = st.openerText + ' '; // typed with a trailing space, as he types; the server trims it
    await zoomIntro(text);
  }

  // ---- state: after every turn and on a slow poll ----
  function update() {
    if (!st) return;
    if (st.verified && checkDeadline) { clearInterval(checkDeadline); checkDeadline = null; const h = document.getElementById('demo-check'); if (h) h.remove(); }
    // the opener's answer has finished: its pending-state rules (intro.css) end
    // (the page's own view, not only the server's: a pending label stays hidden until the activity line has left its queued and starting phases)
    const phase = (document.querySelector('[data-testid="activity"]') || {}).dataset?.phase;
    if (!st.intro && !st.running && !visual && st.turns === 0 && phase !== 'queued' && phase !== 'starting') root.classList.remove('demo-opener');
    if (!st.intro && !st.running && phase !== 'queued' && phase !== 'starting' && phase !== 'running') document.documentElement.removeAttribute('data-hold-scroll');
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
  const newSession = async (fresh) => {
    const r = await fetch('/_demo/session' + (fresh ? '?fresh=1' : ''), { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (r && r.ok) { const n = await r.json(); return location.replace('/?chat=' + encodeURIComponent(n.opener)); }
    return fail('no-session-' + (r ? r.status : 'net'));
  };


  // ---- the tuner: tophat.md/#tune opens a panel that edits TUNE (sessionStorage 'demo-tune'), replays, scrubs and copies the values ----
  if (TUNE_ON) {
    // [section, label, unit, min, max, step]
    const SPEC = {
      speed: ['Overall', 'Playback speed (1 = real time, 0.25 = 4x slow motion)', 'x', 0.05, 2, 0.05],
      typing: ['Typing', 'Typing pace (multiplier on recorded keystroke gaps; lower = faster)', 'x', 0.1, 2, 0.05],
      lineSize: ['Typing', 'Typed text size', 'vw', 2, 8, 0.1],
      lineY: ['Typing', 'Typed text height on screen (50 = middle)', '%', 20, 80, 1],
      sendFadeStart: ['Send button', 'Starts fading in, % through the typing (0 = at first letter)', '0-1', 0, 1, 0.01],
      sendFade: ['Send button', 'Fade-in length', 'ms', 0, 3000, 50],
      sendDist: ['Send button', 'Distance from the text (x line width; 1 = touching at the end)', 'x', 1, 3, 0.05],
      sendSize: ['Send button', 'Size', 'em', 0.5, 2, 0.05],
      beat: ['Press', 'Pause after the last letter, before the press', 'ms', 0, 2000, 10],
      press: ['Press', 'Press length', 'ms', 40, 800, 10],
      pressScale: ['Press', 'How far the button shrinks when pressed', 'scale', 0.5, 1, 0.02],
      pressDown: ['Press', 'Message takes off at this point of the press (0.5 = halfway)', '0-1', 0.05, 0.95, 0.05],
      flight: ['Flight', 'Flight length', 'ms', 200, 3000, 20],
      dip: ['Flight', 'Dip before takeoff, length', 'ms', 0, 600, 10],
      dipPx: ['Flight', 'Dip depth', 'px', 0, 60, 1],
      bow: ['Flight', 'Path curve toward the middle (max)', 'px', 0, 300, 5],
      landAt: ['Landing', 'Reaches its spot at this point of the flight (rest is overshoot + settle)', '0-1', 0.4, 1, 0.01],
      overshoot: ['Landing', 'Overshoot (max)', 'px', 0, 80, 1],
      targetRight: ['Landing', 'Fallback landing spot: from the right edge', 'px', 0, 400, 2],
      targetTop: ['Landing', 'Fallback landing spot: from the top', 'px', 0, 400, 2],
      fadeIn: ['Landing', 'Black background fades out over', 'ms', 0, 2000, 10],
      answerDelay: ['Answer', 'Answer appears this long after landing (negative = before)', 'ms', -1500, 1500, 10],
      answerIn: ['Answer', 'Answer fade/rise length', 'ms', 0, 2000, 10],
      answerRise: ['Answer', 'Answer rises from this far below', 'px', 0, 60, 1] };
    const save = (t) => { try { sessionStorage.setItem('demo-tune', JSON.stringify(t)); } catch {} };
    const cur = { ...TUNE };
    const build = () => {
      const el = document.createElement('div'); el.id = 'demo-tuner';
      el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483600;width:340px;max-height:calc(100vh - 16px);overflow:auto;background:#f3ecd9;color:#111;border:1px solid #111;font:11px/1.35 ui-monospace,Menlo,monospace;padding:8px;box-shadow:0 6px 24px #0006';
      let lastSec = ''; const row = (k) => { const [sec, label, unit, mn, mx, st] = SPEC[k]; const head = sec !== lastSec ? `<div style="margin:8px 0 2px;font-weight:bold;border-bottom:1px solid #111">${(lastSec = sec)}</div>` : ''; return head + `<div style="margin:4px 0 0">${label} <span style="color:#777">(${unit})</span></div><label style="display:grid;grid-template-columns:1fr 60px;gap:6px;align-items:center;margin:0 0 2px"><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${cur[k]}"><input type="number" data-n="${k}" min="${mn}" max="${mx}" step="${st}" value="${cur[k]}" style="width:60px;font:inherit;background:#fff8e6;border:1px solid #999"></label>`; };
      el.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>intro tuner</b><a href="#" data-a="close" style="color:#111">close</a></div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px"><button data-a="replay">replay</button><button data-a="pause">pause</button><button data-a="play">play</button><button data-a="copy">copy</button><button data-a="reset">reset</button><label><input type="checkbox" data-a="hold" ${cur.hold ? 'checked' : ''}> hold end</label></div>
        <label style="display:grid;grid-template-columns:90px 1fr 40px;gap:6px;align-items:center"><span>freeze at ms</span><input type="range" data-a="scrub" min="0" max="${Math.round(window.__demoIntroTotal || 6000)}" step="1" value="0"><span data-scrubv>0</span></label>
        <hr style="border:0;border-top:1px solid #111;margin:6px 0">${Object.keys(SPEC).map(row).join('')}
        <div style="margin-top:6px;color:#555">Change values, then press replay. "hold end" keeps the last frame so "freeze at" can scrub it. "copy" puts your changed values on the clipboard: paste them in chat.</div>`;
      document.body.appendChild(el);
      const set = (k, v) => { cur[k] = Number(v); el.querySelector(`[data-k="${k}"]`).value = v; el.querySelector(`[data-n="${k}"]`).value = v; save(cur); };
      el.addEventListener('input', (e) => { const t = e.target; if (t.dataset.k) set(t.dataset.k, t.value); else if (t.dataset.n) set(t.dataset.n, t.value);
        else if (t.dataset.a === 'scrub') { const ms = Number(t.value); el.querySelector('[data-scrubv]').textContent = ms; for (const a of anims()) { a.pause(); a.currentTime = ms; } } });
      el.addEventListener('change', (e) => { if (e.target.dataset.a === 'hold') { cur.hold = e.target.checked; save(cur); } });
      el.addEventListener('click', (e) => { const a = e.target.dataset.a; if (!a || a === 'hold') return; e.preventDefault();
        if (a === 'replay') { save(cur); window.__demoTuneReplay && window.__demoTuneReplay(cur); }
        else if (a === 'pause') anims().forEach((x) => x.pause());
        else if (a === 'play') anims().forEach((x) => x.play());
        else if (a === 'copy') { const diff = Object.fromEntries(Object.keys(SPEC).filter((k) => cur[k] !== TUNE_DEFAULTS[k]).map((k) => [k, cur[k]])); const txt = JSON.stringify(diff, null, 1); navigator.clipboard?.writeText(txt).catch(() => {}); e.target.textContent = 'copied'; setTimeout(() => (e.target.textContent = 'copy'), 1200); console.log('demo-tune', txt); }
        else if (a === 'reset') { try { sessionStorage.removeItem('demo-tune'); } catch {} location.reload(); }
        else if (a === 'close') { try { sessionStorage.removeItem('demo-tune-on'); } catch {} location.href = '/'; } });
      // the scrub range follows the scheduled intro once it is known
      const iv = setInterval(() => { if (window.__demoIntroTotal) { el.querySelector('[data-a="scrub"]').max = Math.round(window.__demoIntroTotal); clearInterval(iv); } }, 200);
    };
    const anims = () => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#demo-intro'));
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build, { once: true });
  }
  (async () => {
    // `?fresh=1` is a brand-new guest (new cookie, new starting chats); the server does this for a page it serves, this is for one the app served from its cache
    if (new URLSearchParams(location.search).get('fresh') === '1') return newSession(true);
    st = await bootState();
    if (TUNE_ON && st && !st.gone) {
      // the stage: the app stays hidden and untouched (no send, no check, no polling); the intro plays alone and replays in place
      const hide = document.createElement('style'); hide.textContent = 'body > :not(#demo-tuner) { visibility: hidden !important; }'; document.head.appendChild(hide);
      const text = (st.openerText || 'so, whats ur deal ?') + ' ';
      const play = () => { cleanupVisual(); root.classList.add('demo-intro'); window.__demoCaretAt = performance.now() - 700; window.__demoIntroTotal = 0; const v = startVisual(); if (v) playVisual(v, text); };
      window.__demoTuneReplay = (t) => { retune(t); play(); };
      play();
      return;
    }
    // no session (the page came from the app's cache after the cookie expired): ask for one, then load the app again with it
    if (st && st.gone) return newSession(false);
    if (!st) return fail('state-unreachable');
    if (!st.intro) dropIntro(); else root.classList.add('demo-opener'); // the opener never shows a pending label, motion or not
    // a page of the app's own cache can name an intro chat that has since been played and replaced, or none at all: go to the live one
    const here = new URLSearchParams(location.search).get('chat');
    if (st.intro && wantsIntro() && here !== st.opener) return location.replace('/?chat=' + encodeURIComponent(st.opener));
    // the human check starts at once, in the background, alongside the app's boot (a visitor who fails it is sent to the textual page either way)
    if (document.body) humanCheck(); else document.addEventListener('DOMContentLoaded', humanCheck, { once: true });
    followForks();
    introFlow();
    update();
    setInterval(refresh, 2500);
    // the app never came up: land on the static page
    setTimeout(() => { if (!document.querySelector('[data-testid="composer"]') && !document.querySelector('[data-testid="sidebar"]') && !failed) location.replace('/_fallback'); }, BOOT_TIMEOUT_MS);
  })();
})();
