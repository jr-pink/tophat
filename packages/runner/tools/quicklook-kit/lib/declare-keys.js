// The closed key set of `declare` (DOCSTORE3-DESIGN A10 "declared means enforced", conformance rows #10, #23, #26, #28).
// One table, read by lib/model.js declare (which refuses anything else), lint/axes.js (the static `unenforced-axis` rule)
// and tests/lint.test.js (which proves every key here is read somewhere in lib/). A key is listed in DECLARE_KEYS only
// once something executes it; an axis the design names that nothing executes is in NOT_EXECUTED, and declare refuses
// it with the reason, so a declaration can never carry a promise the kit does not keep.
//
// Adding a key: write the code that reads it, add it here with the executor, add a planted test that turns red without
// the executor (tests/declare.test.js), and update conformance/design-rows.json and DOCSTORE3-DESIGN.md in the same commit.

/** Every key `declare` accepts, with what executes it. */
export const DECLARE_KEYS = Object.freeze({
  name: 'storage key qk:<name> and the Stream id (model.js createReplica)',
  version: 'schema version; hydrate upcasts through migrations (model.js createReplica)',
  migrations: 'upcasters {n: up}, run on hydrate; the raw record is archived first (model.js createReplica)',
  scope: "cloud | local | ephemeral: which store and transport carry it (model.js createReplica, createApp.use)",
  initial: 'the state before any action (model.js createReplica)',
  actions: 'the log vocabulary; step() is the one place an action meets a state (model.js step)',
  fields: 'typed fields: derive initial, normalize, persist and shorthand actions (schema.js compile)',
  normalize: 'repairs every state step() produces and hydrate reads (model.js step, createReplica)',
  persist: 'what of a local state is saved (model.js createReplica record)',
  storage: "'tab': sessionStorage instead of localStorage (model.js createApp.use)",
  legacy: 'one-time import of old hand-rolled keys or outboxes (schema.js compile, model.js createReplica)',
  durable: 'local: on disk before dispatch returns, adopts other tabs first (model.js createReplica)',
  dropEmpty: 'local: a state equal to initial has no record (model.js createReplica save)',
  crossTab: "local: another tab's save is adopted on a storage event (model.js createReplica refresh)",
  conflict: "lww | log: which merge law the gate checks (laws.js idempotent | dedupe; contract.js noLoss for log); both fold the one total order",
  states: 'lifecycle states (model.js checkLifecycle, step transitionError)',
  transitions: 'lifecycle edges (model.js step transitionError)',
  terminal: 'lifecycle states with no exits (model.js step transitionError)',
  stateField: 'the lifecycle field, default state (model.js step transitionError)',
  undo: "'compensating' | {model: 'compensating', limit}: replica.undo/redo/seek by value compare-and-set (lib/undo.js over history.js createCasHistory)",
  budget: 'per-action reducer_ms (laws-ui/budget.js reducerBudget, run by validate) and browser p95/p99 (checkBudgets, browser-only); shape refused at declare (contract.js uiContract)',
  owner: 'actions carrying his words: noLoss law (laws-ui/trace.js checkNoLoss, run by validate); unknown action refused at declare',
  waits: 'lifecycle states that wait on the outside world: the exit edge must be declared (contract.js uiContract, at declare)',
  motion: 'gestures the frame laws watch (laws-ui/frames.js checkMotion, browser-only)',
  firstPaint: 'firstPaint/noFlash laws (laws-ui/trace.js checkFirstPaint, run by validate)',
  guards: '{ action: [guard] }: pure refusals run at dispatch before the reducer, thrown as ActionError; never in a fold (model.js checkGuards, guardError, dispatch)',
});

/** Axes the design names that nothing in the kit executes yet: declare refuses each with this reason. */
export const NOT_EXECUTED = Object.freeze({
  durability: 'not executed (row #24): use scope (ephemeral | local | cloud), storage: "tab" for session, durable: true for fsync-before-return; immutable is not built',
  protection: 'not executed (row #3): cloud entries are whole-entry E2E (lib/stream-worker.js); there is no per-field plaintext/e2e choice',
  cardinality: 'not executed (row #25): a declaration is one state; keyed families are recipes.keyed()',
  contentFields: 'not executed (row #44): partial replication with budgets exists only for append logs (engine/replica-store.js)',
  retention: 'not executed (row #39): no retention or hard delete in the kit',
  actor: 'not a declaration axis (row #13): the actor is per action, passed to dispatch(type, payload, { actor }) for guards',
  emits: 'not executed (rows #14, #34): the kit has no emit graph; derive with lib/views.js defineView instead',
});

/** Keys compile() writes into a declaration (never written by an author). */
export const COMPILED_KEYS = Object.freeze(['legacyArchive', 'legacyReplay']);

export const CONFLICT_MODELS = Object.freeze({
  lww: 'absolute actions over the one total order; law: re-applying an action is a no-op (idempotent)',
  log: 'the same total-order fold; law: a redelivered intent is a no-op (dedupe), and noLoss is checked',
});
export const CONFLICT_NOT_EXECUTED = Object.freeze({
  crdt: 'not executed (row #23): the kit has no CRDT merge; a CRDT rides as an action payload under conflict lww and the reducer merges it (GUIDE 1)',
});

export const UNDO_MODELS = Object.freeze(['compensating', 'none']);
export const UNDO_NOT_EXECUTED = Object.freeze({
  stack: 'not executed (row #26): snapshot undo is not built; use compensating (inverse from the captured pre-state)',
});

/** Why a spec key is refused, or null when declare accepts it. */
export function refusalFor(key) {
  if (Object.hasOwn(DECLARE_KEYS, key) || COMPILED_KEYS.includes(key)) return null;
  if (Object.hasOwn(NOT_EXECUTED, key)) return `"${key}" is ${NOT_EXECUTED[key]}`;
  return `unknown key "${key}" (declare takes: ${Object.keys(DECLARE_KEYS).join(', ')})`;
}

// ---- the registry validate() enumerates (lib/validate.js): every declare() lands here, by name (last wins) ----------
// Bounded: a keyed family (recipes.keyed) declares one state per key; past MAX_REGISTERED names the registry stops
// growing and counts what it missed, and validate() reports that coverage as incomplete instead of passing.
export const MAX_REGISTERED = 5000;
const registry = new Map();
let overflow = 0;
export function registerDeclaration(d) {
  if (!registry.has(d.name) && registry.size >= MAX_REGISTERED) { overflow += 1; return; }
  registry.set(d.name, d);
}
/** Every declaration made in this process so far, and how many names the bound turned away. */
export function declarations() { return { decls: [...registry.values()], overflow }; }
// Generators a kit module registers with the declarations it makes (lib/editor/declare.js for createEditor, lib/engine/
// rows-declare.js for openRows): validate() uses one when the app gives none for that name (gens[name] wins).
const generators = new Map();
export function registerGenerator(name, gen) { if (typeof gen === 'function' && (registry.has(name) || generators.size < MAX_REGISTERED)) generators.set(name, gen); }
export const generatorFor = (name) => generators.get(name) || null;
/** Tests only: start from an empty registry. */
export function clearDeclarations() { registry.clear(); generators.clear(); overflow = 0; }
