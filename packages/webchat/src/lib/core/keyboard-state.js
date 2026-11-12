// The page's keyboard modes as ONE declaration on the docstore kit core: the tmux-style pane prefix and the chord list it
// can open (Ctrl-Q ?). Plain data: `prefix` is the id of the arming that is waiting (minted by the page at Ctrl-Q, so the 3
// s lapse of an older arming never clears a newer one), `help` whether the list is open. The hint bar and the overlay are
// projections of these. scope ephemeral: a reload, a blur or a second key ends the mode; nothing is saved.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field, bool, on, set } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const armId = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);

export const keyboardDecl = declare({
  name: 'keyboard',
  scope: 'ephemeral',
  fields: { prefix: field(null, armId), help: bool() },
  actions: {
    // Absolute: this arming is the one waiting. A repeat is the same state.
    'prefix.arm': on('prefix', (cur, { id } = {}) => armId(id) ?? cur),
    // The arming `id` ended (its second key came, it lapsed, the window lost focus); no id ends whichever is waiting.
    'prefix.clear': on('prefix', (cur, { id } = {}) => (cur && (id === undefined || cur === id) ? null : cur)),
    'help.set': set('help', 'open')
  }
});
