// The Docstore error hierarchy, kit form (DOCSTORE3-DESIGN section 6; P1:457-543; py src/docstore_core/l0/errors.py).
// Categorised by when they occur: boot (a declaration that can never run), app (a dispatch the declaration refuses),
// guard (a declared precondition said no, with a Resolution), runtime (the environment), async (a request's lifecycle).
// Every class carries its structured fields, a stable `code` (what callers and replays switch on), an HTTP `status`
// (P1:1190-1199) and a `kind` category, and renders deterministically: `Name(field=value, ...)`.
//
// Total reducers never throw these (A4): dispatch refuses with them before anything is logged, and a fold skips the same
// entries silently. Errors are classified for retry: only `transient` ones are retried, with capped backoff.

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : v instanceof Error ? `${v.name}` : JSON.stringify(v));

export class DocstoreError extends Error {
  /** fields: the structured context (copied onto the error). */
  constructor(fields = {}, { message = null, code = null } = {}) {
    super('');
    this.name = new.target.name;
    Object.assign(this, fields);
    this.fields = Object.keys(fields);
    this.code = code ?? this.code ?? new.target.code ?? new.target.name;
    this.message = message ?? `${this.name}(${this.fields.map((k) => `${k}=${show(fields[k])}`).join(', ')})`;
  }
  static kind = 'runtime';
  static status = 500;
  static transient = false;
  get kind() { return this.constructor.kind; }
  get status() { return this.constructor.status; }
  get transient() { return this.constructor.transient; }
}

// ---- boot: caught by validate()/declare before anything runs ----------------------------------------------------------
export class BootError extends DocstoreError { static kind = 'boot'; }
export class ReactiveGraphCycleError extends BootError {}         // { cycle, processes }
export class ImpureViewError extends BootError {}                 // { view_name, violation }
export class NonDeterministicComputeError extends BootError {}    // { function_name, violation }
export class SchemaConflictError extends BootError {}             // { schema_hash } (kit: { name, reason })

// ---- app: a dispatch the declaration refuses (400/422) -------------------------------------------------------------
export class AppError extends DocstoreError { static kind = 'app'; static status = 400; }
export class InvalidActionError extends AppError { static code = 'UnknownAction'; }           // { op, entity_type, valid_ops }
export class InvalidTransitionError extends AppError { static code = 'InvalidTransition'; }   // { from_state, to_state, valid_next }
export class InvalidPayloadError extends AppError { static status = 422; }                    // { op, missing, errors }
export class ReducerError extends AppError { static status = 500; }                            // { op, entity_type, cause }
export class SchemaValidationError extends AppError { static status = 422; }                   // { entity_type, field, value, constraint }

// ---- guard: a declared precondition refused the action (403 + Resolution) -------------------------------------------
/** Resolution (L1/WebAdapter): what the user can do about a refusal. type 'redirect' | 'action' | 'none'. */
export const resolution = ({ type = 'none', target = null, message = '', recoverable = false } = {}) => ({ type, target, message, recoverable });
export class ActionError extends DocstoreError {
  static kind = 'guard'; static status = 403;
  /** ActionError({ code: 'NOT_AUTHORIZED', message, context, resolution }) */
  constructor({ code, message = '', context = {}, resolution: r = null } = {}) {
    super({ code, context, resolution: r ? resolution(r) : null }, { message: `ActionError(${code}${message ? `: ${message}` : ''})`, code });
    this.detail = message;
  }
}

// ---- runtime: the environment (cannot be tested away) ---------------------------------------------------------------
export class CapabilityViolationError extends DocstoreError { static status = 403; }              // { app, attempted, allowed }
export class ConcurrencyConflictError extends DocstoreError { static status = 409; static code = 'ConcurrencyConflict'; } // { entity_type, entity_id, expected_version, actual_version }
export class IndexNotDeclaredError extends DocstoreError {}                                       // { entity_type, query_type }
export class ConnectivityError extends DocstoreError { static status = 503; static transient = true; } // { required_tier, retry_when_online }

// ---- async / saga: a request's lifecycle ------------------------------------------------------------------------------
export class AsyncError extends DocstoreError { static kind = 'async'; }
export class AsyncTimeoutError extends AsyncError { static status = 504; static transient = true; static code = 'AsyncTimeout'; } // { job_id, timeout_ms }
export class AsyncCancelledError extends AsyncError { static status = 499; static code = 'AsyncCancelled'; }                    // { job_id, cancel_actor }
export class AsyncFailedError extends AsyncError { static code = 'AsyncFailed'; }                                              // { job_id, error }
export class SagaStepFailedError extends AsyncError {}                                                                          // { saga_id, failed_step, compensation_ran }
export class SagaCompensationFailedError extends AsyncError {
  constructor(fields = {}) { super({ ...fields, requires_human: true }); } // always true: a failed compensation needs an operator
}

/** The plain shape of an error for a log entry or a wire (state stays JSON): { name, code, message, ...fields }. */
export function errorShape(e) {
  if (!e) return null;
  const out = { name: e.name || 'Error', code: e.code ?? e.name ?? 'Error', message: String(e.detail ?? e.message ?? e) };
  for (const k of e.fields || []) { const v = e[k]; if (v === undefined || typeof v === 'function' || v instanceof Error) continue; try { out[k] = JSON.parse(JSON.stringify(v)); } catch { /* not JSON */ } }
  return out;
}

export const ERRORS = {
  DocstoreError, BootError, ReactiveGraphCycleError, ImpureViewError, NonDeterministicComputeError, SchemaConflictError,
  AppError, InvalidActionError, InvalidTransitionError, InvalidPayloadError, ReducerError, SchemaValidationError,
  ActionError, CapabilityViolationError, ConcurrencyConflictError, IndexNotDeclaredError, ConnectivityError,
  AsyncError, AsyncTimeoutError, AsyncCancelledError, AsyncFailedError, SagaStepFailedError, SagaCompensationFailedError,
};
