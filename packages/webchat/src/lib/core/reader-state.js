// The reader page's own device state as ONE declaration on the docstore-ui-kit core (phase 4): the text size he reads
// at, whether a highlight arms the microphone, and the per-device action sequence the reading chat's actions carry.
// Before, the page kept three hand-rolled keys (`reader.textScale`, `reader.autoMic`, `reader.deviceSeq`) and two
// `$effect`s that wrote them. The auto-mic effect ran on mount with the default, so "mic off" never survived a reload;
// declared here it is hydrated before the first render like the text size always was.
//
// scope 'local', `durable`: the sequence is minted by read-modify-write against storage and is on disk before the
// action carrying it is sent, so two tabs and a reload never hand out the same number (the old code did the same with
// getItem/setItem). `crossTab`: a change in another tab reaches this one (the old page re-read auto-mic every report).
import { declare } from '../../../../runner/tools/quicklook-kit/lib/model.js';
import { bool, set } from '../../../../runner/tools/quicklook-kit/lib/schema.js';
import { range, counter, advance, mint } from '../../../../runner/tools/quicklook-kit/lib/recipes.js';

export const TEXT_STEPS = [0.85, 0.925, 1, 1.1, 1.2, 1.35, 1.5];

export const readerDecl = declare({
  name: 'reader',
  scope: 'local',
  durable: true,
  crossTab: true,
  fields: { textScale: range(1, 0.85, 1.5), autoMic: bool(true), deviceSeq: counter() },
  legacy: [
    { key: 'reader.textScale', into: 'textScale', archive: true },
    { key: 'reader.autoMic', read: (v) => ({ autoMic: v !== 'off' }), archive: true },
    { key: 'reader.deviceSeq', into: 'deviceSeq', archive: true }
  ],
  actions: { 'textScale.set': set('textScale', 'scale'), 'autoMic.set': set('autoMic', 'on'), 'deviceSeq.advance': advance('deviceSeq') }
});

/** One step bigger (+1) or smaller (-1) from `current`; an off-ladder value steps from 1. */
export function stepScale(current, direction) {
  const at = TEXT_STEPS.indexOf(current);
  const index = at === -1 ? TEXT_STEPS.indexOf(1) : at;
  return TEXT_STEPS[Math.max(0, Math.min(TEXT_STEPS.length - 1, index + direction))];
}

/** The next device sequence for a reading-chat action: minted once, on disk before it is sent (kit recipe `mint`). */
export const mintDeviceSeq = (replica) => mint(replica, 'deviceSeq', 'deviceSeq.advance');
