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

  // ---- the opening motion: one self-contained animation on its own overlay (intro.css), independent of the app ----
  // The page's first script draws the overlay (black, a centred line, a blinking caret) at the first paint. The typing, the send button, the
  // flight and the reveal all happen on that overlay with compositor animations (transform and opacity only), so a busy main thread while the
  // app boots underneath cannot freeze or skip them. Nothing here measures, styles or waits for the app; the opener is sent to the app
  // separately (sendOpener). The only link: if the app has drawn the message by the time it flies, the flight lands exactly on it.
  const root = document.documentElement;
  const FLIGHT_MS = 1000, DIP_MS = 120, LAND_AT = 0.78, IN_MS = 450, OVERLAY_HTML = '<div class="bg"></div><div class="stars"></div><div class="line"><span class="msg"></span><i class="caret idle"></i><b class="send"></b></div>';
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
    root.classList.remove('demo-intro', 'demo-intro-out', 'demo-bare', 'demo-send');
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
    const travel = Math.hypot(P1.x - P0.x, P1.y - P0.y), bow = Math.min(vw * 0.1, 90) * Math.min(1, travel / 400);
    const dip = 12, over = Math.min(26, Math.max(10, travel * 0.045)), n = Math.round(FLIGHT_MS / 16), frames = [];
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
  /** The send-off, all scheduled up front on the compositor: the press, the flight, the stars, the black fading out as it lands, the copy handing over to the real message. */
  function flyVisual(v, text) {
    const o = v.o, vw = root.clientWidth;
    v.send.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: .45 }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
    v.caret.style.visibility = 'hidden'; // the message leaves the flex line: the caret would re-centre for a frame
    root.classList.add('demo-intro-out'); root.classList.remove('demo-intro'); o.classList.add('out'); // the page under the overlay is the app's own again (no forced black body) as the overlay's black fades o.style.pointerEvents = 'none';
    const r = v.msg.getBoundingClientRect(), mcs = getComputedStyle(v.msg), fs = parseFloat(mcs.fontSize) || 40, font = { fontFamily: mcs.fontFamily, fontSize: mcs.fontSize, fontWeight: mcs.fontWeight, fontStyle: mcs.fontStyle, letterSpacing: mcs.letterSpacing }; // read before it leaves the line: out of .line it would inherit the page's 16px and the words would shrink inside a bubble sized for the big line (the "font size scales wrong in flight" report)
    // the target: the real message if the app has drawn it (same box, so the hand-over is exact), else where it will sit (top right of the transcript)
    const real = [...document.querySelectorAll('[data-testid="user-text"]')].find((e) => e.textContent.trim() === text.trim());
    let br = real && real.getBoundingClientRect();
    const rfs = real ? parseFloat(getComputedStyle(real).fontSize) || 14.5 : 14.5, k = rfs / fs;
    if (!br || !(br.width > 0) || br.bottom < 0 || br.top > innerHeight) br = null;
    const padY = 9 / k, padX = 13 / k; // Message.svelte's bubble padding at the line's size
    const w = br ? br.width / k : r.width + 2 * padX, h = br ? br.height / k : r.height * 0.82 + 2 * padY;
    const P0 = { x: r.left - padX - (1 / k - 1), y: r.top + r.height / 2 - h / 2 }, P1 = br ? { x: br.left, y: br.top } : { x: root.clientWidth - 28 - w * k, y: 72 };
    // the message leaves the line (its caret and send button go) and flies on its own, from exactly where its words are
    Object.assign(v.msg.style, font, { position: 'fixed', left: '0', top: '0', right: 'auto', margin: '0', boxSizing: 'border-box', width: w + 'px', height: h + 'px', padding: `${padY}px ${padX}px`, borderRadius: `${14 / k}px ${14 / k}px ${4 / k}px ${14 / k}px`, borderWidth: 1 / k + 'px', lineHeight: (h - 2 * padY) + 'px', transformOrigin: '0 0', transform: `translate(${P0.x}px,${P0.y}px)` });
    o.appendChild(v.msg);
    v.msg.classList.add('bubble');
    v.msg.animate(flightFrames(P0, P1, k, vw), { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' });
    v.line.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(40px)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' });
    o.querySelector('.stars').animate([{ opacity: 0, transform: 'translate3d(0,0,0)' }, { opacity: 1, offset: .18 }, { opacity: 1, transform: 'translate3d(0,400px,0)' }], { duration: FLIGHT_MS, easing: 'cubic-bezier(.45,.05,.55,.95)', fill: 'forwards' });
    const landAt = DIP_MS + (FLIGHT_MS - DIP_MS) * LAND_AT;
    // the black and the stars fade as the message reaches its place, whatever the main thread is doing (one timeline, no timers)
    for (const el of [o.querySelector('.bg'), o.querySelector('.stars')]) el.animate([{ opacity: 1 }, { opacity: 0 }], { delay: landAt, duration: IN_MS, easing: 'ease-out', fill: 'forwards', composite: 'replace' });
    // the flying copy hands over to the real message (under it by then), then the overlay is gone
    const handover = v.msg.animate([{ opacity: 1 }, { opacity: 0 }], { delay: FLIGHT_MS + IN_MS - 150, duration: 200, easing: 'linear', fill: 'forwards', composite: 'add' });
    // the end keyframe lands on the real message: when the flight ends, if the app has drawn it somewhere other than where we aimed, glide the last pixels onto it before the hand-over
    setTimeout(() => {
      const re = [...document.querySelectorAll('[data-testid="user-text"]')].find((e) => e.textContent.trim() === text.trim()), b = re && re.getBoundingClientRect();
      if (!b || !(b.width > 0) || b.bottom < 0 || b.top > innerHeight || (Math.abs(b.left - P1.x) < 1 && Math.abs(b.top - P1.y) < 1 && Math.abs(b.width - w * k) < 1)) return;
      const s2 = b.width / w;
      v.msg.animate([{ transform: `translate(${P1.x}px,${P1.y}px) scale(${k})` }, { transform: `translate(${b.left}px,${b.top}px) scale(${s2})` }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    }, FLIGHT_MS);
    handover.finished.then(cleanupVisual, cleanupVisual);
    v.timer = setTimeout(cleanupVisual, FLIGHT_MS + IN_MS + 1500); // a backstop only
  }
  /** The whole visible intro: a blink, the typing at his recorded cadence, a beat, the press and the flight. Returns when the flight is scheduled. */
  async function playVisual(v, text) {
    await pause(Math.max(0, 700 - (performance.now() - (window.__demoCaretAt || performance.now()))));
    const gaps = Array.isArray(st.openerGaps) && st.openerGaps.length === text.length - 1 ? st.openerGaps.concat(150) : Array.from(text, () => 60);
    let due = performance.now(), typed = '';
    for (const ch of text) {
      due += gaps[typed.length] * 0.6;
      const wait = due - performance.now(); if (wait > 0) await pause(wait);
      if (visual !== v || visitorActed || failed) return;
      typed += ch; typedVisual(v, typed, text);
    }
    await pause(1700);
    if (visual !== v || visitorActed || failed) return;
    flyVisual(v, text);
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
  async function introFlow() {
    const text = st.openerText + ' '; // typed with a trailing space, as he types; the server trims it
    const v = startVisual();
    const sending = sendOpener(text); // the app gets the message at once, behind the overlay; the answer is already coming when the overlay lifts
    if (v) playVisual(v, text);
    await sending;
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
