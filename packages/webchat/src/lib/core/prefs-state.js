// Device preferences as ONE declaration on the docstore-ui-kit core. Today: the voice orb's speaking speed and
// hands-free. The old ChatPane read `tophat.voice` in an $effect after first render, so the orb mounted with the
// defaults and was corrected a tick later; declared here it is hydrated before the first render.
// scope 'local' now; a preference he wants on every device is `scope: 'cloud'`, one word.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { bool, num, shape, merge } from '../../../../runner/tools/docstore-kit/lib/schema.js';

export const VOICE_DEFAULTS = { speed: 1.1, handsFree: true };

export const prefsDecl = declare({
  name: 'prefs',
  scope: 'local',
  fields: { voice: shape({ speed: num(VOICE_DEFAULTS.speed), handsFree: bool(VOICE_DEFAULTS.handsFree) }) },
  legacy: [{ key: 'tophat.voice', json: true, into: 'voice' }],
  actions: { 'voice.set': merge('voice') } // a change is the fields it names; naming the value it already has is a no-op
});
