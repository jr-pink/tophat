// The UI contract a declaration carries, with the kit's defaults filled in. Easy-kit bar: declaring state makes the right
// laws apply; the author writes numbers (a budget, a deadline), never the harness. Every law below names the correction
// classes it exists for (webchat/tests/corrections/classes.json).
//
//   declare({ name, scope, initial, actions,
//     budget:   { 'folder.open': { p95_ms: 50 }, switchChat: { p95_ms: 100, kind: 'interaction' } },  // optional overrides
//     motion:   { drawer: { property: 'x', max_ms: 250 } },          // gestures whose frames the motion law checks
//     waits:    { sending: { deadline_ms: 15000, to: 'failed' } },   // lifecycle states that wait on the outside world
//     firstPaint: true })                                            // default: on for any persisted scope
//
// Defaults (one place; GUIDE section 3e quotes this table, code reads it):
export const UI_DEFAULTS = Object.freeze({
  interaction: { p95_ms: 100, p99_ms: 200 },  
  load: { p95_ms: 1000 },                       // cold/warm load and chat switch to first row
  reducer: { p95_ms: 4 },                       // one step() on the declared large state: a quarter of a 16 ms frame
  motion: { max_ms: 400, stutter_gap_ms: 34 },  // longest gesture animation; a frame gap above two 60 Hz frames is a stutter
  wait: { deadline_ms: 15000 },                 // a pending network wait without a declared deadline gets this one
});

export const LAW_CLASSES = Object.freeze({
  budget: ['interaction-latency', 'load-latency', 'freeze-starvation'],
  reducerBudget: ['interaction-latency', 'freeze-starvation'],
  firstPaint: ['first-paint-flash', 'state-lost-on-reload'],
  reloadRestores: ['state-lost-on-reload', 'first-paint-flash'],
  noLoss: ['data-loss'],
  idempotentRetry: ['duplicate-or-replay', 'data-loss'],
  tabsConverge: ['cross-device-convergence', 'echo-fight'],
  liveness: ['liveness-stuck', 'freeze-starvation'],
  boundedWork: ['freeze-starvation'],
  motion: ['motion-quality', 'flicker'],
  noFlash: ['first-paint-flash', 'flicker', 'motion-quality'],
  layoutStable: ['layout-shift', 'scroll-anchor-jump'],
  anchorStable: ['scroll-anchor-jump'],
  orderStable: ['row-order-churn'],
});

const num = (v, what) => { if (typeof v !== 'number' || !(v > 0)) throw new Error(`ui contract: ${what} must be a positive number of ms`); return v; };

/** Resolve the laws that apply to a declaration. Throws on a malformed contract (that is the structural check: a budget
 *  for an action that does not exist, a wait state the lifecycle lacks, a wait with no exit edge). */
export function uiContract(decl) {
  const actions = Object.keys(decl.actions || {});
  const persisted = decl.scope !== 'ephemeral';
  const budgets = {};
  for (const a of actions) budgets[a] = { kind: 'interaction', ...UI_DEFAULTS.interaction };
  for (const [k, b] of Object.entries(decl.budget || {})) {
    const kind = b.kind || (actions.includes(k) ? 'interaction' : null);
    if (!kind) throw new Error(`ui contract ${decl.name}: budget "${k}" is not an action; name its kind ('interaction' | 'load')`);
    if (!['interaction', 'load'].includes(kind)) throw new Error(`ui contract ${decl.name}: budget "${k}" kind must be interaction or load`);
    budgets[k] = { ...UI_DEFAULTS[kind], ...(budgets[k] || {}), kind };
    if (b.p95_ms !== undefined) budgets[k].p95_ms = num(b.p95_ms, `budget.${k}.p95_ms`);
    if (b.p99_ms !== undefined) budgets[k].p99_ms = num(b.p99_ms, `budget.${k}.p99_ms`);
  }
  const waits = {};
  for (const [s, w] of Object.entries(decl.waits || {})) {
    if (!decl.states?.includes(s)) throw new Error(`ui contract ${decl.name}: waits names "${s}", which is not a declared state`);
    if (!w.to) throw new Error(`ui contract ${decl.name}: waits.${s} needs \`to\`, the state a missed deadline moves to`);
    if (!(decl.transitions?.[s] || []).includes(w.to)) throw new Error(`ui contract ${decl.name}: waits.${s} exits to "${w.to}" but ${s}->${w.to} is not a declared transition`);
    waits[s] = { deadline_ms: num(w.deadline_ms ?? UI_DEFAULTS.wait.deadline_ms, `waits.${s}.deadline_ms`), to: w.to };
  }
  for (const o of decl.owner || []) if (!actions.includes(o)) throw new Error(`ui contract ${decl.name}: owner action "${o}" is not declared`);
  const motion = {};
  for (const [g, m] of Object.entries(decl.motion || {})) motion[g] = { property: m.property || 'y', ...UI_DEFAULTS.motion, ...m };
  const laws = {
    budget: true,
    reducerBudget: true,
    firstPaint: decl.firstPaint ?? persisted,
    reloadRestores: persisted,
    noLoss: Boolean((decl.owner || []).length || decl.conflict === 'log' || decl.durable),
    idempotentRetry: true,
    tabsConverge: decl.scope === 'cloud',
    liveness: Object.keys(waits).length > 0,
    motion: Object.keys(motion).length > 0,
    noFlash: decl.firstPaint ?? persisted,
  };
  return Object.freeze({ name: decl.name, laws, budgets, waits, motion, owner: decl.owner || [], classes: LAW_CLASSES });
}
