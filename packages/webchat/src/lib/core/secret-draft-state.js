// Unsaved credential forms on /secrets, as one declaration on the docstore kit core (like core/find-state.js). One record per
// form, keyed `new` (the new-credential form) or `edit:<id>`: `data` is what the form holds, `base` what an edit started from
// (empty for a new credential), so "unsaved" is a fact in the store and not a property of a component that can be unmounted.
//
// The form is a projection of this record. Typing, Tab, the 30-second list refresh, a search, a click on another credential and
// closing the form all leave it alone; only Save (after the vault accepted the entry) and an explicit, confirmed Discard remove it.
//
// storage 'tab': this window's sessionStorage, so it comes back on a reload of the same tab and is gone when the tab closes,
// and never lands in the device's localStorage. It holds what he typed, card numbers and CVCs included, in the tab he is
// already using to read every credential; page.beforeunload asks before that tab is closed with a draft in it.
import { keyed } from '../../../../runner/tools/docstore-kit/lib/recipes.js';
import { field, merge } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** A flat map of short keys to strings; anything else is dropped, so a bad record can never break the form. */
export const cleanData = (v) => Object.fromEntries(Object.entries(plain(v))
  .filter(([k, x]) => k.length > 0 && k.length <= 40 && typeof x === 'string' && x.length <= 200_000).slice(0, 60));

export const DRAFT_KEY_NEW = 'new';
export const editKey = (id) => `edit:${id}`;

export const secretDrafts = keyed('secret-draft', {
  storage: 'tab',
  fields: { data: field({}, cleanData), base: field({}, cleanData) },
  actions: {
    // the whole form (opening an edit: data and base are the same snapshot)
    'draft.set': (s, p = {}) => ({ ...s, data: cleanData(p.data), base: p.base === undefined ? s.base : cleanData(p.base) }),
    // one or more fields as they are typed
    'draft.patch': merge('data'),
    // gone: saved, or discarded on purpose
    'draft.clear': () => ({ data: {}, base: {} })
  }
});
