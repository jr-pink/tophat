

export const CLIP_PEAK = 0.8913;

export const CLIP_FRAMES = 2;


export const TARGET_RMS_DB = -25;
export const TARGET_PEAK_DB = -6;


export function dbfs(amplitude) {
  const value = Number(amplitude);
  if (!Number.isFinite(value) || value <= 0) return -100;
  return Math.max(-100, Math.round(20 * Math.log10(Math.min(1, value)) * 10) / 10);
}

export function frameLevels(bytes) {
  let peak = 0;
  let sum = 0;
  const n = bytes?.length || 0;
  if (!n) return { peak: 0, rms: 0 };
  for (let i = 0; i < n; i += 1) {
    const value = (bytes[i] - 128) / 128;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value * value;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}

export function classifyLevel({ peakDb, rmsDb, clipping = false }) {
  if (clipping || peakDb >= -1) return 'clipping';
  if (peakDb > TARGET_PEAK_DB) return 'hot';
  if (rmsDb < -45) return 'quiet';
  return 'good';
}

export function clipRun(run, peak) {
  const next = peak >= CLIP_PEAK ? (Number(run) || 0) + 1 : 0;
  return { run: next, clipped: next >= CLIP_FRAMES };
}


export function levelAdvice(state) {
  if (state === 'clipping') {
    return `Input is clipping. Turn the microphone's own gain down; aim for peaks under ${TARGET_PEAK_DB} dB.`;
  }
  if (state === 'hot') return `Close to clipping. Aim for peaks under ${TARGET_PEAK_DB} dB and RMS near ${TARGET_RMS_DB} dB.`;
  if (state === 'quiet') return 'Almost nothing is coming in. Check the microphone is the one you think it is.';
  return `Level looks right: RMS near ${TARGET_RMS_DB} dB, peaks under ${TARGET_PEAK_DB} dB.`;
}

export function truncated({ capturedSec, heldSec, graceSec = 0.6, ratio = 0.6 }) {
  
  
  
  if (capturedSec == null || heldSec == null) return false;
  const captured = Number(capturedSec);
  const held = Number(heldSec);
  if (!Number.isFinite(captured) || !Number.isFinite(held)) return false;
  if (held <= graceSec * 2) return false;
  return captured < (held - graceSec) * ratio;
}
