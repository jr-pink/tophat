// Force simulation for the graph page, off the main thread. Bundled with d3-force into assets/sim.js (scripts/build.mjs).
// main -> worker: {type:'next'} after each drawn frame; {type:'init', gen, n:[note counts], region:[region index], anchors:[[x,y]...], xy:[x0,y0,...]|undefined, links:[[a,b,w]], hubs:[[members]]}
//                 {type:'run', subset:[entity idx]|null, mode:'plain'|'regions', alpha, cx, cy, pin}
// worker -> main: {type:'pos', gen, xy:Float32Array(2N) (transferred), alpha, settled}; gen tags the init a frame belongs to
import { forceSimulation, forceLink, forceManyBody, forceX, forceY } from 'd3-force';

let gen = 0, lastTick = 0, nodes = [], links = [], hubs = [], anchors = [], sim = null, pull = [];
const post = (settled) => {
  const xy = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) { xy[2 * i] = nodes[i].x; xy[2 * i + 1] = nodes[i].y; }
  self.postMessage({ type: 'pos', gen, xy, alpha: sim ? sim.alpha() : 0, settled, tickMs: lastTick }, [xy.buffer]);
};
// Paced by the page: one tick per 'next' (sent after the page has drawn the previous positions), so the page never
// queues stale frames and every drawn frame is one tick further. alpha decays geometrically: one ease-out per run.
const step = () => {
  if (!sim) return;
  if (sim.alpha() <= sim.alphaMin()) { post(true); sim = null; return; }
  // the tick for the next frame was computed while the page drew this one: send it, then compute the following one
  post(false);
  const t0 = performance.now(); sim.tick(); lastTick = performance.now() - t0;
};
let pinned = null;
function run({ subset, mode, alpha, cx = 0, cy = 0, presettle = 0, pin = null }) {
  if (pinned) { pinned.fx = pinned.fy = null; pinned = null; }
  if (pin != null) { pinned = nodes[pin]; pinned.fx = pinned.x; pinned.fy = pinned.y; } // local view: the focus holds still, its neighbourhood forms around it
  const sub = subset ? subset.map((i) => nodes[i]) : nodes, inSet = new Set(sub);
  const subLinks = links.filter((l) => inSet.has(l.source) && inSet.has(l.target));
  const subHubs = hubs.filter((h) => h.filter((i) => inSet.has(nodes[i])).length >= 2);
  const reg = mode === 'regions';
  // a node outside the subset keeps its place; a node coming into a subset from far away starts near the centre of mass
  sim = forceSimulation(sub).alpha(alpha).alphaMin(0.004).alphaDecay(0.028).velocityDecay(0.42).stop();
  sim.force('link', forceLink(subLinks).distance(26).strength((l) => 0.28 + 0.1 * Math.min(4, l.w)));
  sim.force('charge', forceManyBody().strength((d) => -(22 + 5 * Math.sqrt(d.n))).theta(0.9).distanceMax(300));
  sim.force('x', forceX((d) => (reg ? anchors[d.region][0] : cx)).strength(reg ? 0.4 : 0.035));
  sim.force('y', forceY((d) => (reg ? anchors[d.region][1] : cy)).strength(reg ? 0.4 : 0.035));
  // Hyperedges: each k>=3 note pulls its members to their centroid (star expansion without simulated hub bodies).
  sim.force('hyper', (a) => {
    for (const h of subHubs) {
      let x = 0, y = 0, c = 0; for (const i of h) { const d = nodes[i]; if (!inSet.has(d)) continue; x += d.x; y += d.y; c++; }
      if (c < 2) continue; x /= c; y /= c;
      for (const i of h) { const d = nodes[i]; if (!inSet.has(d)) continue; const s = pull[i] * a; d.vx += (x - d.x) * s; d.vy += (y - d.y) * s; }
    }
  });
  while (presettle && sim.alpha() > presettle) sim.tick();
  post(false); sim.tick();
}
self.onmessage = ({ data: m }) => {
  if (m.type === 'init') {
    let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    anchors = m.anchors; gen = m.gen || 0; sim = null; pinned = null;
    nodes = m.n.map((n, i) => {
      if (m.xy) return { i, n, region: m.region[i], x: m.xy[2 * i], y: m.xy[2 * i + 1], vx: 0, vy: 0 }; // the page's positions (cache, previous mount)
      const [ax, ay] = anchors[m.region[i]], a = rnd() * 6.283, d = 40 + rnd() * 130; return { i, n, region: m.region[i], x: ax * 0.5 + d * Math.cos(a), y: ay * 0.5 + d * Math.sin(a), vx: 0, vy: 0 };
    });
    links = m.links.map(([a, b, w]) => ({ source: nodes[a], target: nodes[b], w }));
    hubs = m.hubs;
    const deg = new Array(nodes.length).fill(0); hubs.forEach((h) => h.forEach((i) => deg[i]++));
    pull = deg.map((d) => Math.min(0.4, 0.4 / Math.max(1, d))); // per-entity cap keeps the summed pull < 1 (stable)
  } else if (m.type === 'run') run(m);
  else if (m.type === 'next') step();
  else if (m.type === 'stop') sim = null;
};
