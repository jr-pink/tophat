

export const DEVICE_KEY = 'tophat.dictation.input';

export function audioInputs(devices) {
  return (devices || []).filter((device) => device && device.kind === 'audioinput');
}

export function choosableInputs(devices) {
  const all = audioInputs(devices);
  const real = all.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications');
  
  
  
  
  
  
  return real.length ? real : all;
}

export function deviceLabel(device, index = 0) {
  const raw = String(device?.label ?? '').trim();
  if (raw) return raw;
  if (device?.deviceId === 'default') return 'System default';
  if (device?.deviceId === 'communications') return 'System communications device';
  return `Microphone ${index + 1}`;
}


export function labelsHidden(devices) {
  const inputs = audioInputs(devices);
  if (!inputs.length) return false;
  return inputs.every((device) => !String(device.label ?? '').trim());
}

export function shortLabel(label) {
  return String(label ?? '')
    .replace(/^\s*(default|communications)\s*-\s*/iu, '')
    .replace(/\s*\([^)]*\)\s*$/u, '')
    .trim() || 'Microphone';
}

// WHAT TO OPEN WHEN HE HAS NOT PICKED ONE, in the order he named them.
//
// ANYTHING NOT ON THIS LIST IS NEVER AUTO-SELECTED. A USB interface, a
// capture card or a conference speakerphone appearing in the enumeration must
// not quietly become the microphone he dictates into; he can still choose one
// by hand, and a hand-picked device beats this order.
export const MIC_PRIORITY = [
  { tier: 'Throat mic', pattern: /throat/iu },
  { tier: 'Earbuds', pattern: /airpod|earbud/iu },
  { tier: 'iPhone', pattern: /iphone/iu },
  { tier: 'MacBook', pattern: /macbook|built-?in|imac|internal/iu }
];

/** Which tier a device name belongs to, or null for one he never named. */
export function micTier(label) {
  const name = String(label ?? '').trim();
  if (!name) return null;
  const rank = MIC_PRIORITY.findIndex((entry) => entry.pattern.test(name));
  return rank < 0 ? null : { rank, tier: MIC_PRIORITY[rank].tier };
}

/**
 * The choosable inputs he named, best first.
 *
 * Ties keep enumeration order, so two devices of the same tier resolve the
 * same way twice running rather than swapping under him between refreshes.
 */
export function rankedInputs(devices) {
  const inputs = choosableInputs(devices);
  return inputs
    .map((device, index) => {
      const label = deviceLabel(device, index);
      return { deviceId: device.deviceId, label, index, tier: micTier(label) };
    })
    .filter((row) => row.tier)
    .sort((a, b) => a.tier.rank - b.tier.rank || a.index - b.index)
    .map((row) => ({ deviceId: row.deviceId, label: row.label, rank: row.tier.rank, tier: row.tier.tier }));
}

/**
 * The microphone to open on his behalf: the highest tier actually present,
 * skipping any that have already failed.
 *
 * BEFORE PERMISSION EVERY LABEL IS THE EMPTY STRING, so this answers null on a
 * cold load and the caller stays on the system default until the first
 * recording fills the names in -- `refreshDevices` runs again at that moment,
 * which is when the order first takes effect.
 */
export function priorityInput({ devices = [], skip = [] } = {}) {
  const avoid = new Set((Array.isArray(skip) ? skip : []).filter(Boolean));
  return rankedInputs(devices).find((row) => !avoid.has(row.deviceId)) || null;
}

export function pickDevice({ devices = [], preferredId = null, preferredLabel = '' } = {}) {
  const inputs = audioInputs(devices);
  if (!inputs.length) return { deviceId: preferredId || null, reason: preferredId ? 'preferred' : 'none' };
  const wanted = String(preferredId ?? '');
  // NOBODY HAS PICKED, so the order he gave decides rather than whatever macOS
  // happens to be pointing at. With none of his microphones in the list this
  // still answers `default`, which is the old behaviour.
  if (!wanted) {
    const auto = priorityInput({ devices });
    return auto
      ? { deviceId: auto.deviceId, reason: 'priority', label: auto.label, tier: auto.tier }
      : { deviceId: null, reason: 'default' };
  }
  if (inputs.some((device) => device.deviceId === wanted)) return { deviceId: wanted, reason: 'preferred' };
  // A browser hands out a new deviceId for the same microphone after a
  // restart, a relaunch or a permission reset, so the id he chose yesterday
  // names nothing today. The microphone is still there under its name: take
  // it, rather than telling him to pick it again.
  const named = shortLabel(preferredLabel);
  if (named && named !== 'Microphone') {
    const again = inputs.find((device) => shortLabel(deviceLabel(device)) === named);
    if (again) return { deviceId: again.deviceId, reason: 'renamed', label: named };
  }
  // Gone. The fallback is the priority order rather than the system default,
  // so unplugging the throat mic lands on the earbuds and not on whatever the OS
  // was last pointed at.
  const auto = priorityInput({ devices });
  return auto
    ? { deviceId: auto.deviceId, reason: 'missing', label: auto.label, tier: auto.tier }
    : { deviceId: null, reason: 'missing' };
}

// THE MICROPHONE TO MOVE TO WHEN THIS ONE IS DELIVERING SILENCE.
//
// The device that is gone is still in the list, so a replacement is chosen by
// excluding what has already failed rather than by trusting the enumeration.
//
// The replacement follows MIC_PRIORITY, so it is the same order he named for
// choosing one in the first place.

export function replacementInput({ devices = [], currentId = null, currentLabel = '', tried = [] } = {}) {
  const inputs = choosableInputs(devices);
  const skip = new Set([currentId, ...(Array.isArray(tried) ? tried : [])].filter(Boolean));
  const named = shortLabel(currentLabel);
  const usable = inputs.filter((device, index) => {
    if (skip.has(device.deviceId)) return false;
    // The same hardware under a new id is the same dead microphone.
    if (named && named !== 'Microphone' && shortLabel(deviceLabel(device, index)) === named) return false;
    return true;
  });
  if (!usable.length) return null;
  // The same order he gave for choosing one in the first place: a dead throat
  // mic falls to the earbuds, then the iPhone, then this machine's own microphone,
  // which is the one that cannot be unplugged, asleep or in another room.
  // Anything unranked is taken only when none of his own are available.
  const ranked = rankedInputs(devices).filter((row) => usable.some((device) => device.deviceId === row.deviceId));
  const pick = ranked.length
    ? usable.find((device) => device.deviceId === ranked[0].deviceId)
    : usable[0];
  return { deviceId: pick.deviceId, label: deviceLabel(pick, inputs.indexOf(pick)) };
}

export function audioConstraint(deviceId) {
  const audio = {
    sampleRate: 16_000,
    channelCount: 1,
    
    
    
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

/**
 * The constraint voice mode opens a microphone with. Dictation turns echo cancellation off because it wants the
 * cleanest possible waveform for the decoder; a conversation has a loudspeaker in the room playing the reply, and
 * without cancellation the recogniser hears the reply and answers it. The same switch is what lets his voice over
 * the reply count as a barge-in instead of the reply itself.
 */
export function voiceConstraint(deviceId) {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

const OBVIOUSLY_NOT_A_HORN = /macbook|built-?in|imac|airpods|headset|display audio/iu;

export function conditionMismatch({ label, condition }) {
  const device = String(label ?? '');
  const stamp = String(condition ?? '').trim();
  
  
  
  
  if (!device || !stamp) return null;
  if (!OBVIOUSLY_NOT_A_HORN.test(device)) return null;
  
  if (!/horn|chest|lapel|lav|collar/iu.test(stamp)) return null;
  return `Recording on ${shortLabel(device)} while the condition says "${stamp}".`;
}
