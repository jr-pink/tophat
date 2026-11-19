# The Secrets page (`/secrets`)

A list of every credential beside the one he has open, a sidebar of scopes (kinds, groups, Archived, and the vault tools:
Activity, Requests, Import, Devices), and a search box that only filters the list.

## What changed on 2026-11-18, and why

A user lost typed data on this page. Four causes, all fixed:

1. **A page shortcut fired from inside a field.** The page bound `/` (focus the search box) on `window` without asking where
   focus was. A `/` typed into the note field moved focus to the search box, the rest of the note went into the filter, and
   typing in the search box from the form's pane switched the pane to the list, unmounting the form. The rule now lives in the
   shared keybind layer: `bindGlobalKeys()` in `src/lib/core/keys.js` (built on the docstore kit's `parseSpec`/`matches`/`isTyping`)
   never fires while focus is in an input, textarea, select, contenteditable or `role=textbox`, during input-method composition
   (`isComposing`, keyCode 229) or on key repeat, and never fires a bare key on a ctrl/meta/alt chord. A page binds its shortcuts
   through it. Tests: `test/secrets-keys.test.mjs`.
2. **The form was not part of the page's state.** It was a pane that the search and the sidebar replaced, and "New credential"
   reset it. The list and the open credential are now always side by side, and a new or edited credential is a form in the
   detail column. Search filters the list and nothing else; the open credential is whatever he picked, whether or not the filter
   shows its row.
3. **Drafts lived in a component.** Every form is now a record in a store, `src/lib/core/secret-draft-state.js` (the docstore kit's
   `keyed` family, `storage: 'tab'`), read through `src/lib/ui/secret-drafts.svelte.js`. Typing writes to it on every keystroke.
   Tab, re-render, the 30 second refresh, search, closing the form and opening another credential leave it alone. It survives a
   reload of the tab. Only a successful Save, or Discard after an inline confirm, removes it. A failed save keeps it. The list shows
   a `draft` row and an `unsaved edit` tag; closing or reloading the tab with a draft in it raises the browser's own
   "Leave site?" prompt.
4. **The title and the section pill shared a row** in a 232 px sidebar: `secrets` (59 px) plus the pill (198 px) is wider than the
   208 px inside the padding, so the pill ran under the list column and could not be clicked. They are now two rows.

Where the draft is kept: this tab's `sessionStorage` (never `localStorage`). It holds what he typed, card numbers and CVCs
included, until the tab closes, and `sessionStorage` is the same trust boundary as the page, which can already reveal every
credential. Explicit Discard and a successful Save remove it.

## Kinds and the card shape

`src/lib/core/secret-form.js` is the model: kinds, the fields each shows, how a draft becomes a vault entry (`buildEntry`) and how a
revealed entry becomes a draft again (`draftFromEntry`, which carries what the form does not edit, such as a login's extra emails,
in `_extra` so an edit cannot drop it). A card is not a vault type: it is a `secret` entry whose value is the JSON string
`{label, name_on_card, number, exp, cvc, billing_address: {line1, city, state, postal_code, country}, authorization, added}`, id
`card-<brand>-<last4>`, tagged with the hidden group `kind:card`. `tophat-pass get ID --raw` prints that string, as it does for the
cards saved earlier. A secure note is a `secret` tagged `kind:note`. Reveal now also returns the entry's notes
(`/api/password-manager` and the offline replica), so an edit can load them.

A verification code (`totp`) cannot be edited, because the vault never hands the secret back (reveal answers with the current
code); replace it with a new one.
