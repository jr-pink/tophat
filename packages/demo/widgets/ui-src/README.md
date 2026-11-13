# ui-src: how the chat figures are made

The figures `auto-chat.html`, `runner-qol.html`, `runner-turn.html` and `mac-apps.html` show the chat as the app draws it. Nothing in them
is drawn by hand: the markup and the stylesheet rules are the webchat's own, captured from a running instance, and `build.mjs` only arranges
the captured pieces (sidebar rows, tabs, a title, a transcript) with jsdom and writes each widget with the shared caption frame.
Only the widget inside `runner-qol` tile g, the dock icons in `mac-apps` and the replay controls are the figure's own.

    node packages/demo/widgets/ui-src/build.mjs [auto-chat runner-qol runner-turn mac-apps]

## The captures

- `shell.json`: the app shell (sidebar, tab strip, chat header, composer) of the public demo at 1440 px wide, from `extract.js` run on `.app`.
  `shell-split.json` (`.stage` after the split button), `shell-running.json` (`.chrome` while a turn runs: the stop button and the
  "Correct it mid-run..." composer), `shell-rich.json` (a figure's own frame, `[data-testid=rich-content]`) and `menu.json` (the right-click menu,
  `[data-testid=context-menu]`) are the same capture on those elements. `iframe` `srcdoc` and file links are stripped.
- `frag/*.json`: transcripts rendered by the real `Transcript.svelte` (and `SideThread.svelte`) with fixture rows from `harness/fixtures.js`.
  The demo has no tool rows, automated events, hooks or compaction cards to capture, so these come from the components themselves.
  Capture with `capture.py`.
- `extract.js` reads the stylesheets' source text (Chrome's `cssText` prints a shorthand holding `var()` as empty longhands, which loses
  paddings and borders) and keeps the rules whose selectors match an element of the captured subtree, plus every global rule.

## The harness

`harness/` is a tiny vite app (outside the webchat package, which is assembled from upstream and is not edited here) that mounts the real
components over `packages/webchat/src/lib` with fixture rows:

    cd packages/demo/widgets/ui-src/harness && ln -s ../../../../../node_modules node_modules && npx vite --config vite.config.js

then open `http://127.0.0.1:5199/?f=auto` (any key of `fixtures.js`). A fold the figure shows open is opened by clicking it before the capture
(`capture.py auto auto '[data-testid=tool-run-head]'`).

## Refreshing after a webchat change

Capture the shell again from the live demo (`extract.js` on `.app`, `.stage`, `.chrome`, the rich-content figure and the context menu), re-run
`capture.py` for every fixture, then `build.mjs`. The figure captions in `build.mjs` must stay true to what the app draws.
