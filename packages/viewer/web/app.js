// The memory graph, entirely in this tab: the user's memory as a force-directed hypergraph, with entity pages as a modal
// over it. Entities are nodes; each note is ONE hyperedge over its entities (k>=3 drawn as a small hub joined to every
// member and outlined by a hull on hover; k==2 as a plain link). The simulation runs in a Web Worker (/graph/sim.js).
// Data: nothing but ciphertext comes from the network. The key file (opened with the passphrase) holds the scope keys;
// the hub's device pull API returns the sealed log for the token's user; WebCrypto opens it here, a replay builds the
// view, and the graph and pages are built from it locally. The decrypted view and the settled layout are kept in
// IndexedDB sealed under a key derived from the passphrase (or nowhere, when the user unticks "keep"). A revisit asks
// for the passphrase only, paints from that copy at once, then pulls what the log gained since.
import { ViewState, tokenClaims } from '../src/core/state.mjs';
import { pullInto } from '../src/core/pull.mjs';
import { buildGraph, entityPage, plainGraph } from '../src/core/graph.mjs';
import { readKeyFile, cacheKey, sealCache, openCache } from '../src/core/keys.mjs';
import { snapshotView } from '../src/core/snapshot.mjs';

(async function () {
  const $ = (id) => document.getElementById(id);
  const status = $('mg-status');
  const trace = (window.__trace = { frames: [], applyMs: [], runs: 0, t0: performance.now(), paintMs: null, firstPosMs: null });
  const showErr = (m) => { status.textContent = 'error: ' + m; loadBar.done(); };
  window.addEventListener('error', (e) => showErr(e.message));
  window.addEventListener('unhandledrejection', (e) => showErr(String(e.reason && e.reason.message || e.reason)));
  const { Graph, Sigma, louvain } = window.LIBS;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const HUB = ((document.querySelector('meta[name="th-hub"]') || {}).content || location.origin).replace(/\/$/, '');
  // A published snapshot (a public demo, a group's open notes): plaintext the publisher chose to serve, read-only, no lock.
  const PUBLIC = ((document.querySelector('meta[name="th-public"]') || {}).content || '').trim();
  const CACHE_SCHEMA = 1;

  // ---------- loading bar: one thin line, driven by bytes, then a phase label ----------
  const loadBar = (() => {
    const box = $('mg-load'), fill = $('mg-load-fill');
    return {
      set(frac, text) { box.style.display = 'block'; box.classList.toggle('ind', frac == null); if (frac != null) fill.style.width = (100 * Math.max(0.02, Math.min(1, frac))).toFixed(1) + '%'; if (text) status.textContent = text; },
      done() { fill.style.width = '100%'; setTimeout(() => { box.style.display = 'none'; box.classList.remove('ind'); fill.style.width = '0%'; }, 160); },
    };
  })();
  const mb = (n) => (n / 1e6).toFixed(1);

  // ---------- IndexedDB (one object store, one key per viewer) ----------
  const idb = new Promise((res) => {
    try { const r = indexedDB.open('tophat-viewer', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); }
  });
  const idbGet = async (k) => { const db = await idb; if (!db) return null; return new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); };
  const idbPut = async (k, v) => { const db = await idb; if (!db) return; return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); };
  const idbClear = async () => { const db = await idb; if (!db) return; return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = res; t.onerror = res; }); };

  // ---------- the local model: a replay of the decrypted log; the graph and pages are built from it here ----------
  // session: { vs (ViewState), token, ck (cache key, null = memory only) }. A version names the replay position.
  let session = null, built = null, builtAt = -1;
  const versionOf = () => session.vs.cursor + '.' + session.vs.changes;
  const currentGraph = () => { if (!built || builtAt !== session.vs.changes) { built = buildGraph(session.vs); builtAt = session.vs.changes; } return built; };
  async function fetchGraph(since) {
    const v = versionOf();
    if (since && since === v) return { same: true };
    const t0 = performance.now(), g = currentGraph(); trace.buildMs = performance.now() - t0;
    return { version: v, body: plainGraph(g) };
  }
  /** Pull what the log gained since the cursor; progress drives the bar. Returns the pull summary. */
  async function pullHub(progress) {
    const t0 = performance.now();
    const r = await pullInto(session.vs, { hubUrl: HUB, token: session.token, onProgress: (p) => {
      if (!progress) return;
      const frac = p.head ? Math.min(1, p.cursor / p.head) : null;
      progress(frac, p.phase === 'retry' ? 'opening parts that waited for a key' : p.phase === 'restart' ? 'a scope was gained: reading its history' : `pulling ${mb(p.bytes)} MB \u00b7 ${p.cursor}${p.head ? ' / ' + p.head : ''}`);
    } });
    trace.pullMs = performance.now() - t0; trace.pull = r;
    return r;
  }
  async function saveState() {
    if (!session.ck) return;
    const t = performance.now();
    await idbPut('meta', { schema: CACHE_SCHEMA, salt: session.ck.salt, iterations: session.ck.iterations, saved_at: new Date().toISOString() });
    await idbPut('state', await sealCache({ hub: HUB, token: session.token, state: session.vs.toJSON() }, session.ck));
    trace.saveStateMs = performance.now() - t;
  }

  // ---------- regions (type -> area) ----------
  const REGIONS = [
    { label: 'people', color: '#161616', types: ['person', 'agent', 'group'] },
    { label: 'organizations', color: '#8a3512', types: ['organization', 'program', 'course'] },
    { label: 'places & events', color: '#2c5e4c', types: ['place', 'event', 'trip', 'reservation'] },
    { label: 'projects & ideas', color: '#2a4876', types: ['project', 'topic', 'research', 'feature', 'defect', 'system', 'repository', 'concept', 'paper', 'essay', 'book', 'film', 'game'] },
    { label: 'things & services', color: '#7b6420', types: ['product', 'artifact', 'file', 'document', 'software', 'service', 'tool', 'order', 'domain', 'link', 'account', 'subscription', 'equipment', 'machine', 'device', 'component', 'website', 'thread', 'exercise', 'object'] },
    { label: '', color: '#6a6250', types: [] },
  ];
  const regionOf = {}; REGIONS.forEach((r, i) => r.types.forEach((t) => (regionOf[t] = i)));
  const R = 620;
  REGIONS.forEach((r, i) => { if (i === REGIONS.length - 1) { r.x = 0; r.y = 0; return; } const a = -Math.PI / 2 + (i * 2 * Math.PI) / (REGIONS.length - 1); r.x = R * Math.cos(a); r.y = R * Math.sin(a); });

  // ---------- data and topology (re-derived on every mount: a delta re-indexes) ----------
  let data = null, version = null, ents = [], hyper = [], N = 0, idxOf = new Map(), entHyper = [], nbrs = [], hubIdx = [], hubOf = new Map(), pairs = new Map(), graph = null;
  function index(d) {
    data = d; ents = d.nodes; hyper = d.hyper; N = ents.length;
    idxOf = new Map(ents.map((e, i) => [e.id, i]));
    ents.forEach((e) => (e.region = regionOf[e.type] ?? REGIONS.length - 1));
    entHyper = Array.from({ length: N }, () => []);
    hyper.forEach((h, j) => h.m.forEach((i) => entHyper[i].push(j)));
    nbrs = Array.from({ length: N }, () => new Map());
    hyper.forEach((h) => h.m.forEach((a) => h.m.forEach((b) => { if (a !== b) nbrs[a].set(b, (nbrs[a].get(b) || 0) + 1); })));
    hubIdx = []; hubOf = new Map(); pairs = new Map();
    hyper.forEach((h, j) => {
      if (h.k >= 3) { hubOf.set(j, hubIdx.length); hubIdx.push(j); }
      else { const key = h.m[0] + '_' + h.m[1]; if (!pairs.has(key)) pairs.set(key, []); pairs.get(key).push(j); }
    });
  }
  /** Positions for every entity: kept ones from pos (id -> [x,y]); a new one at the mean of its placed neighbours, else near its region. */
  function placement(pos) {
    const xy = new Float32Array(2 * N), have = new Uint8Array(N), fresh = [];
    let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) { const p = pos && pos.get(ents[i].id); if (p) { xy[2 * i] = p[0]; xy[2 * i + 1] = p[1]; have[i] = 1; } else fresh.push(i); }
    for (let pass = 0; pass < 3; pass++) for (const i of fresh) {
      if (have[i]) continue; let x = 0, y = 0, c = 0;
      nbrs[i].forEach((_, b) => { if (have[b]) { x += xy[2 * b]; y += xy[2 * b + 1]; c++; } });
      if (c) { const a = rnd() * 6.283; xy[2 * i] = x / c + 14 * Math.cos(a); xy[2 * i + 1] = y / c + 14 * Math.sin(a); have[i] = 2; }
    }
    for (const i of fresh) if (!have[i]) { const r = REGIONS[ents[i].region], a = rnd() * 6.283, d = 40 + rnd() * 130; xy[2 * i] = r.x * 0.5 + d * Math.cos(a); xy[2 * i + 1] = r.y * 0.5 + d * Math.sin(a); }
    return { xy, fresh, kept: N - fresh.length };
  }
  const hubXY = (j, xy) => { const m = hyper[j].m; let x = 0, y = 0; for (const i of m) { x += xy[2 * i]; y += xy[2 * i + 1]; } return [x / m.length, y / m.length]; };
  const sizeOf = (n) => Math.min(20, 2.8 + 2.1 * Math.sqrt(n));
  function makeGraph(xy) {
    const g = new Graph({ type: 'undirected', multi: false });
    ents.forEach((e, i) => g.addNode('e' + i, { label: e.name, size: sizeOf(e.n), color: REGIONS[e.region].color, x: xy[2 * i], y: xy[2 * i + 1], ent: true, zIndex: 2 }));
    hubIdx.forEach((j, k) => { const [x, y] = hubXY(j, xy); g.addNode('h' + k, { label: '', size: 1.8 + Math.min(2, hyper[j].k * 0.12), color: '#a2946a', x, y, hub: true, hj: j, zIndex: 1 }); });
    hubIdx.forEach((j, k) => hyper[j].m.forEach((i) => g.addEdge('h' + k, 'e' + i, { size: 0.5, color: 'rgba(90,70,30,0.13)', spoke: true, hj: j, s: 'h' + k, t: 'e' + i })));
    pairs.forEach((hs, key) => { const [a, b] = key.split('_'); g.addEdge('e' + a, 'e' + b, { size: 0.6 + 0.5 * Math.log2(hs.length + 1), color: 'rgba(60,45,20,0.28)', pair: key, s: 'e' + a, t: 'e' + b }); });
    return g;
  }

  // ---------- state ----------
  // mode: plain | regions | community | local | time. vis: Set of visible node keys, or null (all).
  const st = { hoverNode: null, hoverEdge: null, sel: null, mode: 'plain', vis: null, liveHyper: null, livePairs: null, t0: null, t1: null };
  const hyperLive = (j) => !st.liveHyper || st.liveHyper.has(j);
  const highlight = () => {
    const hov = st.hoverNode || st.hoverEdge; if (!st.sel && !hov) return null;
    const out = { nodes: new Set(), hulls: [], strong: null };
    const useHyper = (j, strong) => { if (!hyperLive(j)) return; hyper[j].m.forEach((i) => out.nodes.add('e' + i)); if (strong) out.strong = j; if (hyper[j].k >= 3) out.nodes.add('h' + hubOf.get(j)); };
    const one = (f, strong) => {
      if (f.kind === 'e') { out.nodes.add('e' + f.id); entHyper[f.id].filter(hyperLive).slice(-60).forEach((j) => { useHyper(j, false); if (hyper[j].k >= 3) out.hulls.push(j); }); }
      else if (f.kind === 'h') { useHyper(f.id, strong); out.hulls.push(f.id); }
      else if (f.kind === 'p') pairs.get(f.id).forEach((j) => useHyper(j, false));
    };
    one(st.sel || hov, true);
    if (st.sel && hov && (hov.kind !== st.sel.kind || hov.id !== st.sel.id)) one(hov, true);
    out.hulls = out.hulls.slice(-60); out.hullSet = new Set(out.hulls);
    return out;
  };

  const container = $('mg-canvas');
  const hullCanvas = el('canvas'); hullCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  let sigma = null, tintColors = null, hl = null, hctx = null;
  const palette = ['#8c2f1b', '#1f4e79', '#2f6b3b', '#8a6d1a', '#6b2f7a', '#1a6b6b', '#a14b6e', '#4b4b9a', '#6b6b1a', '#a1511a', '#2f4f4f', '#7a2f2f'];
  // visibility of a node / edge under the current filter (also used to diff two filters)
  const nodeHidden = (key, vis) => Boolean(vis && !vis.has(key));
  const edgeHidden = (a, vis, live, livePairs) => (vis && (!vis.has(a.s) || !vis.has(a.t))) || (live && (a.spoke ? !live.has(a.hj) : !livePairs.has(a.pair)));
  // sigma 4 marks a renderer with reducers as depending on graph state, so every pan, zoom or hover start/stop
  // (isPanning, isZooming, hasHovered) re-runs both reducers over all ~35k nodes and edges: the 150-300 ms stalls on
  // select, hover and mode switch. Our reducers read only this page's state and every change of it repaints exactly
  // the items it touched (refocus, refreshVisibility), so per-item dirty tracking is enough.
  const unhookGraphState = (s) => {
    if (s.internals && s.internals.nodeStyleAnalysis) s.internals.nodeStyleAnalysis.dependency = 'item-state';
    if (s.edgeStyleAnalysis) s.edgeStyleAnalysis.dependency = 'item-state';
  };
  const makeSigma = () => {
    const s = new Sigma(graph, container, {
      renderEdgeLabels: false, enableEdgeEvents: true, zIndex: true,
      labelFont: 'ui-monospace, Menlo, monospace', labelSize: 11, labelColor: { color: '#111' },
      labelDensity: 0.7, labelGridCellSize: 100, labelRenderedSizeThreshold: 7,
      defaultEdgeColor: 'rgba(90,70,30,0.13)', minCameraRatio: 0.015, maxCameraRatio: 6, hideEdgesOnMove: false,
      defaultDrawNodeHover: (ctx, d) => { ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#111'; if (d.label) ctx.fillText(d.label, d.x + d.size + 3, d.y + 4); },
      nodeReducer: (key, a) => {
        if (!hl && !st.vis && st.mode !== 'community') return a;
        const o = { ...a };
        if (a.ent && st.mode === 'community' && tintColors) o.color = tintColors[key] || '#a89d7e';
        if (st.vis && !st.vis.has(key)) { o.hidden = true; o.label = ''; return o; }
        if (hl && hl.nodes.has(key)) { o.zIndex = 3; if (a.ent) o.forceLabel = true; if (a.hub) { o.color = '#3a2f12'; o.size = a.size + 1.2; } }
        return o;
      },
      edgeReducer: (key, a) => {
        if (!hl && !st.vis && !st.liveHyper) return a;
        if (edgeHidden(a, st.vis, st.liveHyper, st.livePairs)) return { ...a, hidden: true };
        if (hl && hl.nodes.has(a.s) && hl.nodes.has(a.t) && (a.spoke ? hl.hullSet.has(a.hj) || hl.strong === a.hj : true)) return { ...a, color: 'rgba(30,22,5,0.65)', size: a.size + 0.7, zIndex: 2 };
        return a;
      },
    });
    const BB = R + 330; s.setCustomBBox({ x: [-BB, BB], y: [-BB, BB] });
    unhookGraphState(s);
    container.appendChild(hullCanvas); hctx = hullCanvas.getContext('2d');
    return s;
  };

  // ---------- hulls ----------
  const hullOf = (pts) => {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  };
  const drawHull = (j, strong) => {
    const pts = [];
    for (const i of hyper[j].m) {
      const k = 'e' + i; if (st.vis && !st.vis.has(k)) continue;
      const a = graph.getNodeAttributes(k), v = sigma.graphToViewport({ x: a.x, y: a.y });
      const pad = 12 + a.size * 0.8;
      for (let t = 0; t < 10; t++) pts.push([v.x + pad * Math.cos(t * 0.6283), v.y + pad * Math.sin(t * 0.6283)]);
    }
    if (pts.length < 6) return;
    const hp = hullOf(pts);
    hctx.beginPath(); hp.forEach((p, n) => (n ? hctx.lineTo(p[0], p[1]) : hctx.moveTo(p[0], p[1]))); hctx.closePath();
    hctx.fillStyle = strong ? 'rgba(138,53,18,0.16)' : 'rgba(60,45,20,0.07)'; hctx.fill();
    hctx.lineJoin = 'round'; hctx.lineWidth = strong ? 1.6 : 1; hctx.strokeStyle = strong ? 'rgba(138,53,18,0.85)' : 'rgba(60,45,20,0.35)'; hctx.stroke();
  };
  const drawHulls = () => {
    if (!hctx) return;
    const dpr = window.devicePixelRatio || 1, w = container.clientWidth, h = container.clientHeight;
    if (hullCanvas.width !== Math.round(w * dpr) || hullCanvas.height !== Math.round(h * dpr)) { hullCanvas.width = Math.round(w * dpr); hullCanvas.height = Math.round(h * dpr); }
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0); hctx.clearRect(0, 0, w, h);
    if (!hl) return;
    hl.hulls.forEach((j) => { if (j !== hl.strong) drawHull(j, false); });
    if (hl.strong != null) drawHull(hl.strong, true);
  };
  const rl = $('mg-regions'), rlSpans = REGIONS.filter((r) => r.label).map((r) => { const s = el('span', null, r.label); rl.appendChild(s); return [r, s]; });
  const placeRegionLabels = () => rlSpans.forEach(([r, s]) => {
    if (st.mode !== 'regions') { s.style.display = 'none'; return; }
    const v = sigma.graphToViewport({ x: r.x, y: r.y - 215 }); s.style.display = ''; s.style.left = v.x + 'px'; s.style.top = v.y + 'px';
  });

  // ---------- simulation (worker) ----------
  const worker = new Worker('/graph/sim.js');
  let latest = null, settled = true, rafPending = false, gen = 0, lastT = 0, onSettle = null;
  const apply = (t) => {
    rafPending = false;
    if (!latest) return;
    const t0 = performance.now(), xy = latest; latest = null;
    // Positions go in place into the graph attributes (read by hulls) and sigma's raw coordinate cache, then one
    // processNodes + render: edges read node positions from sigma's node texture, so they follow without reprocessing.
    const gc = sigma.nodeGraphCoords;
    const put = (key, x, y) => { const a = graph.getNodeAttributes(key); a.x = x; a.y = y; const c = gc[key]; if (c) { c.x = x; c.y = y; } };
    for (let i = 0; i < N; i++) put('e' + i, xy[2 * i], xy[2 * i + 1]);
    hubIdx.forEach((j, k) => { const [x, y] = hubXY(j, xy); put('h' + k, x, y); });
    sigma.processNodes(); sigma.render();
    if (trace.frames.length < 4000) { trace.frames.push(lastT ? +(t - lastT).toFixed(1) : 0); trace.applyMs.push(+(performance.now() - t0).toFixed(1)); }
    lastT = t;
    if (!settled) worker.postMessage({ type: 'next' });
  };
  worker.onmessage = ({ data: m }) => {
    if (m.type !== 'pos' || m.gen !== gen) return; // a frame from before the last mount
    if (m.tickMs != null) trace.tickMs = m.tickMs;
    latest = m.xy; settled = m.settled;
    if (trace.firstPosMs == null) trace.firstPosMs = performance.now() - trace.t0;
    if (!rafPending) { rafPending = true; requestAnimationFrame(apply); }
    if (m.settled) { setStatus(); if (onSettle) onSettle(); }
  };
  const initWorker = (xy) => {
    gen++;
    worker.postMessage({ type: 'init', gen, n: ents.map((e) => e.n), region: ents.map((e) => e.region), anchors: REGIONS.map((r) => [r.x, r.y]), xy: Array.from(xy),
      links: [...pairs.entries()].map(([key, hs]) => { const [a, b] = key.split('_').map(Number); return [a, b, hs.length]; }), hubs: hubIdx.map((j) => hyper[j].m) });
  };
  const visibleEnts = () => (st.vis ? [...st.vis].filter((k) => k[0] === 'e').map((k) => +k.slice(1)) : null);
  const run = (alpha, extra = {}) => { settled = false; trace.runs++; worker.postMessage({ type: 'run', subset: visibleEnts(), mode: st.mode === 'regions' ? 'regions' : 'plain', alpha, ...extra }); setStatus(); };

  let communityInfo = null;
  const setStatus = () => {
    if (!data) return;
    const shown = st.vis ? [...st.vis].filter((k) => k[0] === 'e').length : N;
    const parts = [`${shown === N ? N : shown + ' of ' + N} entities`, `${st.liveHyper ? st.liveHyper.size : hyper.length} notes`];
    if (st.mode === 'local') parts.push(st.sel && st.sel.kind === 'e' ? `around ${ents[st.sel.id].name}` : 'select an entity');
    if (st.mode === 'community' && communityInfo) parts.push(`${communityInfo.n} communities`);
    parts.push(`view of ${data.meta.viewer}`);
    if (syncNote) parts.push(syncNote);
    status.textContent = parts.join(' \u00b7 ') + (settled ? '' : ' \u00b7 settling');
  };
  let syncNote = '';

  // ---------- camera: fit to what is shown ----------
  const EASE = 'quadraticInOut';
  function fitCamera(idx, animate = true) {
    const list = idx || [...Array(N).keys()]; if (!list.length) return;
    const xs = [], ys = [];
    for (const i of list) { const a = graph.getNodeAttributes('e' + i); xs.push(a.x); ys.push(a.y); }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
    const lo = list.length > 50 ? 0.005 : 0, hi = 1 - lo; // drop a stray 0.5% each side
    const toF = (x, y) => sigma.viewportToFramedGraph(sigma.graphToViewport({ x, y }));
    const p0 = toF(q(xs, lo), q(ys, lo)), p1 = toF(q(xs, hi), q(ys, hi));
    const W = container.clientWidth, H = container.clientHeight, m = Math.min(W, H);
    const dx = Math.abs(p1.x - p0.x), dy = Math.abs(p1.y - p0.y);
    const ratio = Math.max(0.05, Math.min(4, Math.max((dx * m) / W, (dy * m) / H) * 1.18));
    const state = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, ratio };
    if (animate) sigma.getCamera().animate(state, { duration: 450, easing: EASE }); else sigma.getCamera().setState(state);
  }
  function flyTo(key) { const d = sigma.getNodeDisplayData(key); if (d) sigma.getCamera().animate({ x: d.x, y: d.y, ratio: Math.min(sigma.getCamera().ratio, 0.35) }, { duration: 450, easing: EASE }); }

  // ---------- tooltip ----------
  const tip = $('mg-tip'); let mx = 0, my = 0;
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '?');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\u2026' : s);
  const names = (h, n = 8) => h.m.slice(0, n).map((i) => ents[i].name).join(', ') + (h.k > n ? ` +${h.k - n}` : '');
  const placeTip = () => { const w = container.clientWidth, h = container.clientHeight; tip.style.left = Math.max(6, Math.min(w - tip.offsetWidth - 6, mx + 14)) + 'px'; tip.style.top = Math.max(6, Math.min(h - tip.offsetHeight - 6, my + 14)) + 'px'; };
  const showTip = (build) => { tip.replaceChildren(); build(tip); tip.style.display = 'block'; placeTip(); };
  const hideTip = () => { tip.style.display = 'none'; };
  const tipFor = (f) => showTip((t) => {
    if (f.kind === 'e') { const e = ents[f.id]; t.appendChild(el('b', null, e.name)); t.appendChild(el('span', 'd', `  ${e.type} \u00b7 ${e.n} notes`)); if (e.t) t.appendChild(el('div', 'n', day(e.ta) + '  ' + clip(e.t, 240))); }
    else if (f.kind === 'h') { const h = hyper[f.id]; t.appendChild(el('span', 'd', `note ${day(h.at)} \u00b7 ${h.k} entities`)); t.appendChild(el('div', 'n', h.text)); t.appendChild(el('div', 'n d', names(h))); }
    else { const [a, b] = f.id.split('_').map(Number), hs = pairs.get(f.id).filter(hyperLive); t.appendChild(el('b', null, ents[a].name + '  \u2014  ' + ents[b].name)); t.appendChild(el('span', 'd', `  ${hs.length} note${hs.length > 1 ? 's' : ''}`)); hs.slice(-3).reverse().forEach((j) => t.appendChild(el('div', 'n', day(hyper[j].at) + '  ' + clip(hyper[j].text, 320)))); }
  });
  container.addEventListener('mousemove', (e) => { const r = container.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; if (tip.style.display === 'block') placeTip(); });

  // ---------- highlight: repaint only what changed ----------
  const refocus = () => {
    const prev = hl; hl = highlight();
    const nodes = new Set(), edges = new Set();
    const touch = (h) => { if (!h) return; h.nodes.forEach((n) => nodes.add(n)); };
    touch(prev); touch(hl);
    // edges that change look: both ends highlighted before or after
    const inEither = (k) => (prev && prev.nodes.has(k)) || (hl && hl.nodes.has(k));
    nodes.forEach((n) => graph.forEachEdge(n, (e, a) => { if (inEither(a.s) && inEither(a.t)) edges.add(e); }));
    sigma.refresh({ partialGraph: { nodes: [...nodes], edges: [...edges] }, skipIndexation: true }); drawHulls();
  };
  const nodeFocus = (key) => (key[0] === 'e' ? { kind: 'e', id: +key.slice(1) } : { kind: 'h', id: graph.getNodeAttribute(key, 'hj') });
  const edgeFocus = (key) => { const a = graph.getEdgeAttributes(key); return a.spoke ? { kind: 'h', id: a.hj } : { kind: 'p', id: a.pair }; };
  let hoverPrefetch = null;
  const bindSigma = () => {
    sigma.on('afterRender', () => { drawHulls(); placeRegionLabels(); });
    sigma.on('enterNode', ({ node }) => {
      st.hoverNode = nodeFocus(node); st.hoverEdge = null; container.style.cursor = 'pointer'; tipFor(st.hoverNode); refocus();
      if (node[0] === 'e') { clearTimeout(hoverPrefetch); const id = ents[+node.slice(1)].id; hoverPrefetch = setTimeout(() => prefetch(id), 90); }
    });
    sigma.on('leaveNode', () => { clearTimeout(hoverPrefetch); st.hoverNode = null; container.style.cursor = ''; hideTip(); refocus(); });
    sigma.on('enterEdge', ({ edge }) => { if (st.hoverNode) return; st.hoverEdge = edgeFocus(edge); tipFor(st.hoverEdge); refocus(); });
    sigma.on('leaveEdge', () => { if (st.hoverEdge) { st.hoverEdge = null; if (!st.hoverNode) hideTip(); refocus(); } });
    sigma.on('clickNode', ({ node }) => select(nodeFocus(node), true));
    sigma.on('doubleClickNode', ({ node, preventSigmaDefault }) => { preventSigmaDefault(); if (node[0] === 'e') openPage(ents[+node.slice(1)].id); });
    sigma.on('clickEdge', ({ edge }) => { const f = edgeFocus(edge); if (f.kind === 'h') select(f, false); });
    sigma.on('clickStage', () => select(null));
  };

  // ---------- side panel ----------
  const pageUrl = (id) => '/e/' + encodeURIComponent(id);
  const panel = $('mg-panel'), pbody = $('mg-pbody');
  const setHash = () => {
    if (modalOpen()) return; // the modal owns the URL while it is open
    const p = new URLSearchParams(); if (st.sel && st.sel.kind === 'e') p.set('e', ents[st.sel.id].id); if (st.mode !== 'plain') p.set('mode', st.mode);
    const h = p.toString(); history.replaceState(history.state, '', '/graph' + (h ? '#' + h : ''));
  };
  // an entity link: plain click opens the page modal (modifier clicks keep the browser's own behaviour)
  const entLink = (id, left, right) => {
    const l = el('a'); l.href = pageUrl(id); l.dataset.e = id; l.appendChild(el('span', null, left)); l.appendChild(el('span', null, right));
    return l;
  };
  function select(f, fly) {
    st.sel = f; pbody.replaceChildren();
    if (!f) { panel.classList.remove('open'); refocus(); setHash(); setStatus(); return; }
    if (f.kind === 'e') {
      const e = ents[f.id];
      prefetch(e.id);
      pbody.appendChild(el('h1', null, e.name));
      pbody.appendChild(el('div', 'm', `${e.type} \u00b7 ${e.n} notes \u00b7 ${nbrs[f.id].size} neighbours`));
      const b = el('div', 'btns'); const a = el('button', 'open', 'open page'); a.title = 'open the page (Enter)'; a.onclick = () => openPage(e.id); b.appendChild(a);
      const lb = el('button', null, 'local view'); lb.onclick = () => setMode('local'); b.appendChild(lb); pbody.appendChild(b);
      if (e.t) pbody.appendChild(el('pre', null, day(e.ta) + '  ' + e.t));
      const lk = el('div', 'lk'); lk.appendChild(el('div', 'm', 'neighbours (shared notes)'));
      [...nbrs[f.id].entries()].sort((x, y) => y[1] - x[1] || ents[y[0]].n - ents[x[0]].n).slice(0, 16).forEach(([i, c]) => {
        const l = entLink(ents[i].id, ents[i].name, String(c));
        l.onmouseenter = () => { st.hoverNode = { kind: 'e', id: i }; refocus(); prefetch(ents[i].id); }; l.onmouseleave = () => { st.hoverNode = null; refocus(); };
        lk.appendChild(l);
      });
      pbody.appendChild(lk);
      const nk = el('div', 'lk'); nk.appendChild(el('div', 'm', 'notes (newest first)'));
      entHyper[f.id].filter(hyperLive).slice(-14).reverse().forEach((j) => { const d = el('div', null, `${day(hyper[j].at)} k=${hyper[j].k}  ${clip(hyper[j].text.replace(/\s+/g, ' '), 70)}`); d.style.display = 'block'; d.onclick = () => select({ kind: 'h', id: j }, false); d.onmouseenter = () => { st.hoverEdge = { kind: 'h', id: j }; refocus(); }; d.onmouseleave = () => { st.hoverEdge = null; refocus(); }; nk.appendChild(d); });
      pbody.appendChild(nk);
      if (st.mode === 'local') applyFilter(0.7);
    } else {
      const h = hyper[f.id];
      pbody.appendChild(el('h1', null, `note \u00b7 ${day(h.at)}`)); pbody.appendChild(el('div', 'm', `one hyperedge over ${h.k} entities`));
      pbody.appendChild(el('pre', null, h.text));
      const lk = el('div', 'lk'); lk.appendChild(el('div', 'm', 'members'));
      h.m.forEach((i) => { const l = entLink(ents[i].id, ents[i].name, ents[i].type); l.dataset.sel = String(i); lk.appendChild(l); });
      pbody.appendChild(lk);
    }
    panel.classList.add('open'); setHash();
    if (fly && f.kind === 'e' && st.mode !== 'local') flyTo('e' + f.id);
    refocus(); setStatus();
  }
  pbody.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-e]'); if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
    ev.preventDefault();
    if (a.dataset.sel != null) select({ kind: 'e', id: +a.dataset.sel }, true); else openPage(a.dataset.e);
  });
  $('mg-x').onclick = () => select(null);

  // ---------- page modal ----------
  const modal = $('mg-modal'), mbox = $('mg-mbox'), mbody = $('mg-mbody');
  const pages = new Map(); // id -> {v, p}: page JSON per graph version
  function getPage(id) {
    const hit = pages.get(id); if (hit && hit.v === version) return hit.p;
    const p = (session ? entityPage(session.vs, currentGraph(), id) : Promise.resolve(null)).then((x) => x || { missing: true });
    p.catch(() => pages.delete(id));
    pages.set(id, { v: version, p });
    if (pages.size > 400) pages.delete(pages.keys().next().value);
    return p;
  }
  const prefetch = (id) => { getPage(id).catch(() => {}); };
  const modalOpen = () => !modal.hidden;
  let modalDepth = 0, lastFocus = null, showing = null, renderTok = 0;
  const day10 = (iso) => (iso ? String(iso).slice(0, 10) : '');
  function renderHead(id, p) {
    const i = idxOf.get(id), e = p && p.node ? p.node : i != null ? ents[i] : { id, name: id, type: '', n: 0 };
    const top = el('div', 'mtop');
    const g = el('button', null, 'show in graph'); g.onclick = () => { const k = idxOf.get(e.id); closeModal(); if (k != null) select({ kind: 'e', id: k }, true); };
    const x = el('button', 'mx', 'close'); x.title = 'close (Esc)'; x.onclick = () => closeModal();
    top.append(g, x);
    const h = el('h1', null, e.name); h.id = 'mg-mtitle';
    return [top, h, e];
  }
  function renderPage(id, p) {
    const [top, h, e] = renderHead(id, p);
    const out = [top, h];
    if (!p) { out.push(el('div', 'm', `${e.type} \u00b7 ${e.n} notes`)); out.push(el('p', 'm', 'loading')); return out; }
    if (p.missing) { out.push(el('p', 'm', `${id} is not in this view.`)); return out; }
    const nnb = p.neighbours.reduce((t, g) => t + g.items.length, 0);
    const m = el('div', 'm', `${e.type} \u00b7 ${e.n} notes \u00b7 ${nnb} neighbours${p.page && p.page.as_of ? ` \u00b7 page as of ${day10(p.page.as_of)}` : ''}`);
    if (p.page && p.page.dirty) m.appendChild(el('span', 'badge', 'stale'));
    out.push(m, el('h2', null, 'page'));
    if (p.page) { const pg = el('div', 'pg'); p.page.lines.forEach((l) => { const d = el('div', null, l.text); d.style.paddingLeft = l.depth * 18 + 'px'; pg.appendChild(d); }); out.push(pg); }
    else out.push(el('p', 'm', 'no page generated for this view yet'));
    if (!p.neighbours.length) out.push(el('h2', null, 'neighbours'), el('p', 'm', 'none: no note mentions this with anything else'));
    for (const g of p.neighbours) {
      out.push(el('h2', null, `${g.type} \u00b7 ${g.items.length}`));
      const nb = el('div', 'nb'); g.items.slice(0, 30).forEach((x) => nb.appendChild(entLink(x.id, x.name, String(x.shared)))); out.push(nb);
      if (g.items.length > 30) { const d = el('details'); d.appendChild(el('summary', null, `${g.items.length - 30} more`)); const nb2 = el('div', 'nb'); g.items.slice(30).forEach((x) => nb2.appendChild(entLink(x.id, x.name, String(x.shared)))); d.appendChild(nb2); out.push(d); }
    }
    out.push(el('h2', null, `notes \u00b7 ${p.notes_total}${p.notes_total > p.notes.length ? ` (newest ${p.notes.length})` : ''}`));
    const nt = el('div', 'nt'); p.notes.forEach((x) => { const d = el('div'); d.appendChild(el('b', null, day10(x.at))); d.appendChild(document.createTextNode(x.body)); nt.appendChild(d); }); out.push(nt);
    return out;
  }
  /** Show id in the modal (no history change). Resolves when the page content is on screen. */
  async function showPage(id) {
    const tok = ++renderTok, opening = modal.hidden;
    if (opening) { lastFocus = document.activeElement; modal.hidden = false; document.body.classList.add('modal'); hideTip(); }
    showing = id;
    const t0 = performance.now();
    const pending = getPage(id);
    // a prefetched page is usually resolved already: paint it in this task, else paint the header now and fill in
    let p = null; const ready = await Promise.race([pending.then((x) => x, () => null), new Promise((r) => setTimeout(() => r(undefined), 0))]);
    if (tok !== renderTok) return;
    if (ready === undefined) { mbody.replaceChildren(...renderPage(id, null)); mbox.scrollTop = 0; if (opening) mbox.focus({ preventScroll: true }); p = await pending.catch(() => ({ missing: true })); if (tok !== renderTok) return; }
    else p = ready || { missing: true };
    mbody.replaceChildren(...renderPage(id, p)); mbox.scrollTop = 0;
    if (opening || !modal.contains(document.activeElement)) mbox.focus({ preventScroll: true });
    trace.modalMs = performance.now() - t0;
  }
  function hideModal() {
    if (modal.hidden) return;
    renderTok++; modal.hidden = true; showing = null; modalDepth = 0; document.body.classList.remove('modal');
    const back = lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : container;
    back.focus({ preventScroll: true }); lastFocus = null;
    setHash();
  }
  /** Open id's page: a new history entry, so back returns to the previous page or closes the modal. */
  function openPage(id) {
    if (showing === id) return Promise.resolve();
    modalDepth = modalOpen() ? modalDepth + 1 : 1;
    history.pushState({ mg: 'page', id, depth: modalDepth }, '', pageUrl(id));
    return showPage(id);
  }
  /** Esc / close: leave every page this modal opened, the same as pressing back that many times. */
  function closeModal() {
    if (!modalOpen()) return;
    if (modalDepth > 0) history.go(-modalDepth); else { hideModal(); }
  }
  window.addEventListener('popstate', () => {
    const s = history.state;
    if (s && s.mg === 'page') { modalDepth = s.depth || 0; showPage(s.id); } else hideModal();
  });
  modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) closeModal(); });
  mbody.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-e]'); if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
    ev.preventDefault(); openPage(a.dataset.e);
  });
  mbody.addEventListener('mouseover', (ev) => { const a = ev.target.closest('a[data-e]'); if (a) prefetch(a.dataset.e); });
  pbody.addEventListener('mouseover', (ev) => { const a = ev.target.closest('a[data-e]'); if (a) prefetch(a.dataset.e); });
  // focus trap: Tab cycles inside the modal
  const focusables = () => [...modal.querySelectorAll('a[href], button, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  modal.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const f = focusables(); if (!f.length) { ev.preventDefault(); mbox.focus(); return; }
    const i = f.indexOf(document.activeElement);
    if (ev.shiftKey) { if (i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); } }
    else if (i === -1 || i === f.length - 1) { ev.preventDefault(); f[0].focus(); }
  });
  document.addEventListener('focusin', (ev) => { if (modalOpen() && !modal.contains(ev.target)) mbox.focus({ preventScroll: true }); });

  // ---------- modes ----------
  const localSet = (i) => {
    const set = new Set([i, ...nbrs[i].keys()]), hop2 = new Map();
    nbrs[i].forEach((_, a) => nbrs[a].forEach((_, b) => { if (!set.has(b)) hop2.set(b, (hop2.get(b) || 0) + 1); }));
    [...hop2.entries()].sort((a, b) => b[1] - a[1] || ents[b[0]].n - ents[a[0]].n).slice(0, Math.max(0, 600 - set.size)).forEach(([b]) => set.add(b));
    return set;
  };
  const keysFor = (set, live) => { const keys = new Set([...set].map((x) => 'e' + x)); hubIdx.forEach((j, k) => { if ((!live || live.has(j)) && hyper[j].m.filter((x) => set.has(x)).length >= 2) keys.add('h' + k); }); return keys; };
  // Show/hide by reducer: diff the old and new filter and repaint only the nodes and edges whose visibility flipped,
  // in place (no re-indexing of the whole graph; that was the ~300 ms freeze).
  function refreshVisibility(pv, pl, pp) {
    const nodes = [], edges = [];
    graph.forEachNode((k) => { if (nodeHidden(k, pv) !== nodeHidden(k, st.vis)) nodes.push(k); });
    graph.forEachEdge((e, a) => { if (edgeHidden(a, pv, pl, pp) !== edgeHidden(a, st.vis, st.liveHyper, st.livePairs)) edges.push(e); });
    if (nodes.length || edges.length) sigma.refresh({ partialGraph: { nodes, edges }, skipIndexation: true });
  }
  function applyFilter(alpha, { settle = true } = {}) {
    const pv = st.vis, pl = st.liveHyper, pp = st.livePairs;
    st.vis = null; st.liveHyper = null; st.livePairs = null;
    if (st.mode === 'local' && st.sel && st.sel.kind === 'e') st.vis = keysFor(localSet(st.sel.id));
    if (st.mode === 'time') {
      const live = new Set(), set = new Set();
      hyper.forEach((h, j) => { const d = day(h.at); if (d >= st.t0 && d <= st.t1) { live.add(j); h.m.forEach((i) => set.add(i)); } });
      st.liveHyper = live; st.vis = keysFor(set, live);
      st.livePairs = new Set(); pairs.forEach((hs, key) => { if (hs.some((j) => live.has(j))) st.livePairs.add(key); });
    }
    refreshVisibility(pv, pl, pp); refocus();
    if (!settle) { setStatus(); return; }
    if (st.mode === 'local' && st.vis) {
      // the neighbourhood forms around the selected entity where it stands; the camera frames it
      const k = 'e' + st.sel.id, a = graph.getNodeAttributes(k);
      run(alpha, { cx: a.x, cy: a.y, pin: st.sel.id });
      fitCamera(visibleEnts());
    } else run(alpha);
  }
  const communities = () => {
    if (tintColors) return;
    // Louvain on the weighted clique expansion (each hyperedge adds 1/(k-1) to every member pair).
    const g = new Graph({ type: 'undirected' }); ents.forEach((_, i) => g.addNode(i));
    hyper.forEach((h) => { const w = 1 / (h.k - 1); for (let a = 0; a < h.m.length; a++) for (let b = a + 1; b < h.m.length; b++) { const x = h.m[a], y = h.m[b]; if (g.hasEdge(x, y)) g.updateEdgeAttribute(g.edge(x, y), 'weight', (v) => v + w); else g.addEdge(x, y, { weight: w }); } });
    const comm = louvain(g, { getEdgeWeight: 'weight', resolution: 1 }), sizes = {};
    Object.values(comm).forEach((c) => (sizes[c] = (sizes[c] || 0) + 1));
    const rank = Object.keys(sizes).sort((a, b) => sizes[b] - sizes[a]), color = {}; rank.forEach((c, r) => { if (sizes[c] > 4 && r < palette.length) color[c] = palette[r]; });
    tintColors = {}; Object.keys(comm).forEach((i) => (tintColors['e' + i] = color[comm[i]] || '#a89d7e'));
    communityInfo = { n: rank.length, top: rank.slice(0, 12).map((c) => sizes[c]) };
  };
  const repaintEntities = () => sigma.refresh({ partialGraph: { nodes: ents.map((_, i) => 'e' + i), edges: [] }, skipIndexation: true });
  const modeBtns = [...document.querySelectorAll('#mg-modes button')];
  const timeBar = $('mg-time');
  function setMode(mode) {
    const prev = st.mode; if (prev === mode) return;
    st.mode = mode;
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    timeBar.classList.toggle('on', mode === 'time');
    if (mode === 'community') communities();
    if (mode === 'community' || prev === 'community') repaintEntities();
    const layoutChanged = (prev === 'regions') !== (mode === 'regions');
    const filtered = mode === 'local' || mode === 'time' || prev === 'local' || prev === 'time';
    if (filtered) applyFilter(mode === 'local' ? 0.7 : 0.45);
    else if (layoutChanged) run(0.6);
    else setStatus();
    if (mode === 'regions') sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 0.9 }, { duration: 450, easing: EASE });
    else if (mode === 'time') fitCamera(visibleEnts());
    else if (mode !== 'local' && (layoutChanged || filtered)) fitCamera(null);
    placeRegionLabels(); setHash();
  }
  modeBtns.forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  // time window: two sliders over the days notes were written
  let days = [];
  const t0 = $('mg-t0'), t1 = $('mg-t1'), tl = $('mg-tl');
  const setupDays = () => {
    const keep = st.t0 && [st.t0, st.t1];
    days = [...new Set(hyper.map((h) => day(h.at)).filter((d) => d !== '?'))].sort();
    [t0, t1].forEach((s) => { s.min = 0; s.max = Math.max(0, days.length - 1); s.step = 1; });
    const at = (d) => { const i = days.findIndex((x) => x >= d); return i < 0 ? days.length - 1 : i; };
    if (keep) { t0.value = at(keep[0]); t1.value = keep[1] >= days[days.length - 1] ? days.length - 1 : at(keep[1]); }
    else { t0.value = Math.max(0, days.length - 1 - 30); t1.value = days.length - 1; }
    readTime();
  };
  const readTime = () => {
    let a = +t0.value, b = +t1.value; if (a > b) [a, b] = [b, a];
    st.t0 = days[a] || '0000'; st.t1 = days[b] || '9999'; tl.textContent = `${st.t0.slice(5)} \u2013 ${st.t1.slice(5)}`; tl.title = `${st.t0} to ${st.t1}`;
  };
  let tDeb = null;
  const onTime = () => { readTime(); clearTimeout(tDeb); tDeb = setTimeout(() => { if (st.mode === 'time') applyFilter(0.3); }, 120); };
  t0.oninput = onTime; t1.oninput = onTime;

  // ---------- search ----------
  const q = $('mg-q'), hits = $('mg-hits'); let hitList = [], hitSel = -1;
  const renderHits = () => {
    hits.replaceChildren(); hitList.forEach((h, k) => { const d = el('div', k === hitSel ? 'sel' : ''); d.appendChild(document.createTextNode(ents[h].name + ' ')); d.appendChild(el('small', null, ents[h].type)); d.onmousedown = (ev) => { ev.preventDefault(); pick(h); }; d.onmouseenter = () => { hitSel = k; [...hits.children].forEach((c, n) => c.classList.toggle('sel', n === k)); }; hits.appendChild(d); });
    hits.style.display = hitList.length ? 'block' : 'none';
  };
  const pick = (i) => { q.value = ents[i].name; hitList = []; renderHits(); if (st.vis && !st.vis.has('e' + i)) setMode('plain'); select({ kind: 'e', id: i }, true); q.blur(); };
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase(); if (!s) { hitList = []; renderHits(); return; }
    const sc = []; ents.forEach((e, i) => { const n = e.name.toLowerCase(); const p = n.startsWith(s) ? 0 : n.split(/\s+/).some((w) => w.startsWith(s)) ? 1 : n.includes(s) ? 2 : 9; if (p < 9) sc.push([p, -e.n, i]); });
    sc.sort((a, b) => a[0] - b[0] || a[1] - b[1]); hitList = sc.slice(0, 8).map((x) => x[2]); hitSel = 0; renderHits();
    if (hitList[0] != null) prefetch(ents[hitList[0]].id);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hitSel = Math.min(hitList.length - 1, hitSel + 1); renderHits(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hitSel = Math.max(0, hitSel - 1); renderHits(); e.preventDefault(); }
    else if (e.key === 'Enter' && hitList[hitSel] != null) { e.preventDefault(); pick(hitList[hitSel]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (hitList.length) { hitList = []; renderHits(); } else if (q.value) q.value = ''; else q.blur(); }
  });
  q.addEventListener('focus', () => { if (q.value.trim()) q.dispatchEvent(new Event('input')); });
  q.addEventListener('blur', () => { hitList = []; renderHits(); });

  // ---------- keyboard: Esc closes the topmost layer; "/" searches; Enter opens the selected page ----------
  document.addEventListener('keydown', (e) => {
    if (modalOpen()) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } return; }
    const typing = e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); q.focus(); q.select(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (st.sel) select(null);
      else if (q.value) { q.value = ''; hitList = []; renderHits(); }
      else if (st.mode === 'local' || st.mode === 'time') setMode('plain');
    } else if (e.key === 'Enter' && st.sel && st.sel.kind === 'e' && !e.target.closest('button, a, summary')) { e.preventDefault(); openPage(ents[st.sel.id].id); }
  });

  // ---------- mount: (re)build the view from a graph, keeping positions, selection and mode ----------
  function mount(d, ver, pos, how) {
    const selId = st.sel && st.sel.kind === 'e' && ents[st.sel.id] ? ents[st.sel.id].id : null;
    index(d); version = ver;
    const { xy, fresh } = placement(pos);
    graph = makeGraph(xy);
    hl = null; st.hoverNode = st.hoverEdge = null; tintColors = null; communityInfo = null;
    st.vis = st.liveHyper = st.livePairs = null;
    if (!sigma) { sigma = makeSigma(); bindSigma(); } else { sigma.setGraph(graph); unhookGraphState(sigma); }
    initWorker(xy); settled = true;
    setupDays();
    st.sel = selId != null && idxOf.has(selId) ? { kind: 'e', id: idxOf.get(selId) } : null;
    if (st.mode === 'community') { communities(); repaintEntities(); }
    if (st.sel) select(st.sel, false); else { panel.classList.remove('open'); pbody.replaceChildren(); }
    if (st.mode === 'local' || st.mode === 'time') applyFilter(0.25, { settle: st.mode === 'time' && how !== 'cache' });
    if (how === 'cold') { onSettle = () => { onSettle = null; fitCamera(null); saveSoon(); }; run(1, { presettle: 0.03 }); }
    else if (how === 'delta' && fresh.length && st.mode !== 'local') {
      const sub = new Set(fresh); fresh.forEach((i) => nbrs[i].forEach((_, b) => sub.add(b)));
      onSettle = () => { onSettle = null; saveSoon(); };
      settled = false; worker.postMessage({ type: 'run', subset: [...sub], mode: st.mode === 'regions' ? 'regions' : 'plain', alpha: 0.25 });
    } else if (how === 'delta') saveSoon();
    setStatus();
  }
  const currentPositions = () => { const m = new Map(); if (graph) for (let i = 0; i < N; i++) { const a = graph.getNodeAttributes('e' + i); m.set(ents[i].id, [a.x, a.y]); } return m; };
  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); };
  async function save() {
    if (!settled) { saveSoon(); return; }
    const ids = ents.map((e) => e.id), xy = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) { const a = graph.getNodeAttributes('e' + i); xy[2 * i] = a.x; xy[2 * i + 1] = a.y; }
    const t = performance.now();
    if (session && session.ck) await idbPut('layout', await sealCache({ version, ids, xy: Array.from(xy) }, session.ck));
    trace.saveMs = performance.now() - t; trace.saved = version;
  }
  let syncing = false;
  async function sync() {
    if (PUBLIC || syncing || !version) return; syncing = true;
    try {
      await pullHub(null);
      const r = await fetchGraph(version);
      syncNote = '';
      saveState();
      if (r.same) { setStatus(); return; }
      trace.lastSync = { at: new Date().toISOString(), pulled: trace.pull && trace.pull.pulled };
      mount(r.body, r.version, currentPositions(), 'delta');
    } catch (e) { syncNote = e && e.status === 401 ? 'the hub refused the device token' : 'offline, showing the saved graph'; setStatus(); }
    finally { syncing = false; }
  }
  setInterval(() => { if (document.visibilityState === 'visible' && !modalOpen()) sync(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

  // ---------- start: unlock, then paint ----------
  window.__mg = {
    get ents() { return ents; }, get hyper() { return hyper; }, get idxOf() { return idxOf; }, get graph() { return graph; }, get sigma() { return sigma; }, get version() { return version; }, get meta() { return data && data.meta; },
    st, select: (i) => select(i == null ? null : { kind: 'e', id: i }, true), setMode, openPage, closeModal, modalOpen, prefetch, sync, isSettled: () => settled,
    hoverHyper: (j) => { st.hoverEdge = { kind: 'h', id: j }; mx = container.clientWidth / 2; my = 60; tipFor(st.hoverEdge); refocus(); }, clearHover: () => { st.hoverEdge = st.hoverNode = null; hideTip(); refocus(); },
    get session() { return session && { user: session.vs.user, device: session.vs.device, cursor: session.vs.cursor, scopes: session.vs.viewer.groups, held: session.vs.heldScopes(), unopened: session.vs.unopened.length, kept: Boolean(session.ck) }; },
  };
  const hp = new URLSearchParams(location.hash.slice(1)); // read before a deep link is rewritten
  const deep = /^\/e\/([^/]+)$/.exec(location.pathname);
  const deepId = deep ? decodeURIComponent(deep[1]) : null;
  if (deepId) history.replaceState(null, '', '/graph#e=' + encodeURIComponent(deepId));
  // the first frame after a mount (a hidden tab gets no animation frames: then a short timer stands in)
  const painted = () => new Promise((r) => { let done = false; const f = () => { if (done) return; done = true; trace.paintMs = performance.now() - trace.t0; r(); }; requestAnimationFrame(f); setTimeout(f, 250); });

  // the lock: a key file, a device token and a passphrase the first time; the passphrase alone when a sealed copy is kept here
  if (PUBLIC) {
    trace.source = 'snapshot';
    loadBar.set(null, 'loading');
    const res = await fetch(PUBLIC, { credentials: 'omit' });
    if (!res.ok) { showErr('the snapshot answered ' + res.status); return; }
    session = { vs: snapshotView(await res.json()), token: null, ck: null };
    $('th-lock').hidden = true; $('th-lockbtn').hidden = true;
    // an embedding page may load this frame while it is hidden (a phone tab); the renderer needs a sized container
    await new Promise((ok) => { const sized = () => container.clientWidth > 0 && container.clientHeight > 0; if (sized()) return ok(); const ro = new ResizeObserver(() => { if (sized()) { ro.disconnect(); ok(); } }); ro.observe(container); });
    const r = await fetchGraph(null);
    mount(r.body, r.version, null, 'cold');
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 0.82 });
    await painted();
    loadBar.done(); setStatus();
    const want0 = hp.get('e') && idxOf.get(hp.get('e')), mode0 = hp.get('mode');
    if (want0 != null) select({ kind: 'e', id: want0 }, true);
    if (mode0 && mode0 !== 'plain' && modeBtns.some((b) => b.dataset.mode === mode0)) setMode(mode0);
    // an embedding page points the graph at an entity by changing the hash (#e=<id>)
    window.addEventListener('hashchange', () => { const h = new URLSearchParams(location.hash.slice(1)), i = h.get('e') && idxOf.get(h.get('e')); if (i != null) select({ kind: 'e', id: i }, true); });
    return;
  }
  const lock = $('th-lock'), form = $('th-form'), fresh = $('th-new'), err = $('th-err'), forget = $('th-forget'), passIn = $('th-pass');
  const meta0 = await idbGet('meta').catch(() => null);
  const kept = meta0 && meta0.schema === CACHE_SCHEMA && (await idbGet('state').catch(() => null));
  fresh.hidden = Boolean(kept); forget.hidden = !kept;
  lock.hidden = false; status.textContent = kept ? 'locked' : 'no key loaded';
  passIn.focus();
  forget.onclick = async () => { await idbClear(); location.reload(); };
  $('th-lockbtn').onclick = () => { location.reload(); }; // nothing decrypted outlives the tab's memory
  const unlock = () => new Promise((resolve) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault(); err.textContent = '';
      const pass = passIn.value;
      const busy = (t) => { err.textContent = t; };
      try {
        if (kept) {
          busy('opening the saved copy');
          const ck = await cacheKey(pass, meta0.salt, meta0.iterations);
          const box = await openCache(kept, ck);
          if (box.hub !== HUB) throw new Error('the saved copy belongs to another hub');
          const layout = await idbGet('layout').then((b) => (b ? openCache(b, ck) : null)).catch(() => null);
          resolve({ vs: ViewState.fromJSON(box.state), token: box.token, ck, layout });
        } else {
          const file = $('th-file').files[0];
          if (!file) throw new Error('choose the key file');
          const token = $('th-token').value.trim();
          const claims = tokenClaims(token);
          busy('opening the key file');
          const keys = await readKeyFile(await file.text(), pass);
          if (keys.user !== claims.user) throw new Error(`the key file is for ${keys.user}, the token for ${claims.user}`);
          if (keys.keyDevice && keys.keyDevice !== claims.device) busy(`note: keys published after the export reach device ${keys.keyDevice}; this token is for ${claims.device}`);
          const ck = $('th-keep').checked ? await cacheKey(pass) : null;
          resolve({ vs: new ViewState({ user: claims.user, device: claims.device, keys }), token, ck, layout: null });
        }
        passIn.value = ''; $('th-token').value = ''; err.textContent = '';
      } catch (e) { err.textContent = e.message || String(e); }
    };
  });
  const opened = await unlock();
  session = { vs: opened.vs, token: opened.token, ck: opened.ck };
  lock.hidden = true;
  container.focus({ preventScroll: true });

  if (session.vs.cursor > 0) {
    // the sealed copy: paint it now (with its settled layout when one was saved), then pull what the log gained
    trace.source = 'cache';
    let pos = null;
    if (opened.layout) { pos = new Map(); opened.layout.ids.forEach((id, i) => pos.set(id, [opened.layout.xy[2 * i], opened.layout.xy[2 * i + 1]])); }
    const r = await fetchGraph(null);
    mount(r.body, r.version, pos, pos ? 'cache' : 'cold');
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: pos ? 1 : 0.82 }); if (pos) fitCamera(null, false);
    await painted();
    syncNote = 'checking for updates'; setStatus();
    sync();
  } else {
    trace.source = 'network';
    loadBar.set(0, 'pulling');
    try { await pullHub((f, text) => loadBar.set(f, text)); }
    catch (e) { loadBar.done(); status.textContent = e && e.status === 401 ? 'the hub refused the device token' : 'could not reach the hub: ' + (e.message || e); if (!session.vs.tables.notes.size) return; }
    loadBar.set(null, 'building the graph');
    await new Promise((res) => setTimeout(res, 0));
    const r = await fetchGraph(null);
    mount(r.body, r.version, null, 'cold');
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 0.82 }); // until the first settle, then fitted
    await painted();
    loadBar.done();
    saveState();
  }
  setStatus();
  const want = (deepId || hp.get('e')) && idxOf.get(deepId || hp.get('e'));
  const wantMode = hp.get('mode');
  if (want != null) select({ kind: 'e', id: want }, !deepId);
  if (deepId) openPage(deepId);
  if (wantMode && wantMode !== 'plain' && modeBtns.some((b) => b.dataset.mode === wantMode)) setMode(wantMode);
})();
