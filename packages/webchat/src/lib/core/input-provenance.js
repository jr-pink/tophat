

export const CLASSES = ['typed', 'dictation', 'paste', 'autocorrect', 'unknown'];


export const GROUNDS = [
  'declared',      
  'corroborated',  
  'keystrokes',    
  'indeterminate'  
];

export const DECLARED = new Map([
  ['insertFromDictation', 'dictation'],   
  ['insertFromPaste', 'paste'],
  ['insertFromPasteAsQuotation', 'paste'],
  ['insertFromDrop', 'paste'],
  ['insertFromYank', 'paste']
]);

export const AMBIGUOUS = new Set([
  'insertText',
  'insertCompositionText'
]);

export const REPLACEMENTS = new Set(['insertReplacementText', 'insertTranspose']);


export const STRUCTURAL = new Set(['insertLineBreak', 'insertParagraph']);


export const DELETIONS = new Set([
  'deleteContentBackward',
  'deleteContentForward',
  'deleteContent',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteEntireSoftLine',
  'deleteHardLineBackward',
  'deleteHardLineForward',
  'deleteByDrag',
  'deleteByCut'
]);


export const HISTORY = new Set(['historyUndo', 'historyRedo']);

export const BURST_MIN_CHARS = 6;

export const SPAN_GAP_MS = 4_000;

export function classifyInsertion({ inputType, text = '', keystrokes = 0, composing = false } = {}) {
  const raw = normalizeInputType(inputType);
  const chars = [...String(text ?? '')].length;
  const signals = { chars, keystrokes, composing, burst: chars >= BURST_MIN_CHARS && keystrokes === 0 };

  const declared = raw !== null ? DECLARED.get(raw) : undefined;
  if (declared) return { klass: declared, grounds: 'declared', rawInputType: raw, signals };

  
  
  
  if (raw !== null && REPLACEMENTS.has(raw)) {
    return { klass: 'autocorrect', grounds: 'declared', rawInputType: raw, signals };
  }

  if (raw !== null && AMBIGUOUS.has(raw)) {
    
    
    
    if (signals.burst) {
      return { klass: 'dictation', grounds: 'corroborated', rawInputType: raw, signals };
    }
    if (keystrokes > 0) {
      return { klass: 'typed', grounds: 'keystrokes', rawInputType: raw, signals };
    }
    
    
    
    return { klass: 'unknown', grounds: 'indeterminate', rawInputType: raw, signals };
  }

  
  
  return { klass: 'unknown', grounds: 'indeterminate', rawInputType: raw, signals };
}

export function normalizeInputType(inputType) {
  return typeof inputType === 'string' && inputType !== '' ? inputType : null;
}


export function eventKind(inputType) {
  const raw = normalizeInputType(inputType);
  if (raw === null) return 'insert';
  if (STRUCTURAL.has(raw)) return 'newline';
  if (DELETIONS.has(raw)) return 'delete';
  if (HISTORY.has(raw)) return 'history';
  if (DECLARED.has(raw) || AMBIGUOUS.has(raw) || REPLACEMENTS.has(raw)) return 'insert';
  if (raw.startsWith('format')) return 'format';
  if (raw.startsWith('insert')) return 'insert';
  if (raw.startsWith('delete')) return 'delete';
  return 'other';
}

export function initialProvenance({ sessionId = null, conversationId = null } = {}) {
  return {
    sessionId,
    conversationId,
    open: null,        
    keystrokes: 0,     
    composing: false,
    
    
    
    pendingEnter: null,
    
    
    dropped: 0
  };
}


export const SPAN_MAX_CHARS = 20_000;

function openSpan(state, at, mono, klass, result) {
  return {
    session_id: state.sessionId,
    conversation_id: state.conversationId,
    class: klass,
    grounds: result.grounds,
    raw_input_types: [result.rawInputType],
    text: '',
    chars: 0,
    keystrokes: 0,
    started_at: at,
    ended_at: at,
    started_mono_ms: mono,
    ended_mono_ms: mono
  };
}

function closeSpan(span) {
  if (!span) return null;
  return { ...span, duration_ms: Math.max(0, Math.round(span.ended_mono_ms - span.started_mono_ms)) };
}

function newlineRow(state, { at, mono, offset, inputType, grounds }) {
  return {
    session_id: state.sessionId,
    conversation_id: state.conversationId,
    class: 'newline',
    grounds,
    raw_input_types: [inputType ?? null],
    text: '\n',
    chars: 1,
    offset: typeof offset === 'number' ? offset : null,
    keystrokes: state.keystrokes,
    started_at: at,
    ended_at: at,
    started_mono_ms: mono,
    ended_mono_ms: mono,
    duration_ms: 0
  };
}

export function provenanceStep(state, event) {
  const rows = [];
  const at = event.at ?? null;
  const mono = typeof event.mono === 'number' ? event.mono : 0;

  switch (event.type) {
    case 'key': {
      
      
      
      
      
      
      if (event.key === 'Enter') {
        return {
          state: {
            ...state,
            pendingEnter: { at, mono, offset: event.offset ?? null, shift: event.shift === true }
          },
          rows
        };
      }
      
      
      
      if (event.printable === false) return { state, rows };
      return { state: { ...state, keystrokes: state.keystrokes + 1 }, rows };
    }

    case 'composition':
      return { state: { ...state, composing: event.phase === 'start' }, rows };

    case 'insert': {
      const kind = eventKind(event.inputType);

      if (kind === 'newline') {
        
        
        
        
        if (state.open) rows.push(closeSpan(state.open));
        rows.push(newlineRow(state, {
          at, mono, offset: event.offset, inputType: event.inputType, grounds: 'declared'
        }));
        return { state: { ...state, open: null, keystrokes: 0, pendingEnter: null }, rows };
      }

      
      
      if (state.pendingEnter) {
        if (state.open) rows.push(closeSpan(state.open));
        rows.push(newlineRow(state, { ...state.pendingEnter, inputType: null, grounds: 'keystrokes' }));
        state = { ...state, open: null, pendingEnter: null };
      }

      if (kind === 'delete' || kind === 'history') {
        
        
        
        if (state.open) rows.push(closeSpan(state.open));
        rows.push({
          session_id: state.sessionId,
          conversation_id: state.conversationId,
          class: kind === 'history' ? 'history' : 'delete',
          grounds: 'declared',
          raw_input_types: [event.inputType],
          text: '',
          chars: 0,
          removed: typeof event.removed === 'number' ? event.removed : null,
          keystrokes: state.keystrokes,
          started_at: at,
          ended_at: at,
          started_mono_ms: mono,
          ended_mono_ms: mono,
          duration_ms: 0
        });
        return { state: { ...state, open: null, keystrokes: 0 }, rows };
      }

      if (kind !== 'insert') {
        
        
        return { state, rows };
      }

      const result = classifyInsertion({
        inputType: event.inputType,
        text: event.text,
        keystrokes: state.keystrokes,
        composing: state.composing
      });

      let open = state.open;
      const gapped = open && mono - open.ended_mono_ms > SPAN_GAP_MS;
      const changed = open && open.class !== result.klass;
      const full = open && open.chars >= SPAN_MAX_CHARS;
      if (open && (gapped || changed || full)) {
        rows.push(closeSpan(open));
        open = null;
      }
      if (!open) open = openSpan(state, at, mono, result.klass, result);

      const text = String(event.text ?? '');
      open = {
        ...open,
        
        
        text: open.text + text,
        chars: open.chars + [...text].length,
        keystrokes: open.keystrokes + state.keystrokes,
        raw_input_types: open.raw_input_types.includes(result.rawInputType)
          ? open.raw_input_types
          : [...open.raw_input_types, result.rawInputType],
        
        
        grounds: open.grounds === 'declared' ? 'declared' : result.grounds,
        ended_at: at,
        ended_mono_ms: mono
      };
      return { state: { ...state, open, keystrokes: 0 }, rows };
    }

    case 'boundary': {
      
      
      
      
      
      
      if (state.pendingEnter && state.pendingEnter.shift === true) {
        if (state.open) rows.push(closeSpan(state.open));
        rows.push(newlineRow(state, { ...state.pendingEnter, inputType: null, grounds: 'keystrokes' }));
        state = { ...state, open: null };
      }
      
      if (state.open) rows.push({ ...closeSpan(state.open), boundary: event.reason ?? null });
      return { state: { ...state, open: null, keystrokes: 0, pendingEnter: null }, rows };
    }

    default:
      
      
      
      
      return { state, rows };
  }
}


export function provenanceRun(state, events) {
  const rows = [];
  let at = state;
  for (const event of events) {
    const next = provenanceStep(at, event);
    at = next.state;
    rows.push(...next.rows);
  }
  return { state: at, rows };
}
