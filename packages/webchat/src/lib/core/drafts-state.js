// Composer drafts on the docstore-ui-kit core (phase 6): one record per chat (`qk:draft:<chat>`), removed when the draft
// is empty, re-read when another tab writes it, as the old `tophat-draft:<chat>` keys were. The kit's `keyed` recipe
// does the family; this file is only the domain declaration. Old keys are imported on first read, then archived.
import { field, set } from '../../../../runner/tools/docstore-kit/lib/schema.js';
import { keyed } from '../../../../runner/tools/docstore-kit/lib/recipes.js';

export const LEGACY_DRAFT_PREFIX = 'tophat-draft:';

export const drafts = keyed('draft', {
  fields: { text: field('', (v) => (typeof v === 'string' ? v : '')) },
  legacy: (key) => [{ key: LEGACY_DRAFT_PREFIX + key, into: 'text', archive: true }],
  legacyPrefix: LEGACY_DRAFT_PREFIX,
  actions: { 'text.set': set('text', 'text') }
});
