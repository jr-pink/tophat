

export const HOLD_FLOOR_SEC = 0.35;

export const HOLD_ARM_MS = 250;

export const HOLD_CEILING_MS = 120_000;


const ACTIVATABLE = 'button, summary, select, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], a[href]';


const MODAL = '[aria-modal="true"], [role="dialog"]';


export function isSpaceKey(event) {
  return event?.key === ' ' || event?.key === 'Spacebar' || event?.code === 'Space';
}

export function pushToTalkDecision(event, context = {}) {
  if (!isSpaceKey(event)) return 'pass';
  if (context.available === false) return 'pass';

  
  
  if (event.isComposing) return 'pass';

  
  
  
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return 'pass';

  
  
  
  
  
  if (event.repeat) return context.recording || context.pending ? 'suppress' : 'pass';
  if (context.recording || context.pending) return 'suppress';

  if (context.modal) return 'pass';

  
  
  
  
  
  
  
  
  if (context.editable) {
    if (!context.ownComposer) return 'pass';
    return context.draftEmpty ? 'start' : 'arm';
  }

  
  
  if (context.activatable) return 'pass';

  return 'start';
}


export function contextFor(target, { composer = null, draft = '', recording = false, pending = false, available = true } = {}) {
  const element = target instanceof HTMLElement ? target : null;
  const editable = Boolean(element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable));
  return {
    editable,
    ownComposer: Boolean(composer && element === composer),
    draftEmpty: String(draft ?? '').trim() === '',
    modal: Boolean(element?.closest?.(MODAL)),
    activatable: Boolean(element?.closest?.(ACTIVATABLE)),
    recording,
    pending: Boolean(pending),
    available
  };
}

export function tooShort(durationSec) {
  const seconds = Number(durationSec);
  if (!Number.isFinite(seconds)) return true;
  return seconds < HOLD_FLOOR_SEC;
}

export function releaseAction({ pending = false, recording = false } = {}) {
  if (pending) return 'type_space';
  if (recording) return 'stop';
  return 'nothing';
}

export function interruptAction({ pending = false } = {}) {
  return pending ? 'flush' : 'nothing';
}
