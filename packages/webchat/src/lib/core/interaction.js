
export function intersect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

export function textEdit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, end, inserted: after.slice(start, nextEnd), removed: before.slice(start, end) };
}

export function summarizeInteractions(rows, { idleMs = 60_000, burstGapMs = 2_000, includeAutomation = false } = {}) {
  const sections = new Map(), sessions = new Map(), bursts = [], speech = new Map();
  const excluded = new Set(rows.filter(r => r.type === 'session' && ['automation', 'verification'].includes(r.actor)).map(r => r.session));
  for (let row of [...rows].sort((a, b) => a.session.localeCompare(b.session) || a.seq - b.seq)) {
    if (!includeAutomation && excluded.has(row.session)) continue;
    let s = sessions.get(row.session);
    if (!s) { s = { previous: null, activeWindows: [], burst: null, seen: new Set() }; sessions.set(row.session, s); }
    if (row.type === 'block') sections.set(row.blockId, { ...row, visibleMs: 0, allocatedMs: 0, visits: 0 });
    // An unchanged tab sends 'heartbeat' instead of a full snapshot (client/interaction.js): it re-asserts
    // the previous viewport's blocks at this time, with this row's focus and visibility.
    if (row.type === 'heartbeat' && s.previous) row = { ...s.previous, type: 'viewport', mono: row.mono, visible: row.visible ?? s.previous.visible, focused: row.focused ?? s.previous.focused };
    if (row.type === 'viewport' && Array.isArray(row.blocks)) {
      row = { ...row, blocks: row.blocks.filter(b => b && typeof b.id === 'string' && Number.isFinite(b.area) && b.area >= 0) };
      const p = s.previous;
      if (p && p.focused && p.visible && row.mono >= p.mono) {
        const end = Math.min(row.mono, p.mono + 5000);
        const duration = s.activeWindows.reduce((sum, w) => sum + Math.max(0, Math.min(end, w.end) - Math.max(p.mono, w.start)), 0);
        const total = p.blocks.reduce((n, b) => n + (Number.isFinite(b.area) && b.area > 0 ? b.area : 0), 0);
        for (const b of p.blocks) {
          const section = sections.get(b.id);
          if (section) { section.visibleMs += duration; section.allocatedMs += total && b.area > 0 ? duration * b.area / total : 0; }
        }
      }
      const visible = new Set(row.blocks.map(b => b.id));
      for (const id of visible) if (!s.seen.has(id) && sections.has(id)) sections.get(id).visits++;
      s.seen = visible; s.previous = row;
      s.activeWindows = s.activeWindows.filter(w => w.end >= row.mono);
    }
    if (['pointerdown', 'pointermove', 'wheel', 'touchstart', 'keydown', 'input', 'selection', 'send'].includes(row.type)) {
      const last = s.activeWindows.at(-1);
      if (last && last.end >= row.mono) last.end = row.mono + idleMs;
      else s.activeWindows.push({ start: row.mono, end: row.mono + idleMs });
    }
    if (row.type === 'input') {
      const source = row.classification?.klass || 'unknown';
      if (!s.burst || s.burst.source !== source || row.mono - s.burst.end > burstGapMs || s.burst.field !== row.field) {
        s.burst = { session: row.session, conversation: row.conversation, field: row.field, source, start: row.mono, end: row.mono, pauseBeforeMs: s.lastInput == null ? null : row.mono - s.lastInput, inserted: '', removed: 0, events: 0 };
        bursts.push(s.burst);
      }
      s.burst.end = row.mono; s.burst.events++; s.burst.inserted += row.edit?.inserted || ''; s.burst.removed += row.edit?.removed?.length || 0;
      s.lastInput = row.mono;
    }
    if (['send', 'focusout', 'pagehide'].includes(row.type)) s.burst = null;
    if (row.type === 'dictation_begin') speech.set(`${row.session}:${row.token}`, { start: row.mono });
    if (['dictation_capture_start', 'dictation_audio'].includes(row.type)) {
      const clip = speech.get(`${row.session}:${row.token}`);
      if (clip && row.type === 'dictation_capture_start') clip.captureStart = row.mono;
      if (clip && row.type === 'dictation_audio') Object.assign(clip, { clipId: row.clipId, durationSec: row.durationSec, heldSec: row.heldSec, capturedAt: row.mono });
    }
    if (row.type === 'dictation_commit') {
      const clip = speech.get(`${row.session}:${row.token}`);
      if (clip) Object.assign(clip, { end: row.mono, text: row.text, timing: 'begin_to_transcript_including_recognition_latency' });
    }
  }
  return {
    caveats: ['Visibility is exposure, not comprehension or gaze.', 'Exposure is counted only while focused and within the chosen idle cutoff.', 'Concurrent blocks share allocated exposure within a pane; panes and devices can overlap and must not be summed as unique reading time.', 'Input burst rates measure text entry/delivery, not unobserved iOS speech.', 'Dictation begin-to-commit includes capture and recognition latency.'],
    idleMs, burstGapMs, excludedSessions: includeAutomation ? [] : [...excluded],
    sections: [...sections.values()].map(s => ({ ...s, exposureWordsPerMinute: s.allocatedMs > 0 ? s.words * 60000 / s.allocatedMs : null })).sort((a, b) => b.allocatedMs - a.allocatedMs),
    bursts: bursts.map(b => ({ ...b, durationMs: b.end - b.start, charactersPerMinute: b.end > b.start ? b.inserted.length * 60000 / (b.end - b.start) : null })),
    dictation: [...speech.values()]
  };
}
