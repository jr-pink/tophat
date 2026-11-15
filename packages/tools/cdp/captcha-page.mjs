// The page-side halves of `tophat-cdp captcha`: what to look for, and where a token goes. Pure strings, no I/O.

/** Installed with Page.addScriptToEvaluateOnNewDocument before a reload of a Cloudflare challenge page, so
 *  turnstile.render hands over cData / chlPageData / action (2Captcha needs them) and its callback. */
export const TURNSTILE_HOOK_JS = `(() => {
  // wraps turnstile.render within a millisecond of api.js defining it; a setter on window.turnstile broke the challenge (it never loaded)
  const wrap = (t) => {
    if (!t || typeof t !== 'object' || t.__tophatHooked) return t;
    try {
      t.__tophatHooked = true;
      t.render = function (el, o) { o = o || {}; window.__tophatTs = { sitekey: o.sitekey, action: o.action || null, cData: o.cData || null, chlPageData: o.chlPageData || null }; window.__tophatTsCb = o.callback; return 'tophat-ts'; };
    } catch (e) { /* frozen: the interval below tries again */ }
    return t;
  };
  const i = setInterval(() => { if (window.turnstile) { wrap(window.turnstile); if (window.turnstile.__tophatHooked) clearInterval(i); } }, 1);
  setTimeout(() => clearInterval(i), 90000);
})();`;

/** Evaluated in the page: {url, title, challenge, widgets[], unsupported[]}. Reads only; the DOM is unchanged. */
export const DETECT_JS = `(() => {
  const widgets = [], seen = new Set();
  const add = (w) => { if (!w.sitekey) return; const k = w.kind + '|' + w.sitekey; if (seen.has(k)) return; seen.add(k); widgets.push(w); };
  const visible = (el) => { try { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (e) { return false; } };
  const attr = (el, n) => el.getAttribute(n) || null;
  const q = (s) => Array.from(document.querySelectorAll(s));
  const param = (src, name) => { try { const u = new URL(src, location.href); return u.searchParams.get(name) || new URLSearchParams(u.hash.replace(/^#/, '')).get(name); } catch (e) { return null; } };
  const v3 = new Set();
  for (const s of q('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]')) {
    const r = param(s.src, 'render');
    if (r && r !== 'explicit' && r !== 'onload') { v3.add(r); add({ kind: 'recaptcha_v3', sitekey: r, enterprise: /enterprise\\.js/.test(s.src), visible: false }); }
  }
  const ent = !!document.querySelector('script[src*="recaptcha/enterprise.js"]');
  for (const el of q('.g-recaptcha[data-sitekey]')) {
    const key = attr(el, 'data-sitekey');
    if (v3.has(key)) continue;
    add({ kind: ent ? 'recaptcha_v2_enterprise' : 'recaptcha_v2', sitekey: key, invisible: attr(el, 'data-size') === 'invisible', callbackName: attr(el, 'data-callback'), dataS: attr(el, 'data-s'), visible: visible(el) });
  }
  for (const f of q('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]')) {
    const key = param(f.src, 'k');
    if (!key || v3.has(key)) continue;
    add({ kind: /enterprise\\/anchor/.test(f.src) ? 'recaptcha_v2_enterprise' : 'recaptcha_v2', sitekey: key, invisible: param(f.src, 'size') === 'invisible', visible: visible(f) });
  }
  for (const el of q('.h-captcha[data-sitekey]')) add({ kind: 'hcaptcha', sitekey: attr(el, 'data-sitekey'), invisible: attr(el, 'data-size') === 'invisible', callbackName: attr(el, 'data-callback'), visible: visible(el) });
  for (const f of q('iframe[src*="hcaptcha.com"]')) add({ kind: 'hcaptcha', sitekey: param(f.src, 'sitekey'), visible: visible(f) });
  for (const el of q('.cf-turnstile[data-sitekey]')) add({ kind: 'turnstile', sitekey: attr(el, 'data-sitekey'), action: attr(el, 'data-action'), cData: attr(el, 'data-cdata'), callbackName: attr(el, 'data-callback'), visible: visible(el) });
  for (const f of q('iframe[src*="challenges.cloudflare.com"]')) {
    const m = /\\/(0x[0-9A-Za-z_-]{10,}|[123]x0{4,}[0-9A-Za-z_-]*)\\//.exec(f.src);
    if (m) add({ kind: 'turnstile', sitekey: m[1], visible: visible(f) });
  }
  const hook = window.__tophatTs || null;
  if (hook && hook.sitekey) {
    const had = widgets.findIndex((w) => w.kind === 'turnstile' && w.sitekey === hook.sitekey);
    if (had >= 0) widgets.splice(had, 1);
    widgets.unshift({ kind: 'turnstile', sitekey: hook.sitekey, action: hook.action, cData: hook.cData, chlPageData: hook.chlPageData, visible: true, intercepted: true });
  }
  const challenge = /^Just a moment/i.test(document.title) || !!window._cf_chl_opt || !!document.querySelector('#challenge-form, #challenge-running, .cf-browser-verification');
  const unsupported = [];
  if (/^Attention Required/i.test(document.title) && !widgets.length) unsupported.push('cloudflare block page (a ban, not a captcha)');
  if (document.querySelector('#px-captcha, [class*="px-captcha"]')) unsupported.push('perimeterx press-and-hold');
  if (document.querySelector('iframe[src*="captcha-delivery.com"]')) unsupported.push('datadome');
  if (document.body && /validateCaptcha|Type the characters you see in this image/i.test((document.body.innerText || document.body.textContent || '') + ' ' + (document.querySelector('form') ? document.querySelector('form').action : ''))) unsupported.push('image captcha');
  return { url: location.href, title: document.title, challenge: challenge, widgets: widgets, unsupported: unsupported };
})()`;

// JSON that is safe inside a script: no </script>, no line separators.
const lit = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The page-side injection: set every response field, fire the page's own callback, and (opt-in) submit the form when no callback fired.
 *  Evaluates to {fields, callback, callbackError, submitted}; the token only ever goes in, never comes back out. */
export function injectJs(token, widget, { submit = false } = {}) {
  return `((token, widget, doSubmit) => {
  const out = { fields: 0, callback: null, callbackError: null, submitted: false };
  const setValue = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    if (el.tagName === 'TEXTAREA') el.textContent = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const names = widget.kind === 'turnstile' ? ['cf-turnstile-response', 'g-recaptcha-response'] : widget.kind === 'hcaptcha' ? ['h-captcha-response', 'g-recaptcha-response'] : ['g-recaptcha-response'];
  let first = null;
  for (const n of names) for (const el of document.querySelectorAll('textarea[name="' + n + '"], input[name="' + n + '"], textarea#' + n)) { setValue(el, token); out.fields += 1; first = first || el; }
  if (widget.kind === 'hcaptcha') for (const f of document.querySelectorAll('iframe[data-hcaptcha-widget-id]')) f.setAttribute('data-hcaptcha-response', token);
  const byPath = (p) => { try { let o = window; for (const s of String(p).split('.')) o = o[s]; return typeof o === 'function' ? o : null; } catch (e) { return null; } };
  const scan = (root) => {
    const seen = new Set(), stack = [[root, 0]];
    while (stack.length) {
      const [o, depth] = stack.pop();
      if (!o || typeof o !== 'object' || seen.has(o) || depth > 6) continue;
      seen.add(o);
      for (const k of Object.keys(o)) {
        let v; try { v = o[k]; } catch (e) { continue; }
        if (k === 'callback' && typeof v === 'function') return v;
        if (k === 'callback' && typeof v === 'string' && byPath(v)) return byPath(v);
        if (v && typeof v === 'object') stack.push([v, depth + 1]);
      }
    }
    return null;
  };
  let cb = null, how = null;
  if (widget.callbackName && byPath(widget.callbackName)) { cb = byPath(widget.callbackName); how = 'data-callback ' + widget.callbackName; }
  if (!cb && widget.kind === 'turnstile' && typeof window.__tophatTsCb === 'function') { cb = window.__tophatTsCb; how = 'intercepted turnstile.render callback'; }
  if (!cb && widget.kind.indexOf('recaptcha') === 0 && window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) { cb = scan(window.___grecaptcha_cfg.clients); if (cb) how = 'grecaptcha client callback'; }
  if (cb) { try { cb(token); out.callback = how; } catch (e) { out.callbackError = String(e && e.message || e).slice(0, 120); } }
  if (doSubmit && !out.callback) {   // a page that gave a callback submits (or navigates) itself; submit only when it did not
    const form = (first && first.closest('form')) || document.querySelector('form');
    if (form) { try { if (form.requestSubmit) form.requestSubmit(); else form.submit(); out.submitted = true; } catch (e) { out.callbackError = out.callbackError || String(e && e.message || e).slice(0, 120); } }
  }
  return out;
})(${lit(token)}, ${lit(widget)}, ${submit ? 'true' : 'false'})`;
}

/** Submit the form that holds the response field (else the first form). Used when a callback fired but the page stayed put. */
export const SUBMIT_JS = `(() => {
  const field = document.querySelector('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]');
  const form = (field && field.closest('form')) || document.querySelector('form');
  if (!form) return false;
  try { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return true; } catch (e) { return false; }
})()`;
