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
  const INTRO_MS = 900, INTRO_EASE = 'cubic-bezier(.65,.05,.2,1)';
  const root = document.documentElement;
  let visual = null;
  const cleanupVisual = () => {
    const v = visual; if (!v) return; visual = null;
    clearTimeout(v.timer); clearTimeout(v.idle);
    root.classList.remove('demo-intro', 'demo-ready', 'demo-intro-out', 'demo-measure');
    for (const k of ['ox', 'oy', 'dx', 'dy', 's', 'pl', 'ms', 'ease']) root.style.removeProperty('--di-' + k);
    v.caret.remove(); v.mirror.remove(); if (v.clone) v.clone.remove();
    if (v.bubble) v.bubble.style.visibility = '';
    window.removeEventListener('resize', v.onResize);
    setTimeout(() => root.classList.remove('demo-opener'), 4000);
  };
  const dropIntro = () => { if (visual) cleanupVisual(); else root.classList.remove('demo-intro'); };
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
    // half the real bar, but never narrower than the text plus its padding and a little room (a phone's bar is already narrow)
    const wantW = Math.max(real.width / 2, v.textW + 2 * fieldPad + 24);
    const extras = barRect.width - 2 * pad(bar, 'Left') - real.width; // attach button, send button and gaps
    root.style.setProperty('--di-pl', (barRect.width - (wantW + extras)) / 2 + 'px');
    const t = field.getBoundingClientRect(), sd = send.getBoundingClientRect(), ar = app.getBoundingClientRect();
    const vw = root.clientWidth, vh = window.innerHeight;
    v.cx = vw / 2; v.cy = vh / 2;
    v.p0x = t.left + fieldPad; v.p0y = t.top + t.height / 2;
    // the zoom: when the whole text is typed, the send button (its right edge) sits 6% of the width in from the screen's edge
    const span = sd.right - v.p0x - v.textW;
    v.S = Math.min(3.6, Math.max(1.2, span > 0 ? (vw / 2 - vw * 0.06) / span : 2));
    v.lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    v.color = cs.color;
    root.style.setProperty('--di-s', String(v.S));
    root.style.setProperty('--di-ox', v.p0x - ar.left + 'px'); root.style.setProperty('--di-oy', v.p0y - ar.top + 'px');
    root.style.setProperty('--di-dy', v.cy - v.p0y + 'px');
    root.classList.remove('demo-measure');
    Object.assign(v.caret.style, { left: v.cx + 'px', top: v.cy + 'px', width: Math.max(2, v.S) + 'px', height: v.lineH * v.S * 0.85 + 'px', background: v.color });
    slideVisual(v, field.value);
  }
  /** The bar slides left by the width of what is typed, so the end of the text (the caret) stays at the middle of the screen. */
  function slideVisual(v, typed) {
    v.dx = v.cx - v.p0x - v.S * v.width(typed);
    root.style.setProperty('--di-dx', v.dx + 'px');
  }
  function startVisual(text) {
    if (visual) return visual;
    if (!root.classList.contains('demo-intro')) return null;
    try {
      const field = composer(), bar = field && field.closest('.composer'), send = document.querySelector('[data-testid="send"]'), app = field && field.closest('.app');
      if (!field || !bar || !send || !app) return null;
      const mirror = document.createElement('span'), caret = document.createElement('div');
      caret.id = 'demo-caret'; caret.className = 'idle';
      document.body.append(mirror, caret);
      const v = { field, bar, send, app, text, mirror, caret, width: (s) => { mirror.textContent = s; return mirror.getBoundingClientRect().width; }, timer: 0, idle: 0, clone: null, bubble: null };
      let rt = 0; v.onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (visual === v && !root.classList.contains('demo-intro-out')) layoutVisual(v); }, 120); };
      window.addEventListener('resize', v.onResize);
      visual = v;
      window.__demoIntroOwned = true; root.classList.add('demo-opener');
      layoutVisual(v);
      root.classList.add('demo-ready');
      return v;
    } catch (e) { cleanupVisual(); root.classList.remove('demo-intro'); return null; }
  }
  /** One typed character: the text, then the bar's slide, in the same task (one paint). */
  const typedVisual = (typed) => {
    const v = visual; if (!v || root.classList.contains('demo-intro-out')) return;
    // the app rebuilds its composer when the chat finishes loading: measure the new one
    const f = composer();
    if (f && f !== v.field) { v.field = f; v.bar = f.closest('.composer') || v.bar; v.send = document.querySelector('[data-testid="send"]') || v.send; v.app = f.closest('.app') || v.app; layoutVisual(v); }
    slideVisual(v, typed);
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
  /** The motion back: the app slides and scales to its real place, the black fades, the bar widens, and the message flies from the bar to its place at the top. */
  function exitVisual(bubble) {
    const v = visual; if (!v) return;
    const S = v.S;
    if (bubble) {
      // where the bubble will rest once the app is back (its layout box: undo the app's current transform), and where it starts (the typed text, on the bar)
      const br = bubble.getBoundingClientRect(), bs = getComputedStyle(bubble);
      const fx = v.p0x + (br.left - v.p0x - v.dx) / S, fy = v.p0y + (br.top - v.p0y - (v.cy - v.p0y)) / S, fw = br.width / S, fh = br.height / S;
      const clone = document.createElement('div');
      clone.textContent = bubble.textContent;
      for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'padding', 'borderRadius', 'border', 'boxShadow', 'whiteSpace', 'overflowWrap', 'textAlign']) clone.style[k] = bs[k];
      Object.assign(clone.style, { position: 'fixed', left: '0', top: '0', margin: '0', boxSizing: 'border-box', width: fw + 'px', height: fh + 'px', zIndex: '2147482500', pointerEvents: 'none', transformOrigin: '0 0' });
      const x0 = v.cx - v.textW * S - (parseFloat(bs.paddingLeft) || 0) * S, y0 = v.cy - fh * S / 2;
      document.body.append(clone);
      clone.animate([{ transform: `translate(${x0}px,${y0}px) scale(${S})` }, { transform: `translate(${fx}px,${fy}px) scale(1)` }], { duration: INTRO_MS, easing: INTRO_EASE, fill: 'both' });
      clone.animate([{ backgroundColor: 'rgba(0,0,0,0)', color: v.color }, { backgroundColor: bs.backgroundColor, color: bs.color }], { duration: 260, easing: 'linear', fill: 'both' });
      bubble.style.visibility = 'hidden'; v.bubble = bubble; v.clone = clone;
    }
    v.caret.classList.remove('idle'); v.caret.classList.add('gone');
    root.style.setProperty('--di-ms', INTRO_MS + 'ms'); root.style.setProperty('--di-ease', INTRO_EASE);
    root.classList.add('demo-intro-out'); root.classList.remove('demo-intro');
    v.timer = setTimeout(cleanupVisual, INTRO_MS + 150);
  }
  async function introFlow() {
    const t0 = Date.now(), text = st.openerText;
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
      let field = composer();
      if (!field) { await pause(100); continue; }
      if (field.value && field.value !== text && !text.startsWith(field.value)) return; // a draft that is not ours: leave it to the visitor
      if (field.value !== text) {
        const v = startVisual(text);
        // the opening: the bar alone on black for a beat, then the typing, replaying the recorded gaps (no randomness) against one clock so they do not drift
        await pause(v ? 500 : 250);
        let typed = field.value;
        const gaps = Array.isArray(st.openerGaps) && st.openerGaps.length === text.length ? st.openerGaps : Array.from(text, () => 60);
        let due = performance.now();
        for (const ch of text.slice(typed.length)) {
          field = composer();
          due += gaps[typed.length];
          const wait = due - performance.now(); if (wait > 0) await pause(wait);
          if (!field || visitorActed || failed || field.value !== typed) break;
          typed += ch; put(field, typed); typedVisual(typed);
        }
        field = composer();
        if (visitorActed || failed) return;
        if (!field || field.value !== text) { await pause(400); continue; } // the app reset the composer under the typing: type again
      }
      await pause(visual ? 520 : 450); // a beat before the click
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
    head.style.cssText = 'font:600 17px/1.4 var(--sans,system-ui);margin-bottom:12px';
    head.textContent = st.resting && st.turns < st.cap ? 'the demo is resting for today; you can still run it yourself' : "ok, that's the demo. try downloading it";
    const box = document.createElement('div');
    box.style.cssText = 'position:relative;background:var(--bg-sunken,#f3f3f3);border:1px solid var(--line,#ccc);border-radius:8px';
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:10px 12px;padding-right:64px;font:12.5px/1.5 var(--mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere';
    const link = document.createElement('a'); link.href = st.repo; link.target = '_blank'; link.rel = 'noopener'; link.textContent = st.repo; link.style.color = 'inherit';
    pre.append(link, '\n' + st.onboard.slice(st.repo.length + 1));
    const copy = document.createElement('button');
    copy.type = 'button'; copy.textContent = 'Copy';
    copy.style.cssText = 'position:absolute;top:6px;right:6px;font:600 12px var(--sans,system-ui);border:1px solid var(--line,#ccc);border-radius:6px;padding:3px 8px;background:var(--bg-raised,#fff);color:inherit;cursor:pointer';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(st.onboard); copy.textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(r); } };
    box.append(pre, copy); card.append(head, box); o.append(card); document.body.append(o);
  }

  // ---- state: after every turn and on a slow poll ----
  function update() {
    if (!st) return;
    if (st.verified && checkDeadline) { clearInterval(checkDeadline); checkDeadline = null; const h = document.getElementById('demo-check'); if (h) h.remove(); }
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
    if (!st.intro) dropIntro();
    // a page of the app's own cache can name an intro chat that has since been played and replaced, or none at all: go to the live one
    const here = new URLSearchParams(location.search).get('chat');
    if (st.turns === 0 && wantsIntro() && here !== st.opener) return location.replace('/?chat=' + encodeURIComponent(st.opener));
    whenBooted(humanCheck);
    introFlow();
    update();
    setInterval(refresh, 2500);
    // the app never came up: land on the static page
    setTimeout(() => { if (!document.querySelector('[data-testid="composer"]') && !document.querySelector('[data-testid="sidebar"]') && !failed) location.replace('/_fallback'); }, BOOT_TIMEOUT_MS);
  })();
})();
