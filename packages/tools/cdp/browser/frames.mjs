// Frame-aware element addressing: `IFRAME_CSS >>> ELEMENT_CSS`, resolved page -> <iframe> element ->
// child target (DOM.describeNode frameId IS the OOPIF target id) ->... -> element; coordinates compose
// down the chain and every Input event goes to the PAGE at hit-tested coordinates. Page scripts are the
// Python tool's, byte for byte in behaviour.
import { CdpError, evaluate, listTargets, mouseClick, openTargetConn, pyRepr, sendSelectAll, sleep } from './kernel.mjs';

export const FRAME_SEP = '>>>';
export function splitSelector(selector) {
  const parts = String(selector || '').split(FRAME_SEP).map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) throw new CdpError(`empty segment in frame-piercing selector ${pyRepr(selector)} (syntax: "IFRAME_CSS >>> ELEMENT_CSS")`, 'usage');
  return parts;
}

// Open shadow roots are walked everywhere a selector is resolved. A segment matches in the light DOM first,
// exactly as before; only when it matches nothing there are the open shadow roots under the current document
// searched, so no selector that resolved before changes meaning. A non-final segment that names a shadow host
// (not an iframe) steps into its shadow root, so `x-outer >>> x-inner >>> iframe >>> #field` also works. DEEP
// is spliced into every page script below and into the one-line verbs (html, text, dom-click, wait-for); the
// Python tool carries the same text. No backslash, backtick, dollar-brace or percent sign in it: it must
// survive a JS template and Python %.
export const DEEP = `
  const __kids = (r) => { const out = []; let all = []; try { all = r.querySelectorAll('*'); } catch (e) { return out; }
    for (const n of all) if (n.shadowRoot) out.push(n.shadowRoot); return out; };
  const __roots = (root) => { const out = [], todo = __kids(root); while (todo.length && out.length < 5000) { const r = todo.shift(); out.push(r); todo.push(...__kids(r)); } return out; };
  const __all = (root, sel) => { const out = [...root.querySelectorAll(sel)]; for (const r of __roots(root)) out.push(...r.querySelectorAll(sel)); return out; };
  const __qa = (root, sel) => { const light = [...root.querySelectorAll(sel)]; if (light.length) return light;
    const deep = []; for (const r of __roots(root)) deep.push(...r.querySelectorAll(sel)); return deep; };
  const __q1 = (root, sel) => __qa(root, sel)[0] || null;
  const __up = (n) => !n ? null : (n.parentNode && n.parentNode.nodeType === 11 && n.parentNode.host) ? n.parentNode.host : n.parentNode;
  const __within = (a, b) => { for (let n = b; n; n = __up(n)) if (n === a) return true; return false; };
  const __hitAt = (doc, x, y) => { let h = doc.elementFromPoint(x, y);
    for (let i = 0; i < 32 && h && h.shadowRoot; i++) { const inner = h.shadowRoot.elementFromPoint(x, y); if (!inner || inner === h) break; h = inner; } return h; };
  const __active = (doc) => { let a = doc.activeElement; for (let i = 0; i < 32 && a && a.shadowRoot && a.shadowRoot.activeElement; i++) a = a.shadowRoot.activeElement; return a; };
  const __isFrame = (el) => /^(IFRAME|FRAME)$/.test(el.tagName);
  const __textOf = (e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').toLowerCase();
  const __pick = (root, sel, pick) => { const f = (l) => pick.text === null || pick.text === undefined ? l : l.filter((e) => __textOf(e).includes(String(pick.text).toLowerCase()));
    let l = f(__qa(root, sel)); if (!l.length && pick.text !== null && pick.text !== undefined) l = f(__all(root, sel));
    if (pick.index !== null && pick.index !== undefined) l = l[pick.index] ? [l[pick.index]] : []; return l; };
`;

// Walk a list of CSS segments inside ONE target, crossing same-origin frames and shadow hosts in JS and stopping
// at a cross-origin frame so the caller can hop targets.
export const WALK = (segs, pick = null) => `(() => {
  const segs = ${JSON.stringify(segs)}; const pick = ${JSON.stringify(pick)};${DEEP}
  const info = (el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const out = {tag: el.tagName, id: el.id || null, name: el.getAttribute('name') || null, type: el.getAttribute('type') || null,
      src: el.getAttribute('src') || null, value: (el.value === undefined || el.value === null) ? null : String(el.value),
      text: (el.innerText || '').trim().slice(0, 80) || null, disabled: !!el.disabled, ariaInvalid: el.getAttribute('aria-invalid'),
      visible: !(cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || (r.width === 0 && r.height === 0)),
      rect: {x: r.x, y: r.y, w: r.width, h: r.height}};
    if (__isFrame(el)) out.contentOffset = {x: (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
      y: (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)};
    return out;
  };
  let doc = document, root = document, offX = 0, offY = 0; const crumbs = [];
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1; let matches;
    try { matches = (last && pick) ? __pick(root, segs[i], pick) : __qa(root, segs[i]); } catch (e) { return {status: 'badselector', index: i, selector: segs[i], message: String(e.message || e)}; }
    if (!matches.length) { let frames = []; try { frames = __all(root, 'iframe, frame').slice(0, 12).map(info); } catch (e) {}
      return {status: 'missing', index: i, selector: segs[i], frames: frames, pick: (last && pick) ? pick : null}; }
    if (matches.length > 1) return {status: 'ambiguous', index: i, selector: segs[i], count: matches.length, candidates: [...matches].slice(0, 12).map(info)};
    const el = matches[0];
    const view = {w: doc.defaultView.innerWidth, h: doc.defaultView.innerHeight, sx: doc.defaultView.scrollX, sy: doc.defaultView.scrollY};
    if (last) { window.__tophatCdpEl = el; let picked = null;
      if (pick) { try { for (const old of __all(doc, '[data-tophat-pick]')) if (old !== el) old.removeAttribute('data-tophat-pick'); } catch (e) {}
        const tag = 'p' + Math.random().toString(36).slice(2, 10); el.setAttribute('data-tophat-pick', tag); picked = '[data-tophat-pick="' + tag + '"]'; }
      return {status: 'ok', index: i, offsetX: offX, offsetY: offY, element: info(el), crumbs: crumbs, view: view, picked: picked,
        active: doc.activeElement === el || __active(doc) === el}; }
    if (!__isFrame(el)) {
      if (el.shadowRoot) { crumbs.push({selector: segs[i], id: el.id || null, name: el.getAttribute('name') || null, shadow: true}); root = el.shadowRoot; continue; }
      return {status: 'notframe', index: i, selector: segs[i], tag: el.tagName};
    }
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const ox = r.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const oy = r.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    let inner = null; try { inner = el.contentDocument; } catch (e) { inner = null; }
    crumbs.push({selector: segs[i], id: el.id || null, name: el.getAttribute('name') || null, sameOrigin: !!inner});
    if (!inner) { window.__tophatCdpFrameEl = el; return {status: 'frame', index: i, offsetX: offX + ox, offsetY: offY + oy, element: info(el), crumbs: crumbs, view: view}; }
    offX += ox; offY += oy; doc = inner; root = inner;
  }
})()`;
// innermost first, behavior:'instant' (a smooth-scrolling container keeps moving after scrollIntoView returns)
const SCROLL = (segs) => `(() => {
  const segs = ${JSON.stringify(segs)};${DEEP}
  let root = document; const path = [];
  for (let i = 0; i < segs.length; i++) { let el = null; try { el = __q1(root, segs[i]); } catch (e) {} if (!el) break; path.push(el);
    if (i === segs.length - 1) break;
    if (!__isFrame(el)) { if (!el.shadowRoot) break; root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {} if (!inner) break; root = inner; }
  const scrolled = [];
  for (let i = path.length - 1; i >= 0; i--) { try { path[i].scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); }
    catch (e) { try { path[i].scrollIntoView(true); } catch (e2) {} } scrolled.push(path[i].tagName + (path[i].id ? '#' + path[i].id : '')); }
  return {depth: path.length, scrolled: scrolled, windowScrollY: window.scrollY, docHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight};
})()`;
// elementFromPoint stops at the outermost shadow host, so the hit is drilled through open shadow roots and
// containment is checked across them (composed), or every element inside an LWC component reads as covered.
const HIT = (segs, x, y) => `(() => {
  const segs = ${JSON.stringify(segs)}; let x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};${DEEP}
  const name = (el) => el ? (el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')) : null;
  let doc = document, root = document;
  for (let i = 0; i < segs.length; i++) {
    let el = null; try { el = __q1(root, segs[i]); } catch (e) {}
    if (!el) return {ok: false, reason: 'missing', index: i, selector: segs[i]};
    const hit = __hitAt(doc, x, y); const ok = hit === el || __within(el, hit) || (hit && __within(hit, el));
    if (!ok) {
      // Clipped, not covered: an ancestor with overflow other than visible does not contain the point, so whatever
      // is painted there belongs to the next section. Scrolling cannot fix that; expanding the container can.
      let clippedBy = null;
      for (let a = __up(el); a && a.nodeType === 1; a = __up(a)) { let cs = null; try { cs = getComputedStyle(a); } catch (e) {} if (!cs) continue;
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const b = a.getBoundingClientRect();
        if (x < b.left || x > b.right || y < b.top || y > b.bottom) { clippedBy = {name: name(a), w: Math.round(b.width), h: Math.round(b.height), overflow: cs.overflowY}; break; } }
      return {ok: false, reason: clippedBy ? 'clipped' : 'covered', index: i, selector: segs[i], x: x, y: y, hit: name(hit), want: name(el), clippedBy: clippedBy};
    }
    if (i === segs.length - 1) return {ok: true, index: i, hit: name(hit)};
    if (!__isFrame(el) && el.shadowRoot) { root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {}
    if (!inner) return {ok: true, index: i, crossOrigin: true, hit: name(hit)};
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    x -= r.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0); y -= r.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0); doc = inner; root = inner;
  }
  return {ok: true};
})()`;
// Every iframe in a target, shadow roots included, with a selector that resolves back to exactly that element
// under the same light-first rule WALK uses; when nothing unique exists document-wide, the shadow host chain is
// spelled out with >>> (host >>> host >>> iframe).
const FRAME_LIST = `(() => {
  const out = [], store = [];${DEEP}
  const uniq = (scope, sel, el) => { try { const m = __qa(scope, sel); return m.length === 1 && m[0] === el; } catch (e) { return false; } };
  const pathIn = (el) => {
    const parts = []; let node = el;
    while (node && node.nodeType === 1) { const parent = node.parentElement; if (!parent) break;
      const kin = [...parent.children].filter((c) => c.tagName === node.tagName); const idx = kin.indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + (kin.length > 1 ? ':nth-of-type(' + idx + ')' : '')); node = parent; if (parts.length > 6) break; }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const cssFor = (el, doc, depth) => {
    const tag = el.tagName.toLowerCase(), c = [];
    if (el.id) c.push('#' + CSS.escape(el.id));
    const nm = el.getAttribute('name'); if (nm) c.push(tag + '[name="' + CSS.escape(nm) + '"]');
    const p = pathIn(el); c.push(p);
    for (const a of ['title', 'src']) { const v = el.getAttribute(a); if (v) c.push(tag + '[' + a + '="' + CSS.escape(v) + '"]'); }
    for (const s of c) if (uniq(doc, s, el)) return s;
    const root = el.getRootNode();
    if (depth < 8 && root && root !== doc && root.host) return cssFor(root.host, doc, depth + 1) + ' >>> ' + (c.find((s) => uniq(root, s, el)) || p);
    return p;
  };
  const walk = (doc, prefix, depth) => {
    if (depth > 4) return; let frames = []; try { frames = __all(doc, 'iframe, frame'); } catch (e) { return; }
    for (const el of frames) {
      const sel = cssFor(el, doc, 0); const full = prefix ? prefix + ' >>> ' + sel : sel; const r = el.getBoundingClientRect(); store.push(el);
      let inner = null; try { inner = el.contentDocument; } catch (e) {}
      out.push({selector: full, id: el.id || null, name: el.getAttribute('name') || null, src: el.getAttribute('src') || null, title: el.getAttribute('title') || null,
        rect: {x: r.x, y: r.y, w: r.width, h: r.height}, visible: r.width > 0 && r.height > 0, sameOrigin: !!inner, shadow: el.getRootNode() !== doc, index: store.length - 1});
      if (inner) walk(inner, full, depth + 1);
    }
  };
  walk(document, '', 0); window.__tophatCdpFrameList = store; return out;
})()`;
// the embedding page's validation text for a field, stopping before an ancestor that holds a second field
const FIELD_ERROR = (segs) => `(() => {
  const segs = ${JSON.stringify(segs)};${DEEP}
  let root = document, el = null;
  for (let i = 0; i < segs.length; i++) { let next = null; try { next = __q1(root, segs[i]); } catch (e) {} if (!next) break; el = next;
    if (i === segs.length - 1) break;
    if (!__isFrame(el)) { if (!el.shadowRoot) break; root = el.shadowRoot; continue; }
    let inner = null; try { inner = el.contentDocument; } catch (e) {} if (!inner) break; root = inner; }
  if (!el) return {found: false, messages: []};
  const SEL = '[role="alert"], [aria-live], .error, .field-error, [class*="error" i], [id*="error" i], [data-error], .invalid, [class*="invalid" i]';
  const seen = []; let node = el;
  for (let up = 0; up < 3 && node; up++) {
    node = __up(node); if (!node || node.nodeType !== 1) break;
    let fields = []; try { fields = __all(node, 'iframe, frame, input, select, textarea'); } catch (e) {} if (fields.length > 1) break;
    let hits = []; try { hits = __all(node, SEL); } catch (e) {}
    for (const h of hits) { if (__within(h, el)) continue; const text = (h.innerText || h.textContent || '').trim(); if (!text) continue;
      const cs = getComputedStyle(h); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const t = text.slice(0, 200); if (seen.indexOf(t) === -1) seen.push(t); }
    if (seen.length) break;
  }
  return {found: seen.length > 0, messages: seen.slice(0, 3), ariaInvalid: el.getAttribute('aria-invalid'), element: el.tagName + (el.id ? '#' + el.id : '')};
})()`;

async function frameIdOf(conn, expression = 'window.__tophatCdpFrameEl') {
  const h = await conn.send('Runtime.evaluate', { expression, returnByValue: false });
  const objectId = h.result?.objectId;
  if (!objectId) throw new CdpError('could not take a handle on the embedding iframe element', 'target_not_found');
  try { await conn.send('DOM.getDocument', { depth: 0 }); } catch {}
  const frameId = (await conn.send('DOM.describeNode', { objectId }))?.node?.frameId;
  if (!frameId) throw new CdpError('DOM.describeNode returned no frameId for the iframe element (it may have navigated mid-call; retry)', 'target_not_found');
  return frameId;
}


// A frame that is not a CDP target (cross-origin but same-SITE as its embedder: Chrome keeps it in the embedder's
// renderer, so there is no /devtools/page/<id> for it and contentDocument is null) is reached through its Runtime
// execution context on the nearest ancestor target's socket. A virtual target id is `ROOTTARGET@FRAMEID`;
// Resolver.conn() hands back a FrameConn for it.
export const VSEP = '@';
export const isVirtual = (id) => String(id || '').includes(VSEP);
export const rootOf = (id) => String(id || '').split(VSEP)[0];
export const frameOf = (id) => String(id || '').split(VSEP).slice(1).pop();
export const virtualId = (cur, frameId) => `${rootOf(cur)}${VSEP}${frameId}`;

/** The default-world execution context of frameId on this socket (Runtime.enable replays existing contexts). */
export async function contextFor(conn, frameId, timeout = 3000) {
  if (!conn.send || !conn.events) throw new CdpError('a same-process iframe needs a direct DevTools socket on its page; the passkey keeper proxy cannot see execution contexts (detach it, or use a frame target)', 'target_not_found');
  if (!conn.__runtimeEnabled) { await conn.send('Runtime.enable'); conn.__runtimeEnabled = true; }
  const want = String(frameId).toUpperCase(), until = Date.now() + timeout;
  for (;;) {
    let id = null;
    for (const e of conn.events) {
      if (e.method === 'Runtime.executionContextsCleared') id = null;
      else if (e.method === 'Runtime.executionContextCreated') {
        const c = e.params?.context, aux = c?.auxData || {};
        if (String(aux.frameId || '').toUpperCase() === want && aux.isDefault !== false && !(aux.type && aux.type !== 'default')) id = c.id;
      } else if (e.method === 'Runtime.executionContextDestroyed' && e.params?.executionContextId === id) id = null;
    }
    if (id !== null) return id;
    if (Date.now() >= until) throw new CdpError(`no execution context for frame ${frameId} on its embedding page; the frame may still be loading (retry) or have navigated away`, 'target_not_found');
    await sleep(60);
  }
}

/** A socket-shaped wrapper whose Runtime.evaluate runs in one frame's execution context. */
export class FrameConn {
  constructor(base, frameId) { Object.assign(this, { base, frameId }); }
  get events() { return this.base.events; }
  async send(method, params = {}, timeout) {
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn' && !params.objectId) params = { ...params, contextId: await contextFor(this.base, this.frameId) };
    try { return await this.base.send(method, params, timeout); }
    catch (e) {
      // the context id changes when the frame navigates; one retry with a fresh lookup
      if (/context|Cannot find/i.test(String(e.message)) && params.contextId !== undefined) { await sleep(150); return this.base.send(method, { ...params, contextId: await contextFor(this.base, this.frameId) }, timeout); }
      throw e;
    }
  }
  focusEmulation(e) { return this.base.focusEmulation(e); }
  close() {}
}

/** Resolves frame-piercing chains, one socket per target; close() when done. */
export class Resolver {
  constructor(endpoint, timeout = 20) { Object.assign(this, { endpoint, timeout, conns: new Map(), map: null }); }
  async targets(refresh = false) {
    if (!this.map || refresh) this.map = new Map((await listTargets(this.endpoint)).map((t) => [t.id, t]));
    return this.map;
  }
  async target(id, refresh = false) {
    if (isVirtual(id)) return { id, type: 'frame', url: '(same-process frame)', parentId: rootOf(id) };
    return (await this.targets(refresh)).get(id) || (refresh ? undefined : (await this.targets(true)).get(id)); }
  async conn(id) {
    if (isVirtual(id)) {
      if (!this.conns.has(id)) this.conns.set(id, (async () => new FrameConn(await this.conn(rootOf(id)), frameOf(id)))());
      return this.conns.get(id);
    }
    if (!this.conns.has(id)) this.conns.set(id, openTargetConn(this.endpoint, (await this.target(id)) || { id, type: 'page', url: '' }, this.timeout));
    return this.conns.get(id);
  }
  async close() { for (const p of this.conns.values()) { try { (await p).close(); } catch {} } this.conns.clear(); }
  async ev(id, js) { return (await evaluate(await this.conn(id), js)).value; }

  async frameMap(id) {
    const conn = await this.conn(id), rows = (await evaluate(conn, FRAME_LIST)).value || [], live = await this.targets(true);
    for (const r of rows) {
      try { r.frameId = await frameIdOf(conn, `window.__tophatCdpFrameList[${r.index}]`); } catch { r.frameId = null; }
      r.targetId = live.has(r.frameId) ? r.frameId : null;
      if (r.targetId) r.frameUrl = live.get(r.targetId).url;
      delete r.index;
    }
    return rows;
  }
  async frameTree(id, depth = 3, prefix = '') {
    const rows = [];
    for (const r0 of await this.frameMap(id)) {
      const r = { ...r0, selector: prefix ? `${prefix} >>> ${r0.selector}` : r0.selector, parentTargetId: id };
      rows.push(r);
      if (depth > 1) {
        if (r.targetId) rows.push(...await this.frameTree(r.targetId, depth - 1, r.selector));
        else if (r.frameId && !r.sameOrigin) { r.sameProcess = true; try { rows.push(...await this.frameTree(virtualId(id, r.frameId), depth - 1, r.selector)); } catch {} }
      }
    }
    return rows;
  }
  async selectorForFrame(parentId, frameId) {
    const same = (r) => String(r.frameId || '').toUpperCase() === String(frameId || '').toUpperCase();
    // a frame nested under a same-process cross-origin frame is not in the parent's own map: search the whole tree
    const hit = (await this.frameMap(parentId)).find(same) || (await this.frameTree(parentId, 4)).find(same);
    if (!hit) throw new CdpError(`could not find the <iframe> element that embeds target ${frameId} inside its parent ${parentId}`, 'target_not_found');
    return hit.selector;
  }
  /** [page target, [iframe selectors]] for any target, frame or page. */
  async pageChain(target) {
    const hops = [];
    let cur = target;
    for (let n = 0; (cur.type || 'page') !== 'page'; n++) {
      const parent = cur.parentId ? await this.target(cur.parentId) : null;
      if (!parent) throw new CdpError(`target ${cur.id} (${(cur.url || '').slice(0, 60)}) is a ${cur.type} with no reachable embedding page; name the page and a \`IFRAME_CSS >>> ELEMENT_CSS\` selector instead`, 'target_not_found');
      hops.unshift(await this.selectorForFrame(parent.id, cur.id));
      cur = parent;
      if (n >= 8) throw new CdpError('frame nesting deeper than 8 while walking up to a page', 'target_not_found');
    }
    return [cur, hops];
  }
  async resolve(target, selector, pick = null) {
    const [page, implicit] = await this.pageChain(target);
    const pending = [...implicit.flatMap(splitSelector), ...splitSelector(selector)];
    const hops = [];
    let bx = 0, by = 0, index = 0, cur = page.id;
    for (;;) {
      let segments = pending.slice(index);
      const walk = (await evaluate(await this.conn(cur), WALK(segments, pick))).value || {};
      if (walk.status === 'ok') { if (walk.picked) segments = [...segments.slice(0, -1), walk.picked]; hops.push({ targetId: cur, segments, baseX: bx, baseY: by, walk }); break; }
      if (walk.status !== 'frame') await this.raiseWalk(walk, pending, index, cur);
      const taken = walk.index + 1;
      hops.push({ targetId: cur, segments: pending.slice(index, index + taken), baseX: bx, baseY: by, walk });
      const frameId = await frameIdOf(await this.conn(cur));
      // a live target is an OOPIF with its own socket; anything else is a same-process cross-origin frame, reached
      // through its execution context on the owning target's socket (virtual id ROOT@FRAMEID)
      const next = (await this.targets(true)).has(frameId) ? frameId : virtualId(cur, frameId);
      if (isVirtual(next)) { try { await contextFor(await this.conn(rootOf(cur)), frameId); } catch (e) { throw new CdpError(`the frame at ${pyRepr(pending[index + walk.index])} (frameId ${frameId}) is neither a live target nor a frame with an execution context on its embedding page: ${e.message}`, 'target_not_found'); } }
      bx += Number(walk.offsetX || 0); by += Number(walk.offsetY || 0); cur = next; index += taken;
    }
    const last = hops.at(-1), el = last.walk.element, r = el.rect;
    const x = last.baseX + Number(last.walk.offsetX || 0) + r.x, y = last.baseY + Number(last.walk.offsetY || 0) + r.y;
    return { page, hops, selector, element: el, ownerTargetId: last.targetId, x, y, centerX: x + r.w / 2, centerY: y + r.h / 2, width: r.w, height: r.h,
      view: hops[0].walk.view || {}, active: last.walk.active, canonicalSelector: hops.flatMap((h) => h.segments).join(` ${FRAME_SEP} `) };
  }
  async raiseWalk(walk, pending, index, cur) {
    const selector = walk.selector || pending[index] || '';
    const where = `${cur} (${((await this.target(cur))?.url || '').slice(0, 60)})`;
    const s = walk.status;
    if (s === 'ambiguous') {
      const lines = (walk.candidates || []).map((c) => `  ${(c.tag || '?').toLowerCase()}${c.id ? `#${c.id}` : ''}${c.name ? ` name=${c.name}` : ''}${c.src ? ` src=${c.src.slice(0, 70)}` : ''}`);
      throw new CdpError(`ambiguous selector ${pyRepr(selector)} in ${where}: ${walk.count || 0} elements match. Name one of them:\n${lines.join('\n')}`, 'target_not_found');
    }
    if (s === 'missing') {
      const f = walk.frames || [];
      const hint = f.length ? `\n  iframes in that document: ${f.slice(0, 10).map((x) => `${(x.tag || 'iframe').toLowerCase()}${x.id ? `#${x.id}` : x.name ? ` name=${x.name}` : ''}`).join(', ')}\n  (run \`tophat-cdp frame-map\` for ready-made selectors)` : '';
      const picked = walk.pick ? ` with${walk.pick.text != null ? ` text containing ${pyRepr(walk.pick.text)}` : ''}${walk.pick.index != null ? ` at index ${walk.pick.index}` : ''}` : '';
      throw new CdpError(`no element matches ${pyRepr(selector)}${picked} in ${where} (open shadow roots searched too)${hint}`, 'target_not_found');
    }
    if (s === 'notframe') throw new CdpError(`${pyRepr(selector)} in ${where} is a <${(walk.tag || '?').toLowerCase()}>, neither an iframe nor an open shadow host, so nothing can be addressed through it`, 'usage');
    if (s === 'badselector') throw new CdpError(`invalid CSS selector ${pyRepr(selector)}: ${walk.message}`, 'usage');
    throw new CdpError(`could not resolve ${pyRepr(selector)} in ${where} (walk returned ${pyRepr(s)})`, 'target_not_found');
  }
  inView(c, m = 2) {
    const { w, h } = c.view || {};
    return !!w && !!h && c.width > 0 && c.height > 0 && c.x >= -m && c.y >= -m && c.x + c.width <= w + m && c.y + c.height <= h + m;
  }
  async locate(target, selector, { scroll = true, passes = 4, settle = 120, pick = null } = {}) {
    let c = await this.resolve(target, selector, pick);
    c.scrolled = false;
    if (!scroll) return c;
    for (let p = 0; p < passes && !this.inView(c); p++) {
      for (const hop of [...c.hops].reverse()) await evaluate(await this.conn(hop.targetId), SCROLL(hop.segments));
      let prev = null;
      for (let s = 0; s < 8; s++) {
        await sleep(settle);
        c = await this.resolve(target, selector, pick); c.scrolled = true;
        const here = `${Math.round(c.x * 10)},${Math.round(c.y * 10)}`;
        if (here === prev) break;
        prev = here;
      }
    }
    return c;
  }
  async hitTest(c, x = c.centerX, y = c.centerY) {
    for (const hop of c.hops) {
      const r = (await evaluate(await this.conn(hop.targetId), HIT(hop.segments, x - hop.baseX, y - hop.baseY))).value || {};
      if (!r.ok) return { ...r, targetId: hop.targetId, pageX: x, pageY: y };
    }
    return { ok: true, x, y };
  }
  /** In the viewport is not the same as reachable: a sticky footer or header can sit over an element that
   * locate() left alone because its rect was already inside the viewport. When the hit test says covered,
   * centre the element once more and re-measure. A clipped element (inside a collapsed container) is returned
   * as is: scrolling cannot open it.
   */
  async uncover(target, selector, c, { pick = null, settle = 120, scroll = true } = {}) {
    if (!scroll) return c;
    const h = await this.hitTest(c);
    if (h.ok || h.reason !== 'covered') return c;
    for (const hop of [...c.hops].reverse()) await evaluate(await this.conn(hop.targetId), SCROLL(hop.segments));
    let prev = null;
    for (let s = 0; s < 8; s++) {
      await sleep(settle);
      c = await this.resolve(target, selector, pick); c.scrolled = true; c.uncovered = true;
      const here = `${Math.round(c.x * 10)},${Math.round(c.y * 10)}`;
      if (here === prev) break;
      prev = here;
    }
    return c;
  }
  async requireHit(c, what = 'click') {
    const h = await this.hitTest(c);
    if (h.ok) return h;
    const f = (n) => Math.round(n ?? 0);
    const why = h.clippedBy ? ` The element is clipped by ${h.clippedBy.name} (overflow ${h.clippedBy.overflow}, ${h.clippedBy.w}x${h.clippedBy.h}), which does not contain that point: it sits inside a collapsed or scrolled-away container, so expand or open that section first.` : '';
    throw new CdpError(`refusing to ${what} ${pyRepr(c.selector)}: the hit test at page coordinates ${f(h.pageX)},${f(h.pageY)} does not reach it. At segment ${pyRepr(h.selector)} the point is on ${h.hit || 'nothing'}, not ${h.want || 'it'}. Element rect x=${f(c.x)} y=${f(c.y)} w=${f(c.width)} h=${f(c.height)}, page viewport ${c.view?.w}x${c.view?.h}${c.scrolled ? '' : ' (not scrolled; drop --no-scroll)'}.${why} Nothing was dispatched.`, 'hittest');
  }
  requireInView(c) {
    if (this.inView(c)) return;
    const f = (n) => Math.round(n ?? 0);
    throw new CdpError(`could not bring ${pyRepr(c.selector)} into the page viewport: rect x=${f(c.x)} y=${f(c.y)} w=${f(c.width)} h=${f(c.height)} against viewport ${c.view?.w}x${c.view?.h} after scrolling${c.scrolled ? '' : ' (scrolling was disabled)'}. Nothing was dispatched.`, 'hittest');
  }
  pageConn(c) { return this.conn(c.hops[0].targetId); }
  /** Focus emulation on, then wait until the renderer reports focus (a click in that window moves nothing). */
  async ensurePageFocus(conn, timeout = 500) {
    await conn.focusEmulation(true);
    const until = Date.now() + timeout;
    for (;;) {
      try { if ((await evaluate(conn, 'document.hasFocus()')).value) return true; } catch { return false; }
      if (Date.now() >= until) return false;
      await sleep(30);
    }
  }
  async clickAt(c, { x = c.centerX, y = c.centerY, button = 'left', clicks = 1, focusEmulation = true } = {}) {
    const conn = await this.pageConn(c);
    if (focusEmulation) await this.ensurePageFocus(conn);
    await mouseClick(conn, x, y, button, clicks);
    return { x, y };
  }
  /** Focus fallback: click the owning frame's own widget at frame-local coordinates (nested OOPIF routing gap). */
  async clickInOwner(c, button = 'left', clicks = 1) {
    const conn = await this.conn(c.ownerTargetId), hop = c.hops.at(-1), r = hop.walk.element.rect;
    await conn.focusEmulation(true);
    const x = Number(hop.walk.offsetX || 0) + r.x + r.w / 2, y = Number(hop.walk.offsetY || 0) + r.y + r.h / 2;
    await mouseClick(conn, x, y, button, clicks);
    return { x, y, targetId: c.ownerTargetId };
  }
  async selectAll(c) { await sendSelectAll(await this.pageConn(c)); }
  async insertText(c, text) { await (await this.pageConn(c)).send('Input.insertText', { text }); }
  /** [element, walk] read back from the frame that owns the element; onPassword(value) sees password values. */
  async readBack(c, onPassword) {
    const hop = c.hops.at(-1), walk = (await evaluate(await this.conn(hop.targetId), WALK(hop.segments))).value || {};
    if (walk.status !== 'ok') return [null, walk];
    if (String(walk.element.type || '').toLowerCase() === 'password' && walk.element.value) onPassword?.(walk.element.value);
    return [walk.element, walk];
  }
  async waitFocus(c, timeout = 1000, onPassword) {
    const until = Date.now() + timeout;
    let [el, walk] = await this.readBack(c, onPassword);
    while (!walk.active && Date.now() < until) { await sleep(50); [el, walk] = await this.readBack(c, onPassword); }
    return [el, walk];
  }
  async fieldError(c) { const hop = c.hops[0]; return (await evaluate(await this.conn(hop.targetId), FIELD_ERROR(hop.segments))).value || {}; }
  /** [page target, originX, originY] for an iframe target. */
  async frameOffset(target) {
    const [page, implicit] = await this.pageChain(target);
    if (!implicit.length) return [page, 0, 0];
    const c = await this.resolve(page, implicit.join(` ${FRAME_SEP} `)), o = c.element.contentOffset || { x: 0, y: 0 };
    return [page, c.x + o.x, c.y + o.y];
  }
  /** Same-origin DOM value write through the native setter (--dom-value, plain forms only). */
  async domValue(c, text) {
    const hop = c.hops.at(-1), conn = await this.conn(hop.targetId);
    await evaluate(conn, WALK(hop.segments));
    const t = JSON.stringify(text);
    return (await evaluate(conn, `(()=>{const el=window.__tophatCdpEl;const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,"value");if(d&&d.set){d.set.call(el,${t});}else{el.value=${t};}el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return el.value;})()`)).value;
  }
  describe(c) {
    const r2 = (n) => Math.round(n * 100) / 100;
    return { selector: c.selector, canonicalSelector: c.canonicalSelector, frames: c.hops.map((h) => ({ targetId: h.targetId, segments: h.segments, originX: h.baseX, originY: h.baseY })),
      ownerTargetId: c.ownerTargetId, element: c.element, pageX: r2(c.x), pageY: r2(c.y), centerX: r2(c.centerX), centerY: r2(c.centerY),
      viewport: c.view, inView: this.inView(c), scrolled: c.scrolled || false, focused: c.active };
  }
}
