// tophat-cdp captcha, the browser half: find the captcha in an owned tab, buy a token (captcha.mjs), put it in the
// page and fire the page's own callback (captcha-page.mjs). Results never contain the token.
//
// Kinds handled: reCAPTCHA v2 / v2 Enterprise / v3, hCaptcha, Cloudflare Turnstile (a standalone widget, or the
// challenge page, where turnstile.render is intercepted on a reload to learn cData / chlPageData / action).
// Not handled, and reported by `detect`: image captchas, PerimeterX press-and-hold, DataDome.
import * as K from './browser/kernel.mjs';
import { DETECT_JS, SUBMIT_JS, TURNSTILE_HOOK_JS, injectJs } from './captcha-page.mjs';
import { KINDS, E, ProviderError, appendLedger, buildTask, captchaConfig, checkBudget, readKey, readLedger, solveWithProvider } from './captcha.mjs';

const r6 = (x) => Math.round(x * 1e6) / 1e6;
export const widgetSummary = (w) => ({ kind: w.kind, sitekey: w.sitekey, visible: !!w.visible, ...(w.invisible ? { invisible: true } : {}), ...(w.enterprise ? { enterprise: true } : {}),
  ...(w.callbackName ? { callbackName: w.callbackName } : {}), ...(w.intercepted ? { intercepted: true } : {}), ...(w.action ? { action: w.action } : {}) });

async function detectIn(conn) {
  const v = await K.evalValue(conn, DETECT_JS, { timeout: 15 });
  return v && typeof v === 'object' ? v : { url: '', title: '', challenge: false, widgets: [], unsupported: [] };
}

/** Reload a Cloudflare challenge page with turnstile.render hooked; true once its parameters were captured. */
async function interceptChallenge(conn, seconds = 25) {
  await conn.send('Page.enable', {});
  await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: TURNSTILE_HOOK_JS });
  await conn.send('Page.reload', { ignoreCache: false });
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await K.sleep(500);
    try { if (await K.evalValue(conn, '!!(window.__tophatTs && window.__tophatTs.sitekey)', { timeout: 5 })) return true; } catch { /* the document is swapping */ }
  }
  return false;
}

/** `captcha detect`: what is on the page. Nothing is bought and the page is not touched. */
export async function detect(ep, target, deps = {}) {
  return (deps.withTarget || K.withTarget)(ep, target, async (c) => {
    const d = await detectIn(c);
    return { url: d.url, title: d.title, challenge: d.challenge, widgets: d.widgets.map(widgetSummary), unsupported: d.unsupported };
  });
}

/**
 * `captcha solve`. deps (tests): {fetchImpl, env, now, sleep, withTarget}. Resolves to the result object (no token in it); throws CdpError.
 * a: {kind, sitekey, page_url, index, ts_action, submit, no_inject, no_hook, min_score, settle}
 */
export async function solve(ep, target, a, deps = {}) {
  const env = deps.env || process.env, fetchImpl = deps.fetchImpl || fetch, now = deps.now || Date.now;
  const cfg = captchaConfig(env), key = readKey(cfg);
  if (a.kind && !KINDS.includes(a.kind)) throw E(`captcha: --kind must be one of ${KINDS.join(', ')}`);
  const t0 = now(), nap = deps.sleep || K.sleep;
  return (deps.withTarget || K.withTarget)(ep, target, async (conn) => {
    let page = await detectIn(conn), hooked = false;
    const manual = a.sitekey ? [{ kind: a.kind || 'recaptcha_v2', sitekey: a.sitekey, visible: true, manual: true }] : null;
    if (!manual && !a.no_hook && page.challenge && !page.widgets.some((w) => w.kind === 'turnstile' && w.intercepted)) {
      hooked = await interceptChallenge(conn);
      page = await detectIn(conn);
    }
    let widgets = manual || page.widgets;
    if (a.kind && !manual) widgets = widgets.filter((w) => w.kind === a.kind);
    if (!widgets.length) {
      const why = [page.unsupported.length ? `unsupported here: ${page.unsupported.join(', ')}` : '',
        page.challenge && a.no_hook ? 'looks like a Cloudflare challenge but --no-hook was given' : '',
        page.challenge && !hooked && !a.no_hook ? 'a Cloudflare challenge page whose turnstile.render call was not seen within 25s (it may be a non-interactive check that clears itself: wait and re-read the page)' : ''].filter(Boolean).join('; ');
      throw E(`captcha: no solvable captcha on ${page.url || target.url}${why ? ` (${why})` : ''}`, 'target_not_found');
    }
    const ordered = [...widgets].sort((x, y) => Number(!!y.visible) - Number(!!x.visible));   // visible first, then page order
    const widget = ordered[a.index ?? 0];
    if (!widget) throw E(`captcha: --index ${a.index} but only ${ordered.length} captcha(s) found`);
    const pageUrl = a.page_url || page.url || target.url;
    const task = buildTask(widget, pageUrl, { minScore: a.min_score, action: a.ts_action });
    const estimate = Number(cfg.estimateUsd[widget.kind]);
    let solved = null, spent = 0, attempts = 0, lastErr = null;
    for (let i = 0; i < cfg.maxAttempts; i++) {
      checkBudget(cfg, widget.kind, readLedger(cfg.ledgerFile), now());
      const id = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let host = null; try { host = new URL(pageUrl).hostname; } catch { /* a manual --page-url may not parse */ }
      appendLedger(cfg.ledgerFile, { event: 'submit', id, at: now(), kind: widget.kind, estimateUsd: estimate, host });
      attempts += 1;
      try {
        solved = await solveWithProvider(cfg, key, task, { fetchImpl, sleep: deps.sleep, now });
        const cost = solved.costUsd ?? estimate;
        appendLedger(cfg.ledgerFile, { event: 'done', id, at: now(), ok: true, costUsd: cost, taskId: solved.taskId });
        spent += cost;
        break;
      } catch (e) {
        lastErr = e;
        // 2Captcha does not charge a refused request or an unsolvable task; a timed-out task may still be charged, so it stays at its estimate
        const free = e instanceof ProviderError;
        appendLedger(cfg.ledgerFile, { event: 'done', id, at: now(), ok: false, ...(free ? { costUsd: 0 } : {}), error: String(e.providerCode || e.message).slice(0, 80), taskId: e.taskId ?? null });
        if (!free) spent += estimate;
        if (!(e instanceof ProviderError && /UNSOLVABLE|NO_SLOT|BUSY/i.test(e.providerCode || ''))) break;
      }
    }
    if (!solved) throw E(`captcha: not solved after ${attempts} attempt(s): ${lastErr?.message || 'unknown'}`, lastErr instanceof K.CdpError ? lastErr.kind : 'verify_failed');
    const result = { solved: true, kind: widget.kind, sitekey: widget.sitekey, page: pageUrl, intercepted: !!widget.intercepted, taskId: solved.taskId, solveSeconds: solved.seconds,
      costUsd: solved.costUsd, attempts, spentUsd: r6(spent), found: widgets.length, ...(widgets.length > 1 ? { others: ordered.filter((w) => w !== widget).map(widgetSummary) } : {}) };
    if (a.no_inject) return { ...result, injected: false, note: 'token not injected (--no-inject) and never returned' };
    const inj = await K.evalValue(conn, injectJs(solved.token, widget, { submit: !!a.submit }), { timeout: 20 });
    Object.assign(result, { injected: inj.fields > 0 || !!inj.callback, fields: inj.fields, callback: inj.callback, ...(inj.callbackError ? { callbackError: inj.callbackError } : {}), submitted: inj.submitted });
    // where does the page stand after the settle window? a challenge page navigates away once its callback verifies
    const until = now() + Math.max(0, Number(a.settle ?? 0)) * 1000;
    let after = null;
    do {
      await nap(500);
      try { after = await detectIn(conn); } catch { after = null; }
      if (after && !after.challenge && after.url !== page.url) break;
    } while (now() < until);
    if (a.submit && inj.callback && !inj.submitted && !page.challenge && after && after.url === page.url && after.widgets.length) {
      // the callback fired but the page stayed put (a demo or a form that waits for its own submit): submit it now
      result.submitted = !!(await K.evalValue(conn, SUBMIT_JS, { timeout: 10 }).catch(() => false));
      await nap(1500);
      try { after = await detectIn(conn); } catch { after = null; }
    }
    if (after) result.after = { url: after.url, title: after.title, urlChanged: after.url !== page.url, challengeCleared: page.challenge ? !after.challenge : null, widgetsLeft: after.widgets.length };
    result.elapsedSeconds = Math.round((now() - t0) / 100) / 10;
    if (!result.injected) throw Object.assign(E(`captcha: solved and paid for ($${result.spentUsd}), but the page had no response field or callback to take the token; try --submit`, 'verify_failed'), { result });
    return result;
  }, 60);
}
