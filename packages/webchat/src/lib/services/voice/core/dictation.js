

export const STATES = ['off', 'idle', 'recording', 'blocked'];

export const PHASES = ['storing', 'transcribing', 'ready', 'failed'];

export const EFFECTS = ['start_mic', 'stop_mic', 'upload', 'insert', 'report'];

export const STORE_CEILING_MS = 45_000;
export const TRANSCRIBE_CEILING_MS = 90_000;

export function initialDictation({ enabled = false } = {}) {
  return {
    enabled,
    state: enabled ? 'idle' : 'off',
    
    
    
    
    utterances: [],
    capturedIds: [],
    
    error: null
  };
}

function withEffects(state, effects) {
  return { dictation: state, effects };
}

function patch(state, id, fields) {
  return {
    ...state,
    utterances: state.utterances.map((u) => (u.id === id ? { ...u, ...fields } : u))
  };
}

function transition(state, input) {
  const at = state.state;
  switch (input.type) {
    
    case 'enable':
      if (state.enabled) return withEffects(state, []);
      
      
      
      
      return withEffects({ ...state, enabled: true, state: 'idle', error: null }, []);
    case 'disable': {
      if (!state.enabled) return withEffects(state, []);
      
      
      
      const effects = at === 'recording' ? [{ type: 'stop_mic' }] : [];
      return withEffects({ ...state, enabled: false, state: 'off', error: null }, effects);
    }

    
    case 'press': {
      if (at === 'off') return withEffects(state, []);
      if (at === 'recording') return withEffects({ ...state, state: 'idle' }, [{ type: 'stop_mic' }]);
      
      
      
      return withEffects({ ...state, state: 'recording', error: null }, [{ type: 'start_mic' }]);
    }
    case 'denied':
      
      
      
      if (!state.enabled) return withEffects(state, []);
      return withEffects(
        { ...state, state: 'blocked', error: input.reason || 'The microphone was refused.' },
        [{ type: 'stop_mic' }]
      );
    case 'unsupported':
      if (!state.enabled) return withEffects(state, []);
      return withEffects(
        { ...state, state: 'blocked', error: input.reason || 'This browser cannot record.' },
        [{ type: 'stop_mic' }]
      );
    case 'dismiss':
      if (at !== 'blocked') return withEffects(state, []);
      return withEffects({ ...state, state: state.enabled ? 'idle' : 'off', error: null }, []);

    
    case 'captured': {
      
      
      
      if (!input.id) return withEffects(state, []);
      if ((state.capturedIds || []).includes(input.id) || state.utterances.some((u) => u.id === input.id)) return withEffects(state, []);
      const utterance = {
        id: input.id,
        phase: 'storing',
        asr: null,
        error: null,
        
        
        inserted: false,
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        heard: null,
        at: input.at ?? null,
        durationSec: input.durationSec ?? null,
        
        attempts: 0
      };
      return withEffects(
        { ...state, state: at === 'recording' ? 'idle' : at, utterances: [...state.utterances, utterance], capturedIds: [...(state.capturedIds || []), input.id] },
        [{ type: 'upload', id: input.id }]
      );
    }
    case 'stored': {
      const found = state.utterances.find((u) => u.id === input.id);
      if (!found || found.phase !== 'storing') return withEffects(state, []);
      return withEffects(patch(state, input.id, { phase: 'transcribing' }), []);
    }
    case 'transcribed': {
      const found = state.utterances.find((u) => u.id === input.id);
      
      
      
      if (!found || (found.phase !== 'transcribing' && found.phase !== 'storing')) {
        return withEffects(state, []);
      }
      const text = String(input.text ?? '');
      
      
      
      return withEffects(
        patch(state, input.id, { phase: 'ready', asr: text, error: null, engine: input.engine ?? null }),
        []
      );
    }
    case 'failed': {
      const found = state.utterances.find((u) => u.id === input.id);
      if (!found) return withEffects(state, []);
      // The words landed from the live decode and the clip upload is what
      // failed. That is a record to retry, not a transcript to mourn: the
      // phase stays ready, nothing spins, and the note still offers the retry.
      if (found.phase === 'ready') {
        return withEffects(patch(state, input.id, {
          uploadError: input.reason || 'That recording could not be stored.',
          attempts: (found.attempts || 0) + 1
        }), []);
      }
      const fields = {
        phase: 'failed',
        error: input.reason || 'That recording could not be transcribed.',
        attempts: (found.attempts || 0) + 1
      };
      
      
      
      
      
      
      
      const words = String(found.heard ?? '');
      if (!words.trim() || found.inserted) return withEffects(patch(state, input.id, fields), []);
      return withEffects(
        patch(state, input.id, { ...fields, inserted: true }),
        [{ type: 'insert', id: input.id, text: words, raw: words, punctuationEdits: [] }]
      );
    }
    case 'retry': {
      const found = state.utterances.find((u) => u.id === input.id);
      if (!found) return withEffects(state, []);
      if (found.uploadError) {
        // Only the record is being retried.
        return withEffects(patch(state, input.id, { uploadError: null, error: null }), [{ type: 'upload', id: input.id }]);
      }
      if (found.phase !== 'failed') return withEffects(state, []);
      return withEffects(patch(state, input.id, { phase: 'storing', error: null }), [{ type: 'upload', id: input.id }]);
    }
    case 'heard': {
      
      const found = state.utterances.find((u) => u.id === input.id);
      if (!found) return withEffects(state, []);
      return withEffects(patch(state, input.id, { heard: String(input.text ?? '') }), []);
    }
    case 'drop': {
      
      
      if (!state.utterances.some((u) => u.id === input.id)) return withEffects(state, []);
      return withEffects(
        { ...state, utterances: state.utterances.filter((u) => u.id !== input.id) },
        []
      );
    }

    
    case 'sent': {
      
      
      
      const reportable = state.utterances.filter((u) => u.phase === 'ready');
      if (!reportable.length) {
        
        
        
        
        return withEffects({ ...state, utterances: [] }, []);
      }
      return withEffects({ ...state, utterances: [] }, [{ type: 'report', utterances: reportable }]);
    }

    default:
      return withEffects(state, []);
  }
}

function release(state) {
  const effects = [];
  let utterances = state.utterances;
  for (const utterance of state.utterances) {
    if (utterance.phase === 'storing' || utterance.phase === 'transcribing') break;
    if (utterance.phase !== 'ready' || utterance.inserted) continue;
    utterances = utterances.map((u) => (u.id === utterance.id ? { ...u, inserted: true } : u));
    
    
    
    
    
    
    
    
    const spoken = applySpokenPunctuation(utterance.asr ?? '');
    if (spoken.text.trim()) {
      effects.push({
        type: 'insert',
        id: utterance.id,
        text: spoken.text,
        raw: String(utterance.asr ?? ''),
        punctuationEdits: spoken.edits
      });
    }
  }
  return { dictation: utterances === state.utterances ? state : { ...state, utterances }, effects };
}

export function nextDictation(state, input) {
  const first = transition(state, input);
  const second = release(first.dictation);
  return { dictation: second.dictation, effects: [...first.effects, ...second.effects] };
}

export function violations(state) {
  const out = [];
  if (!STATES.includes(state.state)) out.push(`unknown state ${state.state}`);
  if (!state.enabled && state.state === 'recording') out.push('recording while disabled');
  if (!state.enabled && state.state === 'idle') out.push('idle while disabled');
  if (!state.enabled && state.state === 'blocked') out.push('blocked while disabled');
  if (state.state === 'blocked' && !state.error) out.push('blocked with nothing to say');
  if (state.state !== 'blocked' && state.error) out.push('an error nobody is showing');
  const ids = new Set();
  for (const u of state.utterances) {
    if (ids.has(u.id)) out.push(`utterance ${u.id} is queued twice`);
    ids.add(u.id);
    if (!PHASES.includes(u.phase)) out.push(`unknown phase ${u.phase}`);
    if (u.phase === 'ready' && typeof u.asr !== 'string') out.push(`${u.id} is ready with no transcript`);
    if (u.phase === 'failed' && !u.error) out.push(`${u.id} failed with no reason`);
  }
  return out;
}

export function inFlight(state) {
  return state.utterances.filter((u) => u.phase === 'storing' || u.phase === 'transcribing');
}

export function tokenize(text) {
  const out = [];
  const re = /\S+/gu;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function normalizeWord(word) {
  return String(word ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '');
}

export function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  
  
  if (n === 0 || m === 0 || n * m > 4_000_000) return [];
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i += 1;
    else j += 1;
  }
  return pairs;
}

export function alignSlices(hypotheses, finalText) {
  const hyps = (hypotheses || []).map((h) => String(h ?? ''));
  if (!hyps.length) return [];
  const final = String(finalText ?? '');
  const finalTokens = tokenize(final);
  if (hyps.length === 1) {
    return [{ text: final.trim(), confidence: overlap(tokenize(hyps[0]), finalTokens) }];
  }

  
  const flat = [];
  const owner = [];
  hyps.forEach((hyp, index) => {
    for (const token of tokenize(hyp)) { flat.push(token); owner.push(index); }
  });

  const pairs = lcsPairs(flat.map((t) => normalizeWord(t.word)), finalTokens.map((t) => normalizeWord(t.word)));
  
  const reach = new Array(hyps.length).fill(-1);
  for (const [h, f] of pairs) reach[owner[h]] = Math.max(reach[owner[h]], f);

  
  
  
  const cuts = [];
  let last = 0;
  for (let index = 0; index < hyps.length; index += 1) {
    const end = reach[index] < 0 ? last : Math.max(last, reach[index] + 1);
    cuts.push(end);
    last = end;
  }
  
  cuts[cuts.length - 1] = finalTokens.length;

  const out = [];
  let from = 0;
  for (let index = 0; index < hyps.length; index += 1) {
    const to = cuts[index];
    const slice = finalTokens.slice(from, to);
    const text = slice.length ? final.slice(slice[0].start, slice[slice.length - 1].end) : '';
    out.push({ text: text.trim(), confidence: overlap(tokenize(hyps[index]), slice) });
    from = to;
  }
  return out;
}

function overlap(aTokens, bTokens) {
  const a = aTokens.map((t) => normalizeWord(t.word)).filter(Boolean);
  const b = bTokens.map((t) => normalizeWord(t.word)).filter(Boolean);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const common = lcsPairs(a, b).length;
  return Number((common / Math.max(a.length, b.length)).toFixed(4));
}

export function wordErrorRate(hypothesis, reference) {
  const hyp = tokenize(hypothesis).map((t) => normalizeWord(t.word)).filter(Boolean);
  const ref = tokenize(reference).map((t) => normalizeWord(t.word)).filter(Boolean);
  if (!ref.length) return hyp.length ? 1 : 0;
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i += 1) {
    const row = new Array(hyp.length + 1);
    row[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      row[j] = ref[i - 1] === hyp[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return Number((prev[hyp.length] / ref.length).toFixed(4));
}

export function charDiff(before, after, { maxOps = 200, maxRun = 400 } = {}) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  if (!removed && !added) return [];
  const ops = [];
  if (removed) ops.push({ op: 'del', at: head, text: clip(removed, maxRun) });
  if (added) ops.push({ op: 'ins', at: head, text: clip(added, maxRun) });
  return ops.slice(0, maxOps);
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`;
}

export function editDistance(before, after, { ceiling = 20_000 } = {}) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (a === b) return 0;
  if (a.length * b.length > ceiling * ceiling) return Math.abs(a.length - b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array(b.length + 1);
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

export function stripAttachmentBlock(text) {
  return String(text ?? '').replace(/\n\nAttached files?:\n(?:- [^\n]*\n?)+$/u, '').trimEnd();
}

export function isEdited(hypothesis, finalText) {
  return String(hypothesis ?? '').trim() !== String(finalText ?? '').trim();
}

export const SPOKEN_PUNCTUATION = [
  'comma', 'period', 'full stop', 'question mark', 'exclamation mark',
  'exclamation point', 'semicolon', 'semi colon', 'colon', 'apostrophe',
  'hyphen', 'dash', 'em dash', 'open paren', 'close paren', 'open quote',
  'close quote', 'quote', 'unquote', 'new line', 'newline', 'new paragraph',
  'open parenthesis', 'close parenthesis', 'open parentheses',
  'close parentheses', 'open bracket', 'close bracket', 'end quote'
];

export function punctuationMarks(text) {
  return String(text ?? '').match(/[.,;:!?'"()\[\]{}\u2014\u2013-]/gu) || [];
}

export const PUNCTUATION_MARK = {
  comma: ',', period: '.', 'full stop': '.', 'question mark': '?',
  'exclamation mark': '!', 'exclamation point': '!', semicolon: ';',
  'semi colon': ';', colon: ':', apostrophe: "'", hyphen: '-', dash: '-',
  'em dash': '\u2014', 'open paren': '(', 'close paren': ')', 'open quote': '"',
  'close quote': '"', quote: '"', unquote: '"', 'new line': '\n',
  newline: '\n', 'new paragraph': '\n\n',
  'open parenthesis': '(', 'close parenthesis': ')', 'open parentheses': '(',
  'close parentheses': ')', 'open bracket': '[', 'close bracket': ']',
  'end quote': '"'
};

const WHITESPACE_PHRASES = new Set(['new line', 'newline', 'new paragraph']);

/**
 * Marks that belong to the word AFTER the command rather than the one before.
 * Everything else here closes a span and hangs off the preceding word; these
 * open one, and placing them backwards gives "the result( fifty percent)".
 */
const OPENING_PHRASES = new Set([
  'open paren', 'open parenthesis', 'open parentheses', 'open bracket',
  'open quote'
]);

/** What the transcriber writes when it mishears a punctuation phrase, mapped to
 * the phrase he actually said.
 *
 * "questioner" is not a rendering choice like "questionmark". Because these are
 * also ordinary English words, they are acted on ONLY where a mark sits beside
 * them or they end the utterance, never on a clause boundary alone, and they are
 * kept out of the spokenPunctuation record so the training record still says
 * what was really emitted.
 */
export const MISHEARD_PUNCTUATION = {
  questioner: 'question mark',
  questioners: 'question mark',
  'question marc': 'question mark',
  'closed paren': 'close paren',
  'closed parenthesis': 'close parenthesis',
  'closed parentheses': 'close parentheses',
  'closed bracket': 'close bracket',
  'closed quote': 'close quote'
};

const PHRASES = [
  ...SPOKEN_PUNCTUATION.map((heard) => ({ heard, phrase: heard, misheard: false })),
  ...Object.entries(MISHEARD_PUNCTUATION).map(([heard, phrase]) => ({ heard, phrase, misheard: true }))
]
  .map(({ heard, phrase, misheard }) => {
    const words = heard.split(' ').map(normalizeWord);
    return { heard, phrase, misheard, words, joined: words.length > 1 ? words.join('') : null };
  })
  .sort((a, b) => b.words.length - a.words.length || b.heard.length - a.heard.length);

function isMarkToken(token) {
  return Boolean(token) && normalizeWord(token.word) === '' && /[^\s]/u.test(token.word);
}

function leadOf(word) {
  return String(word ?? '').match(/^[^\p{L}\p{N}]*/u)[0];
}

function trailOf(word) {
  return String(word ?? '').match(/[^\p{L}\p{N}]*$/u)[0];
}

function occurrences(tokens, norm, { includeMisheard = false } = {}) {
  const found = [];
  let i = 0;
  while (i < tokens.length) {
    let hit = null;
    for (const candidate of PHRASES) {
      if (candidate.misheard && !includeMisheard) continue;
      const base = { phrase: candidate.phrase, heard: candidate.heard, misheard: candidate.misheard };
      if (candidate.joined && norm[i] === candidate.joined) {
        hit = { ...base, from: i, to: i };
        break;
      }
      const n = candidate.words.length;
      if (i + n > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < n; k += 1) if (norm[i + k] !== candidate.words[k]) { ok = false; break; }
      if (ok) { hit = { ...base, from: i, to: i + n - 1 }; break; }
    }
    if (hit) { found.push(hit); i = hit.to + 1; } else i += 1;
  }
  return found;
}

export function spokenPunctuation(text) {
  const tokens = tokenize(text);
  const norm = tokens.map((t) => normalizeWord(t.word));
  return occurrences(tokens, norm).map((o) => o.phrase);
}

export function punctuationRegime(hypothesis, finalText) {
  const words = spokenPunctuation(hypothesis);
  if (words.length) return 'literal';
  if (punctuationMarks(hypothesis).length || punctuationMarks(finalText).length) return 'prosodic';
  return 'none';
}

// ------------------------------------------------- the spoken command layer
//
// EVERY punctuation phrase he speaks becomes its mark. No clause detection, no
// premodifier or continuer vetoes, no second pass.
//
// It should just be simple, and it seems like the forward-backward is going to
// have a lot of bugs.
//
// SUPERSEDED, which is why the tests changed with it: until that instruction
// the layer tried to tell a command from a mention ("the Oxford comma is
// contentious") with three tests over the neighbouring words, on the principle
// that under-triggering was the cheap direction. It cost ordinary dictation
// instead, since "ship it period new line then tell me" came back with both
// words still in it. His instruction governs. A sentence where he really means
// to talk ABOUT a comma now loses, and he fixes that one by hand.
//
// Two mechanical things survive, neither a judgement about English:
//
//   1. Whisper emits the WORD and also places the MARK it heard in his
//      prosody, so the word is deleted and the adjacent mark KEPT rather than
//      a second one added. Without this every spoken comma doubles.
//   2. A stronger mark replaces a weaker one rather than stacking on it, which
//      is what turns "are you sure, question mark" into "are you sure?".
//
// The one thing still conditional is a transcriber MISHEARING ("questioner"
// for "question mark"): those are ordinary English words he did not say, so
// they need a mark beside them or the end of the utterance to count.

/** How strongly a mark closes. A stronger one replaces a weaker one rather than stacking. */
function markRank(mark) {
  if (mark === ',') return 1;
  if (mark === ';' || mark === ':') return 2;
  if (mark === '.' || mark === '!' || mark === '?') return 3;
  return 0;
}

/**
 * Every punctuation phrase in the text, with the span it covers and the mark it
 * becomes. Pure and inspectable: the tests read this, and so does the record.
 */
export function punctuationCommands(text) {
  const source = String(text ?? '');
  const tokens = tokenize(source);
  const norm = tokens.map((t) => normalizeWord(t.word));
  const out = [];
  for (const hit of occurrences(tokens, norm, { includeMisheard: true })) {
    const { phrase, from } = hit;
    let { to } = hit;
    const mark = PUNCTUATION_MARK[phrase];
    const whitespace = WHITESPACE_PHRASES.has(phrase);
    // Whisper sometimes writes the mark as its own token, "questionmark ?". It
    // is the same double emission as "comma,", so it is absorbed into the span;
    // leaving it behind puts "iOS? ?" in his box.
    // Any bare sentence mark, not only the matching one: "the Oxford comma ."
    // is Whisper punctuating that spot, and leaving the stray token behind
    // writes "the Oxford, .". The stronger of the two is the one placed.
    const following = !whitespace && to + 1 < tokens.length && isMarkToken(tokens[to + 1])
      ? (tokens[to + 1].word.match(/[.,;:!?]/gu) || []).pop() || null
      : null;
    const absorbed = Boolean(following);
    if (absorbed) to += 1;
    const prevRaw = from > 0 ? tokens[from - 1].word : null;
    // Whisper's own mark, hanging off the command word or off the word in
    // front of it. Never for a whitespace command, which has no mark.
    const trailing = !whitespace && trailOf(tokens[to].word).includes(mark);
    const leading = !whitespace && from > 0 && trailOf(prevRaw).includes(mark);
    const atEnd = to === tokens.length - 1;
    const whisperMark = trailing || leading;
    const command = !hit.misheard || whisperMark || atEnd;
    out.push({
      phrase,
      heard: hit.heard,
      misheard: Boolean(hit.misheard),
      opening: OPENING_PHRASES.has(phrase),
      mark,
      whitespace,
      command,
      why: command ? (hit.misheard ? 'misheard' : 'spoken') : null,
      veto: command ? null : 'weak-hearing',
      whisperMark,
      absorbed,
      absorbedMark: following,
      at: tokens[from].start,
      end: tokens[to].end,
      from,
      to,
      adjacentMark: leading || (trailing && !atEnd)
    });
  }
  return out;
}

export function applySpokenPunctuation(text) {
  const source = String(text ?? '');
  const all = punctuationCommands(source);
  const commands = all.filter((c) => c.command);
  if (!commands.length) return { text: source, changed: false, edits: [] };
  
  
  
  
  
  const declined = new Set();
  for (const c of all) if (!c.command) for (let k = c.from; k <= c.to; k += 1) declined.add(k);
  // Tokens belonging to a command this pass will ACT on. They are still
  // standing while an earlier command is being placed, and a mark or a capital
  // must not land on one: "ship it period new line then" capitalised "New" and
  // then deleted it, leaving "then" lowercase at the head of its line.
  const commanded = new Set();
  for (const c of all) if (c.command) for (let k = c.from; k <= c.to; k += 1) commanded.add(k);

  const tokens = tokenize(source);
  const parts = tokens.map((t, i) => ({
    word: t.word,
    gap: i < tokens.length - 1 ? source.slice(t.end, tokens[i + 1].start) : '',
    dropped: false
  }));
  const head = tokens.length ? source.slice(0, tokens[0].start) : source;
  const tail = tokens.length ? source.slice(tokens[tokens.length - 1].end) : '';

  const edits = [];
  for (const command of commands) {
    // The mark actually written: the phrase's own, unless it swallowed a
    // stronger one Whisper had already put in that spot.
    const mark = command.absorbedMark && markRank(command.absorbedMark) > markRank(command.mark)
      ? command.absorbedMark
      : command.mark;
    const from = command.from;
    const last = command.to;
    const gapAfter = parts[last].gap;
    const wasLast = last === tokens.length - 1;

    
    
    
    
    let host = from - 1;
    const before = [];
    while (host >= 0 && (parts[host].dropped || isMarkToken(tokens[host]))) {
      if (!parts[host].dropped && isMarkToken(tokens[host])) before.push(host);
      host -= 1;
    }
    if (host >= 0 && declined.has(host)) continue;
    for (let k = from; k <= last; k += 1) parts[k].dropped = true;
    for (const k of before) parts[k].dropped = true;

    let action = 'dropped-word';
    if (command.opening) {
      // The one mark that moves forwards. "the result open paren fifty percent
      // close paren was" is "the result (fifty percent) was", so the bracket is
      // stuck to the front of the next word that survives rather than to the
      // back of the last one.
      let after = last + 1;
      while (after < parts.length && (parts[after].dropped || commanded.has(after))) after += 1;
      if (after < parts.length && !declined.has(after)) {
        parts[after].word = mark + parts[after].word;
        action = 'inserted-open';
      }
    } else if (host >= 0) {
      if (command.whitespace) {
        
        
        parts[host].word = parts[host].word.replace(/,$/u, '');
        parts[host].gap = mark;
        action = 'inserted-break';
      } else {
        const trail = trailOf(parts[host].word).replace(/[^,.;:!?]/gu, '');
        const spaced = before.map((k) => parts[k].word).join('').replace(/[^,.;:!?]/gu, '');
        const existing = (trail + spaced).slice(-1);
        if (!existing) {
          parts[host].word += mark;
          action = command.whisperMark ? 'kept-mark' : 'inserted-mark';
        } else if (markRank(mark) > markRank(existing)) {
          parts[host].word = parts[host].word.replace(/[,;:]+(?=[^\p{L}\p{N}]*$)/u, '') + mark;
          action = 'promoted-mark';
        } else {
          
          
          
          if (!trail) parts[host].word += existing;
          action = 'kept-mark';
        }
        parts[host].gap = wasLast ? '' : (gapAfter || ' ');
      }
    } else if (!wasLast) {
      
      
      action = 'dropped-word';
    }

    
    
    
    
    
    
    
    let opensSentence = false;
    if (!command.whitespace && !command.opening) {
      if (host >= 0) {
        const trail = trailOf(parts[host].word).replace(/[^,.;:!?]/gu, '').slice(-1);
        opensSentence = trail === '.' || trail === '!' || trail === '?';
      } else {
        
        opensSentence = true;
      }
    }
    if (opensSentence) {
      let after = last + 1;
      while (after < parts.length && (parts[after].dropped || commanded.has(after))) after += 1;
      if (after < parts.length) {
        const word = parts[after].word;
        const lead = leadOf(word);
        const body = word.slice(lead.length);
        if (/^[a-z]/u.test(body) && body === body.toLowerCase()) {
          parts[after].word = lead + body[0].toUpperCase() + body.slice(1);
        }
      }
    }

    edits.push({ phrase: command.phrase, mark, at: command.at, why: command.why, action });
  }

  if (!edits.length) return { text: source, changed: false, edits: [] };
  const body = parts.filter((p) => !p.dropped).map((p) => p.word + p.gap).join('');
  const next = (head + body + tail).replace(/[ \t]+\n/gu, '\n').trimEnd();
  return { text: next, changed: next !== source, edits };
}

export function clipRow({
  clipId, sessionId, path, at, durationSec, sampleRate, bytes,
  deviceId, userAgent, inputDevice = null, condition = null, conversationId = null
}) {
  return {
    clip_id: clipId,
    path,
    session_id: sessionId,
    
    
    
    mode: 'dictation',
    source: 'webchat',
    condition,
    input_device: inputDevice,
    conversation_id: conversationId,
    recorded_at: at,
    duration_sec: durationSec,
    sample_rate: sampleRate,
    bytes,
    device_id: deviceId,
    user_agent: userAgent,
    
    
    asr_text: null,
    text: null
  };
}

export function hypothesisRow({ clipId, asrText, engine, engineModel, latencyMs, at }) {
  return {
    type: 'correction',
    clip_id: clipId,
    reason: 'asr',
    corrected_at: at,
    asr_text: asrText,
    engine,
    engine_model: engineModel,
    asr_latency_ms: latencyMs
  };
}

export function correctionRow({ clipId, asrText, finalText, confidence, at, sentAt, shownText = null, shownEngine = null }) {
  const hypothesis = String(asrText ?? '');
  const target = String(finalText ?? '');
  
  
  
  
  
  
  
  
  
  const shown = typeof shownText === 'string' && shownText.trim() ? shownText : null;
  const edited = isEdited(hypothesis, target);
  const spoken = applySpokenPunctuation(hypothesis);
  return {
    type: 'correction',
    clip_id: clipId,
    reason: 'sent',
    corrected_at: at,
    
    
    
    
    text: target,
    edited,
    edit_distance: editDistance(hypothesis, target),
    wer: wordErrorRate(hypothesis, target),
    
    
    
    
    
    punctuation_only: edited && wordErrorRate(hypothesis, target) === 0,
    
    
    punctuation_regime: punctuationRegime(hypothesis, target),
    asr_punctuation_words: spokenPunctuation(hypothesis),
    asr_punctuation_marks: punctuationMarks(hypothesis).length,
    text_punctuation_marks: punctuationMarks(target).length,
    
    
    
    
    
    spoken_punctuation_text: spoken.changed ? spoken.text : null,
    spoken_punctuation_edits: spoken.edits,
    
    
    
    spoken_punctuation_wer: spoken.changed ? wordErrorRate(spoken.text, target) : null,
    diff: charDiff(hypothesis, target),
    shown_text: shown,
    shown_engine: shown ? (shownEngine || null) : null,
    
    
    
    
    shown_wer: shown ? wordErrorRate(shown, target) : null,
    align_confidence: confidence,
    sent_at: sentAt
  };
}

export function rowsForSend({ utterances, finalText, at, sentAt }) {
  const clean = stripAttachmentBlock(finalText);
  const slices = alignSlices(utterances.map((u) => u.asr ?? ''), clean);
  return utterances.map((u, index) => correctionRow({
    clipId: u.id,
    asrText: u.asr ?? '',
    finalText: slices[index]?.text ?? '',
    confidence: slices[index]?.confidence ?? 0,
    at,
    sentAt,
    shownText: u.shown ?? null,
    shownEngine: u.shownEngine ?? null
  }));
}

const ATTACHING = /^[,.;:!?%)\]}'’"”]/u;

export function spliceDictation({ value = '', start = 0, end = start, text = '' } = {}) {
  const body = String(value ?? '');
  const clamp = (n) => Math.max(0, Math.min(body.length, Number.isFinite(n) ? n : 0));
  const from = clamp(Number(start) || 0);
  
  
  
  const to = Math.max(from, clamp(Number(end ?? start) || 0));
  const before = body.slice(0, from);
  const after = body.slice(to);
  
  
  
  
  let words = String(text ?? '');
  if (/ $/u.test(before)) words = words.replace(/^ +/u, '');
  if (/^ /u.test(after)) words = words.replace(/ +$/u, '');
  if (!words) {
    
    
    
    return { value: before + after, caret: from, range: { start: from, removeLen: to - from, text: '' } };
  }
  
  
  const lead = before && !/\s$/u.test(before) && !/^\s/u.test(words) && !ATTACHING.test(words) ? ' ' : '';
  const trail = after && !/^\s/u.test(after) && !/\s$/u.test(words) ? ' ' : '';
  const run = `${lead}${words}${trail}`;
  return {
    value: before + run + after,
    caret: from + lead.length + words.length,
    range: { start: from, removeLen: to - from, text: run }
  };
}

export function runIntact(value, run) {
  if (!run) return false;
  
  
  if (!run.owned) return true;
  return String(value ?? '').slice(run.start, run.start + run.owned.length) === run.owned;
}

export function relocateRun(value, run, { caret = null, reanchor = false } = {}) {
  const body = String(value ?? '');
  if (!run || run.mode !== 'live') return null;
  
  
  
  
  
  
  if (!run.owned) {
    if (!reanchor) return { ...run, start: Math.min(run.start, body.length), len: body.length };
    const at = Number.isFinite(caret) ? Math.max(0, Math.min(body.length, caret)) : Math.min(run.start, body.length);
    return { ...run, start: at, take: 0, len: body.length };
  }
  if (runIntact(body, run)) return { ...run, len: body.length };
  const shifted = run.start + (body.length - run.len);
  if (shifted >= 0 && body.slice(shifted, shifted + run.owned.length) === run.owned) {
    return { ...run, start: shifted, len: body.length };
  }
  return null;
}

export function committedDraft(value, runs) {
  let body = String(value ?? '');
  const live = (Array.isArray(runs) ? runs : (runs ? [runs] : []))
    .filter((run) => run && run.mode === 'live' && run.owned && runIntact(body, run))
    .sort((a, b) => b.start - a.start);
  for (const run of live) {
    body = body.slice(0, run.start) + body.slice(run.start + run.owned.length);
  }
  return body;
}

export function nextCaret({ caretStart = null, caretEnd = null }, { start, oldEnd, newEnd }) {
  if (!Number.isFinite(caretStart)) return newEnd;
  const to = Number.isFinite(caretEnd) ? caretEnd : caretStart;
  if (caretStart === oldEnd && to === oldEnd) return newEnd;
  if (to <= start) return null;
  if (caretStart >= oldEnd) return caretStart + (newEnd - oldEnd);
  return newEnd;
}

// THE SMALLEST WRITE THAT PRODUCES THE SAME DRAFT.
//
// A partial carries the whole sentence so far, so replacing the run wholesale
// rewrites text that did not change and takes his caret, his selection and the
// undo stack with it. Almost always only the tail moved, so the head and the
// tail that match are left alone and the box is handed the difference.
//
// The result is exactly the same string as the full range would produce; a
// surrogate pair is never cut in half, since half of one is not a character.
export function narrowWrite(value, range) {
  const body = String(value ?? '');
  const start = Math.max(0, Math.min(body.length, Number(range?.start) || 0));
  const removeLen = Math.max(0, Math.min(body.length - start, Number(range?.removeLen) || 0));
  const removed = body.slice(start, start + removeLen);
  const added = String(range?.text ?? '');
  const max = Math.min(removed.length, added.length);
  let head = 0;
  while (head < max && removed[head] === added[head]) head += 1;
  if (head > 0 && head < max && isHighSurrogate(added.charCodeAt(head - 1))) head -= 1;
  let tail = 0;
  while (tail < max - head
    && removed[removed.length - 1 - tail] === added[added.length - 1 - tail]) tail += 1;
  if (tail > 0 && isLowSurrogate(added.charCodeAt(added.length - tail))) tail -= 1;
  return {
    start: start + head,
    removeLen: removed.length - head - tail,
    text: added.slice(head, added.length - tail)
  };
}

function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }

function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }

function applyRunWrite(runs, run, text, input) {
  const value = String(input.value ?? '');
  const start = run.start;
  const oldEnd = Math.min(value.length, start + run.take);
  const write = spliceDictation({ value, start, end: oldEnd, text });
  const owned = write.range.text;
  const newEnd = write.range.start + owned.length;
  const delta = write.value.length - value.length;
  const edit = narrowWrite(value, write.range);
  const caret = nextCaret(input, {
    start: edit.start,
    oldEnd: edit.start + edit.removeLen,
    newEnd: edit.start + edit.text.length
  });
  const next = runs.map((other) => {
    if (other.token === run.token) {
      return { ...run, start: write.range.start, owned, take: owned.length, len: write.value.length };
    }
    
    
    const moved = other.start >= oldEnd ? other.start + delta : other.start;
    return { ...other, start: moved, len: write.value.length };
  });
  return { runs: next, write: { ...write, edit, caret } };
}

export function nextDraftRuns(runs = [], input = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const type = input.type;
  const value = String(input.value ?? '');
  const token = input.token ?? null;
  const run = token ? list.find((r) => r.token === token) : null;

  if (type === 'begin') {
    if (!token || run) return { runs: list, write: null };
    const at = Math.max(0, Math.min(value.length, Number(input.start ?? value.length) || 0));
    const to = Math.max(at, Math.min(value.length, Number(input.end ?? at) || 0));
    
    
    
    
    
    
    
    
    const settled = list.map((r) => {
      if (r.mode !== 'live' || !r.owned) return r;
      const end = r.start + r.owned.length;
      return at < end && to > r.start ? { ...r, mode: 'adopted' } : r;
    });
    return {
      runs: [...settled, { token, start: at, take: to - at, owned: '', len: value.length, mode: 'live' }],
      write: null
    };
  }

  if (type === 'typed') {
    
    
    
    
    if (!list.length) return { runs: list, write: null };
    return {
      runs: list.map((r) => {
        if (r.mode !== 'live') return r;
        return relocateRun(value, r, { caret: input.caretStart, reanchor: true }) || { ...r, mode: 'adopted' };
      }),
      write: null
    };
  }

  if (type === 'partial') {
    if (!run || run.mode !== 'live') return { runs: list, write: null };
    const found = relocateRun(value, run, { caret: input.caretStart });
    if (!found) {
      return { runs: list.map((r) => (r.token === token ? { ...r, mode: 'adopted' } : r)), write: null };
    }
    return applyRunWrite(list.map((r) => (r.token === token ? found : r)), found, String(input.text ?? ''), input);
  }

  if (type === 'commit') {
    const text = String(input.text ?? '');
    const without = list.filter((r) => r.token !== token);
    
    
    
    if (input.dropped) return { runs: without, write: null };
    if (run && run.mode === 'adopted') return { runs: without, write: null };
    if (run) {
      
      
      
      
      
      
      
      if (!text && !run.owned) return { runs: without, write: null, settled: null };
      const found = relocateRun(value, run, { caret: input.caretStart });
      if (!found) return { runs: without, write: null };
      const result = applyRunWrite(list.map((r) => (r.token === token ? found : r)), found, text, input);
      return { runs: result.runs.filter((r) => r.token !== token), write: result.write };
    }
    if (!text) return { runs: without, write: null };
    const at = Number.isFinite(input.start) ? input.start : value.length;
    const to = Number.isFinite(input.end) ? input.end : at;
    const write = spliceDictation({ value, start: at, end: to, text });
    const oldEnd = Math.max(at, to);
    const delta = write.value.length - value.length;
    return {
      runs: without.map((r) => ({ ...r, start: r.start >= oldEnd ? r.start + delta : r.start, len: write.value.length })),
      write
    };
  }

  if (type === 'cancel') {
    const without = list.filter((r) => r.token !== token);
    if (!run || run.mode !== 'live' || !run.owned) return { runs: without, write: null };
    const found = relocateRun(value, run, { caret: input.caretStart });
    if (!found) return { runs: without, write: null };
    const result = applyRunWrite(list.map((r) => (r.token === token ? found : r)), found, '', input);
    return { runs: result.runs.filter((r) => r.token !== token), write: result.write };
  }

  return { runs: list, write: null };
}
