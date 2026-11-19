# tophat-cdp

Drive the Chrome that is already running on this machine from the shell, over the DevTools Protocol.

Two implementations share the verbs, flags, output shapes and job registry: `tophat-cdp.mjs` (Node, what the `tophat-cdp` command runs) and `tophat-cdp.py` (Python; the `passkey` verb is forwarded to it, and it is the reference the Node port is tested against). Tests: `packages/tools/test/cdp-*.test.mjs`, and `python3 packages/tools/test/cdp/guard.py` (`--no-browser` for the pure cases) and `iframe.py` against a live Chrome.

- `tophat-cdp` is browser-only. A separate UI-automation tool may share the job namespace (`TOPHAT_UI_JOBS`, see below).


## Secrets: read this first


1. **A secret never travels in argv.** Use `--secret-from VAULT_ID[:field]` (`ID:totp` for the current one-time code): the tool runs `tophat-pass get ID -n` itself, so the value never enters your shell variables, your command line or your output. Alternatives that keep it out of argv: `--text-stdin`, `--text-env VAR`, `--text-file PATH`; add `--secret` to these to get the guard and the redaction below. They work on `fill`, `type` and `keys`.
2. **A secret source is typed only where you said it belongs.** It requires `--expect-url PREFIX` (or a job claimed with `job claim NAME --url U --expect-url PREFIX`), the prefix must be an `https://` URL with a host (or localhost), the tab's URL must start with it and have the same origin, the host must not be a chat/mail/AI site (Discord, WhatsApp, Slack, Messenger, Telegram, Gmail, Outlook, claude.ai, chatgpt, an instance's own chat app (add hosts with `TOPHAT_CDP_CHAT_HOSTS`, comma separated), X, Reddit...; `CHAT_HOSTS` in the source) even if you expected it, and the element must be a real `<input>` (text-like type or password) or `<textarea>`, enabled, and (for `type`/`keys`) actually holding focus. A contenteditable chat box is refused. The checks run before the click, and again right before the insert. Refusal exits 6 (not where expected) and nothing is typed.
3. **Nothing printed can contain it.** `fill` prints `[redacted:N chars]` for `value`/`before` when the text came from a secret source or the field is `type=password`; error messages do too; argparse errors never echo values (`unrecognized arguments: 1 extra value(s) not shown`, `invalid choice (value not shown); did you mean: navigate`); and stdout and stderr pass through a redactor holding every secret this process resolved plus every value read out of a password field (raw, JSON-escaped and repr forms). Not covered: `eval`/`html` you write yourself that read `.value` of a password input; do not do that.
4. A password given as a positional into a `type=password` field still works, is still redacted, and warns on stderr.
5. `--secret-from` failure reports the entry and tophat-pass's exit code, never tophat-pass's stderr.
6. **A screenshot of a secret-filled tab is masked.** A screenshot of a filled card form, read back by OCR, returns the number, expiry and CVC as text. Every `fill`/`type`/`keys` with `--secret-from` (or `--secret`) records its page target in `<state dir>/cdp/secret-fills.json` and in the job file (`secret_fills`: target, verb, vault id, origin, time; never the value). `screenshot` of that tab (or a frame of it, or any tab of that job) warns on stderr and blurs every input, textarea, select, iframe and contenteditable for the capture (a style element added and removed around it); its JSON says `"secretFieldsMasked": true`. `--allow-secret-fields` captures unmasked, still with the warning; never OCR, upload or share that image. The mark lapses when the tab leaves the origin it was filled on. Implemented in both the Node tool (`tophat-cdp.mjs`, `browser/secrets.mjs`) and the Python tool; they share the record file. Redaction downstream is the net, not the rule: do not screenshot a filled card form to check it; `fill` already reads the value back.

Example (the Cloudflare login that started this):

```sh
tophat-cdp job claim cf --url https://dash.cloudflare.com/login --expect-url https://dash.cloudflare.com/
tophat-cdp fill --job cf 'input[type=email]' --secret-from import-d705e79069b18f32915f4113:username
tophat-cdp fill --job cf 'input[type=password]' --secret-from import-d705e79069b18f32915f4113
```

(Field names depend on the vault entry; `tophat-pass fields ID` lists them without values.)

## Forgiving command line


| seen | now |
| --- | --- |
| `fill ID SEL TEXT --job X` or `--job X fill ID ...` (39 `unrecognized arguments`): job=X took the target slot | an explicit target wins; `--job` only exempts that job's tab from the ownership check |
| `fill --job X SEL TEXT` | the job is the target (the positional count decides, not a hex guess) |
| `--target ID` (16) | the target positional |
| `eval --expr/--expression/--js/--script/--code/-e`, `--await`, `--max-chars N` (about 16) | accepted; `--max-chars` truncates the printed result; `--stdin`/`--file` read JS |
| `new --url U`, `navigate --url U` (7) | accepted |
| `--timeout`, `--steal`, `--expect-url`, `--json`, `--force` before the verb (6) | moved after the verb when the verb accepts them |
| `nav`, `goto`, `js`, `evaluate`, `shot`, `ss`, `ls`, `tabs` (4) | verb aliases |
| `screenshot --out PATH`, `job claim --background`, `dom-click --index N / --text T` | accepted (`--text` picks the match whose visible text contains T) |
| `navigate job=X --expect-url P URL` or `navigate ID --expect-url P URL` (argparse would bind an optional positional early and fail with "unrecognized arguments: 1 extra value") | positionals are sorted before options in both normalizers, so any option order works |
| value starting with `-` | after `--` it is data: `type -- -5`; or use `--text-stdin`/`--text-file`, `--selector-file` |

When a call still does not parse, the error prints the option names that were wrong, never their values.

## Endpoint

`$TOPHAT_CDP_ENDPOINT` (or `$TOPHAT_RUNNER_BROWSER_CDP`), else `browserCdp` in the tophat config file (`$TOPHAT_CONFIG`, default `~/.config/tophat/config.json`); `tophat-cdp status` prints the live value. Local http only: the scheme must be `http`, the host must be `localhost`/`127.0.0.1`/`::1`, and credentials in the URL are rejected. The port is never guessed; if nothing is configured the tool says so and exits 1.

Python dependency is `websocket-client`. It is importable from the system `python3` here; if it ever is not, the script re-execs itself through `uv run --with websocket-client python` once (guarded by `TOPHAT_CDP_BOOTSTRAPPED`), so callers just run `tophat-cdp`.

## Jobs: one job, one tab


A **job owns one tab**, exactly as a UI-automation job owns one window. Two agents each claim a job and work at the same time; a mutating verb aimed at a tab another live job holds is **refused** and names the holder. Lockless: there is nothing to wait on and nothing to release but the name.

```sh
tophat-cdp job claim shop --url https://www.amazon.com/   # create and own a tab
tophat-cdp --job shop navigate https://www.amazon.com/gp/cart/view.html
tophat-cdp --job shop dom-click 'input[name=proceedToRetailCheckout]'
tophat-cdp --job shop text '#sc-subtotal-amount-activecart'
tophat-cdp job list                                       # jobs, urls, drift, age
tophat-cdp job release shop --close
```

`--job NAME` works before or after the verb and stands in for the `TARGET` positional; `$TOPHAT_CDP_JOB` sets it for a whole shell. `job=NAME` is also a target selector in its own right, so `tophat-cdp navigate job=shop URL` is the same call.

### No job named? You get one anyway


A mutating verb with no job and no target no longer acts on an arbitrary tab: it resolves a job name from whoever is calling, and claims a tab of its own under that name.

**Resolution order, first hit wins:** `--job NAME` > `$TOPHAT_CDP_JOB` > `$TOPHAT_AGENT_ID` > `$TOPHAT_CONVERSATION_ID` > `auto-<ppid>` from the process tree. The name is sanitised to the job alphabet (`agent/2e36 e1c7!` becomes `agent-2e36-e1c7`); `TOPHAT_AGENT_ID` is the one that tells two subagents of the same conversation apart, and the tool works the same whether or not the runner exports it yet. A human shell with no variables set gets one stable job per shell, so repeated commands share one tab.

**An explicit target always wins and is never auto-claimed.** The default is only applied when the verb's first positional is not a target (a 32-hex id, an id prefix, `url=`/`url^=`/`url*=`/`title*=`/`job=`), so `tophat-cdp eval <id> 'document.title'`, every existing script and every cron job behave exactly as before.

```sh
TOPHAT_AGENT_ID=agent_2e36e1c7 tophat-cdp navigate https://example.com
# note: no job named; claimed 94E2...07A3 (created) as job agent_2e36e1c7 from $TOPHAT_AGENT_ID
```

Auto-claim **creates** a tab (at the url if the verb carries one); it never adopts or steals. A tab another live job holds is still refused with exit 5 and the holder's name, and `--steal` is still the only way past that.

### Reaping: a claim can be abandoned, a tab is not

`job list`, `job claim` and every auto-claim reap. Two kinds of dead entry go:

- the tab is gone and no tab matches the job's fingerprint (as before), and
- **the claim is abandoned**: its owner pid is not alive AND nothing has used it for `$TOPHAT_CDP_JOB_TTL` seconds (default 3600). `lastSeen` is rewritten by every command that resolves the job, so a job in active use never qualifies, however old, and a job whose owner process is still running is never reaped at all.

A dead pid alone is deliberately NOT the test: every tophat-cdp invocation is its own short-lived process, so the pid recorded in a perfectly healthy job record is dead a second later. That is why `job list` showed `amazon` with `pidAlive: false` beside a live checkout.

**Reaping releases the NAME and leaves the TAB open.** Nothing an agent opened disappears under its owner; the tab simply stops being spoken for and the next `job claim` can adopt it.

**Tabs nobody holds are closed after an idle hour.** Left alone, abandoned tabs pile up in the shared Chrome (25 pages were 10 GB on 2026-11-18). Every reap (`job list`, `job claim`, auto-claim, `job reap`) also closes a page that no live job holds, that is not protected, and whose url and title have not changed for `$TOPHAT_CDP_TAB_TTL` seconds (default 3600; `0` turns it off). The registry keeps its own idle clock in `tab-seen.json` beside the jobs directory, because Chrome keeps none. An abandoned `--ephemeral` claim (its caller was killed before `job release --close`) has its tab closed at once; the last open page is never closed. `job reap` prints `closedTabs`.

### The failure this exists for


### job subcommands

| subcommand | what it does |
| --- | --- |
| `job claim NAME` | Own a tab under NAME. `--url URL` opens it there (and records it as the fingerprint), `--target ID` adopts an existing tab, `--new` forces a fresh tab even if the job has one, `--foreground` (default is background), `--new-context` (separate cookie jar), `--ephemeral` (marks it short-lived), `--expect-url PREFIX` stores a sticky expectation, `--steal` takes a tab another job holds. Claiming a name you already hold is idempotent: it re-attaches, it does not make a second tab. |
| `job adopt NAME --target ID` | Take an existing tab (same refusal and `--steal`). |
| `job release NAME` | Give up the name. The tab stays open unless `--close`. |
| `job list` | Every job: target id, live, current url, the url the job last set, drift, age, pid, tool. `--all` also lists a UI-automation tool's window jobs. Reaps dead entries unless `--keep-stale`. |
| `job show NAME` | One job, re-resolved, with its drift. |
| `job sync NAME` | Adopt the tab's current url as the job's fingerprint (silences a drift warning you caused yourself). |
| `job expect NAME [PREFIX]` | Set or `--clear` the sticky url-prefix expectation. |
| `job reap` | Drop entries whose tab no longer exists, and release claims whose owner process is gone and which have been idle past `$TOPHAT_CDP_JOB_TTL` (default 3600s). The tab stays open. |

### Refusal, re-resolution and the anti-yank check

- **Refusal.** `close`, `activate`, `navigate`, `reload`, `click`, `dom-click`, `type`, `keys`, `fill` and `eval` refuse a tab owned by a different live job: exit 5, with the holder's name, pid and claim time. `--steal` overrides. This applies to legacy calls that name a bare target id too, which is what protects a job from an agent that knows nothing about jobs. Read-only verbs (`targets`, `frames`, `info`, `html`, `text`, `screenshot`, `wait-for`) are never refused.
- **Re-resolution.** A job re-resolves its tab every command: by target id, then, if that id is gone, by the url or title it recorded, and only when exactly one unheld page matches. The new id is written back and the rebinding is said on stderr. If nothing matches, the command fails (exit 3) and tells you to claim again.
- **Drift.** The job records the url it last *set*. When the tab's current url has a different origin, or a different first path segment, the next command warns on stderr: *"job shop: path moved from /checkout/... to /dp; someone else may be driving it"*. `--expect-url PREFIX` on any verb, or a stored `job expect`, turns that into exit 6 before anything is read or clicked.
- **Reaping.** An entry whose tab is gone and cannot be re-found is deleted by the next `job claim` or `job list`, so a dead job never blocks a live one.
- Registry: one JSON file per job in `<state dir>/cdp/jobs/` (`$TOPHAT_CDP_JOBS`; the state dir is `$TOPHAT_STATE_DIR`, default `~/.local/state/tophat`), the same shape and convention a UI-automation tool uses at `$TOPHAT_UI_JOBS` (default `<state dir>/ui/jobs/`).

### One namespace across tophat-cdp and a UI-automation tool

The two registries stay separate files (a tab and a window are different things, and a window tool holds its own OS grants), but **the job NAME is shared by convention**: `shop` should mean the same piece of work in both tools. `tophat-cdp job list --all` prints the window jobs beside its own, and `job claim` notes on stderr when the name you are claiming is already a window job.

## Verbs

| verb | what it does |
| --- | --- |
| `status` | JSON: endpoint, browser version, reachable, config source. Unchanged from the original script. |
| `endpoint` | Print the endpoint URL. Unchanged. |
| `targets` / `list` | All targets: id, type, title, url. `--filter SUBSTR` (url+title, case-insensitive), `--exact`, `--prefix`, `--case-sensitive`, `--type page,iframe,...`, `--json`, `--full-url`, `--max-url N` (default 160). Pure HTTP `/json/list`; touches no tab. |
| `frames` | Only `iframe` (OOPIF) targets, so an embedded checkout or login frame can be found. `--filter`, `--json`. |
| `new URL` | Create a tab, print its target id. `--background`, `--new-context` (fresh cookie jar), `--json`. |
| `close TARGET` | Close a target. |
| `activate TARGET` | Bring a tab to the front. |
| `navigate TARGET URL` | `Page.navigate`; a navigation error exits 3. |
| `reload TARGET` | `Page.reload`, `--ignore-cache`. |
| `info TARGET` | Live url, title, readyState, viewport, scrollY. |
| `eval TARGET [JS]` | `Runtime.evaluate` with `returnByValue` and `awaitPromise`. `--file PATH` or stdin instead of an argument, so a large snippet needs no shell quoting. `--no-await`, `--json`, `--timeout`. A JavaScript exception prints the message and exits 3. |
| `html TARGET [SEL]` | `outerHTML` of a selector, default the document. `--max-chars`. |
| `text TARGET [SEL]` | `innerText` of a selector, default `body`. `--max-chars`. |
| `pdf TARGET OUT.pdf` | Print the tab to a PDF (`Page.printToPDF`, screen media, because single-page apps hide their content under `@media print`). A portal that shows a document only as a page has no file to download. Prints path, bytes, sha256. |
| `download TARGET URL OUT` | Fetch URL inside the tab (its cookies) and write the bytes to OUT; exit 3 on a non-2xx answer or, with `--expect-pdf`, bytes that do not start with `%PDF-`. Prints status, content type, content-disposition, bytes, sha256. A statement behind a login is a same-origin GET. |
| `screenshot TARGET OUT.png` | PNG to a file. `--clip x,y,w,h` (CSS pixels), `--full-page` (layout metrics + `captureBeyondViewport`), `--scale`, `--timeout`, `--color-scheme light|dark` (prefers-color-scheme emulated for that capture only, sandboxed iframes included; `window --width` sets the width). A tab that had a secret typed into it is captured with its fields blurred (Secrets, rule 6); `--allow-secret-fields` overrides. |
| `click TARGET X Y` | `Input.dispatchMouseEvent`: mouseMoved, mousePressed, mouseReleased. On a **frame** target the coordinates are frame-local and the events go to the embedding page, translated by the frame origin (`--in-frame` keeps the old behaviour). `--button`, `--clicks`. |
| `dom-click TARGET SEL` | `el.scrollIntoView()` then `el.click()` inside the target. A DOM click is NOT a real click: a trusted-event handler ignores it (measured; see gotcha 4). Use `tap`. |
| `tap TARGET SEL` | **Real click.** Resolves the element (selector may pierce frames with `>>>`), scrolls whatever actually scrolls until it is in the page viewport, hit-tests the point, then dispatches the mouse events to the **page** target. Exit 7 if the point does not reach the element, and nothing is dispatched. `--no-scroll`, `--button`, `--clicks`, `--settle MS`, `--text NEEDLE` and `--index N` (pick among matches; light DOM first, then open shadow roots). |
| `point TARGET SEL` | Where the element really is: frame chain, owning target, absolute page coordinates, in-view, `elementFromPoint` result. `--no-scroll`, `--page-errors`, `--text NEEDLE`, `--index N`. Exit 7 if a click would miss. |
| `clear TARGET SEL` | Empty a field: click, select-all, insert nothing, verify empty. Never a Backspace loop. |
| `upload TARGET SELECTOR FILES...` | Attach local files to an `<input type=file>` with `DOM.setFileInputFiles`: no file dialog, no drag. `--index N` picks among several inputs. |
| `frame-map TARGET` | Every iframe in a tab named by the **element that embeds it**: selector, child target id, size, position, url, and a flag when several frames share one url. `--depth N`, `--json`. |
| `type TARGET TEXT` | `Input.insertText` at whatever is focused. A frame target is routed to its embedding page (`--in-frame` to override). |
| `keys TARGET KEY...` | Per-key events: `rawKeyDown` + `char` + `keyUp` for printable characters, `keyDown`/`keyUp` for Enter/Tab/Space, `rawKeyDown`/`keyUp` for the rest. Named keys: Enter, Return, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right (or Up/Down/Left/Right), Home, End, PageUp, PageDown. Modifiers `Shift+`, `Ctrl+`, `Meta+`/`Cmd+`, `Alt+`. `--delay MS`, `--select-all` (Meta+a carrying the `selectAll` editing command, the only form that selects inside an OOPIF), `--in-frame`. |
| `fill TARGET SEL TEXT` | **Replace a field's value for real.** Resolves the element (frame-piercing `>>>` selector), scrolls it into view, hit-tests it, clicks it at page coordinates, selects all with the `selectAll` editing command, inserts the text into the **page** target, reads the value back from the frame that owns the element, and checks the embedding page for a validation message about that field. `--append` (no select-all), `--no-click`, `--no-scroll`, `--no-focus-check`, `--allow-error`, `--settle MS`, `--dom-value` (plain forms only). `--input-target` is obsolete and ignored. Exit 7 if it could not be put under the pointer, exit 8 if the readback or the page disagrees. |
| `wait-for TARGET` | Poll until a condition holds, else exit 4. `--selector SEL`, `--url-changes`, `--url-contains SUBSTR`, `--text-contains SUBSTR`, `--timeout S` (default 30), `--poll S`. |
| `cookies TARGET` | Cookies the tab's url sends: name, domain, path, httpOnly/secure/session, size; never values. `--delete NAME_REGEX` removes matching names through `Network.deleteCookies`, HttpOnly ones included (`--dry-run` lists them). |
| `captcha solve\|detect\|balance\|spend` | Solve a captcha through 2Captcha; see [Captchas](#captchas). `balance` and `spend` need no tab. Node tool only (the Python twin has no `captcha`). |
| `protected` | Show the target ids that mutating verbs refuse, and whether each is still live. |
| `job ...` | Own a tab under a name; see [Jobs](#jobs-one-job-one-tab) above. |

Every verb that takes a `TARGET` also takes `--job NAME` in its place, plus `--steal` and `--expect-url PREFIX`. Every verb takes `--help`. No arguments at all is `status`, as before.

Exit codes: `0` ok, `1` usage or configuration, `2` endpoint unreachable, `3` target or JavaScript error (including an ambiguous selector), `4` timeout, `5` refused (protected target, or a tab owned by another job), `6` the tab is not where the job left it, **`7` the element could not be put under the pointer** (not in view after scrolling, or the hit test landed on something else) and nothing was dispatched, **`8` the action was dispatched and the verification disagreed** (the readback is not what was typed, or the embedding page shows a validation message for the field).

### Captchas

A captcha is not an owner blocker: solve it. In a tab you own:

```sh
tophat-cdp job claim NAME --url https://site.example/page
tophat-cdp --job NAME captcha detect            # what is on the page; nothing bought
tophat-cdp --job NAME captcha solve             # buy a token, put it in the page, fire the page's callback
tophat-cdp --job NAME captcha solve --submit    # ... and submit the form if no callback fired, or the page stayed put after it
tophat-cdp captcha spend                        # today / lifetime spend against the caps, no tab needed
tophat-cdp captcha balance                      # the provider account balance
```

`solve` reads the tab, finds the widget (reCAPTCHA v2 and Enterprise, reCAPTCHA v3, hCaptcha, Cloudflare Turnstile; a widget in the page or an `<iframe>` that names its sitekey), sends the sitekey and the page URL to 2Captcha (v2 JSON API, `createTask` then `getTaskResult`), waits, writes the token into every response field (`g-recaptcha-response`, `h-captcha-response`, `cf-turnstile-response`) and calls the page's own callback: `data-callback`, else the callback found in `___grecaptcha_cfg`, else the callback `turnstile.render` was given. It prints JSON: kind, sitekey, cost the provider reported, which callback fired, and `after` (the tab's url and title once `--settle` seconds, default 4, have passed; a challenge page navigates away when the callback verified). The token is never printed or logged; it is only in the page and in the provider's reply.

A Cloudflare **challenge page** ("Just a moment...") has no widget in the DOM until its script renders one, and 2Captcha needs the `cData`, `chlPageData` and `action` that script passes to `turnstile.render`. `solve` reloads the tab with `turnstile.render` hooked (`Page.addScriptToEvaluateOnNewDocument`, the method 2Captcha documents), reads those parameters and buys with them. `--no-hook` skips the reload. Not verified end to end: on the one public challenge page tried (`nopecha.com/demo/cloudflare`, 2026-11-13) this Chrome's challenge sat at "Performing security verification" and never called `turnstile.render`, so nothing was bought. A Cloudflare **block** page ("Sorry, you have been blocked") is a ban, not a captcha; `detect` says so. Image captchas, PerimeterX press-and-hold and DataDome are reported as unsupported and nothing is bought.

Flags: `--kind` (only that kind; with `--sitekey` the kind to buy, default `recaptcha_v2`), `--sitekey` (skip detection), `--page-url`, `--index N` (the Nth detected, visible ones first), `--action` (Turnstile or v3 action), `--min-score` (v3, default 0.7), `--submit` (submit the form when no callback fired, or when one fired and the page did not move), `--no-inject` (buy and discard; for a cost check only), `--no-hook`, `--settle S`.

**Money.** Every limit is in the `captcha` section of the tophat config file (`TOPHAT_CONFIG`); the code has no default for any of them and exits 1 naming the missing key:

```json
"captcha": {
  "provider": "2captcha", "keyFile": "~/.config/<keyring>/2captcha-api-key", "apiBase": "https://api.2captcha.com",
  "maxUsdPerSolve": 0.05, "maxUsdPerDay": 2, "maxUsdTotal": 40,
  "estimateUsd": { "recaptcha_v2": 0.005, "recaptcha_v2_enterprise": 0.005, "recaptcha_v3": 0.005, "hcaptcha": 0.005, "turnstile": 0.005 },
  "maxAttempts": 2, "initialWaitSeconds": 8, "pollSeconds": 4, "timeoutSeconds": 150
}
```

Optional: `ledgerFile` (default `<state dir>/captcha/ledger.jsonl`), `"enabled": false` to switch the verb off. Before anything is bought, the kind's `estimateUsd` must fit under `maxUsdPerSolve`, and today's spend (local day) and the lifetime spend plus that estimate must fit under `maxUsdPerDay` and `maxUsdTotal`; otherwise exit 5, nothing bought. The ledger is an append-only jsonl: a `submit` line before the purchase and a `done` line after it with the provider's reported `cost`. A solve with no `done` line, or a timeout (2Captcha may still charge it), counts at its estimate; a refused request or an unsolvable task counts as 0. An unsolvable task is retried up to `maxAttempts`. The key file is read in process and taught to the output redactor with every token.

Exit codes for `captcha`: 0 solved and injected; 1 config missing or invalid; 3 no solvable captcha on the page; 4 the provider did not answer in `timeoutSeconds`; 5 a spend cap refused it (or the verb is switched off); 8 the provider failed, or it solved but the page had no field or callback to take the token (the result JSON is still printed; the solve was paid for).

`web_open` (the chat runner's page reader) calls this itself: when its real-browser route lands on a captcha wall it runs `captcha solve` in its own tab, re-reads the page, and reports an owner blocker only if that fails. `TOPHAT_RUNNER_WEB_CAPTCHA=0` turns that off.

### Target selectors

Anywhere a `TARGET` is taken, these forms work, and **an ambiguous selector is an error that lists every candidate**, never a silent first match:

```
<32-hex id>       exact target id
<hex prefix>      unique id prefix, 6 chars or more
url=URL           exact url
url^=PREFIX       url starts with
url*=SUBSTR       url contains, must be unique
title*=SUBSTR     title contains, must be unique
job=NAME          the tab owned by that job (what --job NAME expands to)
```

**Element selectors pierce frames with `>>>`.** `fill`, `clear`, `tap` and `point` take
`IFRAME_CSS >>> ELEMENT_CSS`, nested as deep as the frames go
(`#outer-frame >>> #inner-frame >>> input`). Each segment is a CSS selector in its own document, the
`>>>` hops are resolved through `DOM.describeNode` into the child target, and **an ambiguous segment
is an error listing every candidate**. That is the fix for frame identity: a frame is the `<iframe>`
element that embeds it, never its url. `frame-map` prints ready-made selectors.

**Selectors also cross same-process cross-origin frames.** A frame that is cross-origin to
its embedder but the **same site** (`pay.homedepot.com` inside `www.homedepot.com`, or `127.0.0.1:8913`
inside `127.0.0.1:8910`) is not a CDP target: Chrome keeps it in the embedder's renderer, so it has no
`/devtools/page/<id>` and `contentDocument` is null. Only a frame on a *different site* is an OOPIF
target. The Home Depot checkout CVV is both in one chain: `#iframe-credit-card-payment-field >>> iframe
>>> #securityCode`, a same-process outer frame holding an OOPIF, and `fill` used to stop at the outer hop
with "the frame ... has frameId ..., which is not a live target". Now a hop whose frameId is not a live
target is reached through its **Runtime execution context** on the nearest ancestor target's socket
(`Runtime.enable` replays existing contexts; the one whose `auxData.frameId` is the frame, default world,
is used, and the lookup is repeated if the frame navigates). Internally such a frame is a virtual target id
`ROOTTARGET@FRAMEID`; a `FrameConn` wrapper adds `contextId` to every `Runtime.evaluate`, so the walk,
hit test, scroll, readback and validation-message scripts run unchanged in the right document. Chains mix
freely: same-process frame then OOPIF, OOPIF then same-process frame, a field directly inside a
same-process frame, any depth. Input events still go to the **page** target at composed page coordinates
(the hit test is run in every hop), so no frame needs its own socket; a frame owned by a virtual hop is
clicked through the page, never through `click_in_owner`. `frame-map` now lists the frames inside a
same-process frame too (`#pay-outer >>> #cvv-frame`, JSON rows carry `sameProcess: true` on the frame
that has no target), and a bare OOPIF target id whose embedder is such a frame finds its embedding
selector through the whole tree. Limits: a passkey-keeper proxied tab has no event stream, so a
same-process hop there fails with a message saying so; an unreachable frame (still loading, navigated
away) says "neither a live target nor a frame with an execution context" instead of the old message.
`fill`, `clear`, `tap` and `point` all use it, `--secret-from` included (the secret guards still check the
final `<input>` and the page origin). Fixture: `parent/samesite.html` -> `127.0.0.1:8913/samesite-outer.html`
-> `localhost:8911/field.html`, 7 assertions (`--only samesite`); the suite is 52 assertions. Before this,
the workaround was `type --in-frame --secret-from ID:cvc --expect-url <the card iframe's own origin>` with
the field focused by hand.

**Selectors also walk open shadow roots.** On a utility portal, a Salesforce
Lightning/LWC page, the cross-origin payment iframe (`secure8.i-doxs.net`) sat inside nested shadow
roots, so `frame-map` did not list it, `'iframe[src*=i-doxs] >>> #id'` failed with "iframes in that
document: iframe", `click FRAME_TARGET X Y` could not find the embedding `<iframe>`, and only
`click --in-frame` worked. Now every selector segment (in `fill`, `clear`, `tap`, `point`,
`frame-map`, the frame-target lookup behind `click`/`type`/`keys`/`fill` on a bare frame id, and in
`dom-click`, `html`, `text`, `wait-for --selector`) matches in the light DOM first, exactly as before,
and only when that finds nothing searches every open shadow root under the current document, so no
selector that resolved before changes meaning. A non-final segment that names a shadow host steps into
its shadow root (`x-outer >>> x-pay >>> #pay-frame >>> #field`), and `frame-map` spells such a chain
out when nothing shorter is unique (`body > main > x-card:nth-of-type(2) >>> iframe`; its JSON rows
carry `shadow: true`). The hit test drills `elementFromPoint` through shadow roots, so an element
inside a component no longer reads as covered by its host. `tap` and `point` take `--text NEEDLE` and
`--index N` to pick among the matches of the final segment (`tap job=pge button --text 'continue'`),
as `dom-click` already did. Closed shadow roots stay unreachable; that is the browser's rule. No more
hand-written recursive `shadowRoot` walkers in `eval`.

### Protected targets

`<config dir>/cdp-protected-targets.txt` (`$TOPHAT_CDP_PROTECT_FILE`; the config dir is `$TOPHAT_CONFIG_DIR`, default `~/.config/tophat`) (one id per line, `#` comments) and `$TOPHAT_CDP_PROTECTED` list targets that `close`, `reload`, `navigate`, `activate`, `click`, `dom-click`, `type`, `keys` and `fill` refuse to touch (exit 5) without `--force`. Put a live checkout or a signed-in session an agent must not disturb in there. Reads (`targets`, `eval`, `html`, `text`, `screenshot`, `info`) are not blocked. Stale ids are harmless; a Chrome target id is never reused.

## Eleven gotchas, all paid for in debugging time

1. **`suppress_origin=True` or HTTP 403.** websocket-client sends an `Origin` header by default and Chrome rejects the DevTools handshake with 403. Every socket this tool opens passes `suppress_origin=True`.
2. **`/json/new` is HTTP 405 on this Chrome.** Tabs are created with `Target.createTarget` over the browser websocket taken from `/json/version` (`webSocketDebuggerUrl`). That is what `new` does, and `/json/*` HTTP errors explain this inline.
3. **Any target attaches at `ws://127.0.0.1:PORT/devtools/page/<targetId>`,** including an out-of-process iframe. The `/devtools/page/` path is right even when the target type is `iframe`. Verified: `tophat-cdp eval <recaptcha iframe id> 'location.href'` returned `https://www.google.com/recaptcha/api2/aframe`.
4. **Input belongs to the PAGE, and a DOM click is not a click.** Measured against `test/cdp/fixtures-cdp-iframe` (two loopback origins, confirmed OOPIFs) and corrected. `Input.insertText` aimed at a *frame* target does land on this Chrome, and the events it produces are trusted, so the old "conditionally silent" reading was half right and useless to act on: whether it lands is a property of the page, and the Shopify card frames are the counter-example. Every input verb now dispatches to the embedding page target at hit-tested page coordinates, and a frame target passed to `click`, `type` or `keys` is routed there (`--in-frame` keeps the old behaviour). The old advice that **`dom-click` is the reliable fallback is wrong**: on the fixture's trusted-event submit button, `el.click()`, `form.requestSubmit(button)` and a full synthetic pointerdown/mousedown/pointerup/mouseup/click sequence produced `submitted: 0, ignored: 4`, while one `Input.dispatchMouseEvent` at a hit-tested point produced `submitted: 1, "Order placed"`. That matches the live `#checkout-pay-button`. Use `tap`; `dom-click` is for handlers that do not check `isTrusted`. One exception, measured cold on a doubly nested frame: a mouse event dispatched at the PAGE target is routed to a child widget by the browser's compositor hit-test data, and a freshly loaded nested OOPIF does not have that data yet, so 4 of 6 runs delivered the keystrokes to the page with the `<iframe>` element as the event target and the field stayed empty; once, the inner document even reported `activeElement === the input` while the typing still went nowhere, so that flag alone proves nothing. `fill` therefore dispatches its FOCUSING click at the owning frame's own widget in frame-local coordinates, which needs no routing (8 of 8 cold runs), after the page-level hit test has proved nothing covers the point. The JSON reports `focusVia: frame | page | page-retry`.
5. **A frame's identity is the `<iframe>` element that embeds it, never its url.** Six Shopify card frames shared one build url, so `url*=number-ltr` matched `issue_number-ltr` as well and `eval` on two different target ids returned the same input. `DOM.describeNode` on the `<iframe>` element returns a `frameId` which, for an OOPIF, **is the target id** (measured: six fixture frames, six exact matches; `Page.getFrameTree` on the parent lists only the root frame and never the OOPIF children, which is the same thing the Oura/Zuora finding hit). Worse than the url collision, and measured live on 2026-10-09: **every Shopify PCI card frame loads the same document, which contains all eight inputs** (`#number, #name, #expiry_month, #expiry_year, #expiry, #verification_value, #issue_date, #issue_number`) and hides the ones that field does not use. So `document.querySelector('input')` returns `input#number` inside the expiry frame, the CVV frame and the name frame alike: the right frame, the wrong field, silently. Address elements as `#card-fields-expiry-... >>> input#expiry`, never `>>> input`; `point` and `fill` refuse a bare `input` there with an ambiguity error listing all eight. Run `frame-map` to get the frame selectors. `url=`/`url*=`/`title*=` still work and an ambiguous one is still a hard error listing the candidates.
6. **React/Shopify inputs ignore DOM `value` assignment.** React tracks the native value setter, so `el.value = x` changes nothing it believes in and fires no input event. Focus the element and use `Input.insertText`: that is `fill`'s default path. `--dom-value` exists for plain forms and goes through the native setter plus synthetic `input`/`change` events.
7. **Select-all inside an OOPIF needs the editing command, not the keystroke.** A bare `Meta+a` key event to the page is delivered and does nothing: the next `insertText` APPENDS (measured: `1228` + `0742` -> `01310742`). `Input.dispatchKeyEvent` carrying `commands: ['selectAll']` selects 0..len inside the focused frame's input and the next `insertText` replaces it. That is what `fill` does, what `keys --select-all` exposes, and why nothing in this tool clears a field with a Backspace loop: on a segmented card input, ten Backspaces from a full last segment walked focus backwards and left `4242 42 _ _`, wiping two neighbouring fields. `clear` is select-all plus an empty `insertText`.
8. **Scroll, then wait for the scroll to stop, then hit-test.** The Shopify checkout scrolls an inner container, not the window (`scrollY` 0, `scrollHeight === innerHeight === 829`), and `scroll-behavior: smooth` means `el.scrollIntoView()` returns while the element is still 700px away, which is how a Pay button measured at y=1277 and a coordinate click there "succeeded" and hit nothing. `point`, `tap`, `fill` and `clear` scroll innermost-frame-first with `behavior:'instant'`, re-measure until the coordinates stop moving, then run `document.elementFromPoint` down the whole frame chain and refuse with exit 7 if it does not reach the element.
9. **(found while building this) Key events into a tab that is not focused vanish.** Verified on a background `example.com` tab: `keyDown`+`text` and `rawKeyDown`+`char` both left the input empty and returned success. Sending `Emulation.setFocusEmulationEnabled {enabled:true}` on the session first makes the identical events insert. `Input.insertText` does not need it. `click`, `type`, `keys` and `fill` turn focus emulation on automatically (`--no-focus-emulation` opts out); it is session-scoped, so it lapses when the socket closes and the owner's real window focus is never changed.
11. **In the viewport is not reachable, and covered is not clipped.** Two failures behind one message, `refusing to fill ... the point is on LABEL ... Internal note`. (a) A field inside a *collapsed* section (an accordion whose content box is `height: 0; overflow: hidden`) keeps its full bounding box, so it passes every in-viewport check while the point under it belongs to the next section; no scroll can reach it. The hit test now walks the element's ancestors and, when one with `overflow` other than `visible` does not contain the point, reports `clipped by DIV (overflow hidden, 526x0) ... expand or open that section first` (reason `clipped`, field `clippedBy` in `point`'s JSON). Open the section (its "Expand section" button) and retry. (b) A field whose rect is inside the viewport but sits under a sticky footer or header was never scrolled, because `locate` only scrolls when the rect is outside the viewport. `fill`, `clear` and `tap` now re-centre the element once when the hit test says `covered` and re-measure before refusing (Mercury's Back/Next bar over "Due date": y 750 -> 414, filled). Both cases are in `test-tophat-cdp-guard.py` (overlay fixture) and pass against the Python tool and the rev6 port.

## Examples

```sh
tophat-cdp status
tophat-cdp targets --type page --filter amazon
tophat-cdp frames --filter checkout.pci

ID=$(tophat-cdp new https://example.com --background)
tophat-cdp eval  $ID 'document.title'
tophat-cdp eval  $ID --file /tmp/snippet.js
tophat-cdp fill  $ID '#email' user@example.com
tophat-cdp keys  $ID Tab 'Shift+h' i Enter
tophat-cdp click $ID 512 699
tophat-cdp screenshot $ID /tmp/page.png --full-page
tophat-cdp wait-for   $ID --selector '#confirmation' --timeout 30
tophat-cdp close $ID
```

### Worked example: Shopify card fields, which is what this was built for

A Shopify checkout embeds each card field in its own cross-origin frame on
`checkout.pci.shopifyinc.com`, and six of them share one build url. Name them by their embedding
element, type through the page, verify twice.

```sh
tophat-cdp job claim buy --url https://SHOP/checkouts/...     # one job, one tab
tophat-cdp --job buy frame-map                                # every frame by its <iframe> element
# #card-fields-number-xxxx  5F3C...  frame  331x44 @ 24,612  https://checkout.pci.shopifyinc.com/build/.../number-ltr.html   [url shared with another frame: only the selector identifies it]

# every one of these frames serves the SAME document with all eight inputs in it, so name the field:
tophat-cdp --job buy fill '#card-fields-number-qybm402p3h000000 >>> input#number'                      4242424242424242
tophat-cdp --job buy fill '#card-fields-expiry-a6rcvn35m4o00000 >>> input#expiry'                      1228
tophat-cdp --job buy fill '#card-fields-verification_value-l87az437mro00000 >>> input#verification_value' 123
tophat-cdp --job buy fill '#card-fields-name-hg6uke6vifi00000 >>> input#name'                          'JANE DOE'
# `>>> input` here is an ambiguity error listing #number #name #expiry_month #expiry_year #expiry
# #verification_value #issue_date #issue_number, which is the error doing its job
tophat-cdp --job buy point '#checkout-pay-button'                     # where it is, and would a click reach it
tophat-cdp --job buy tap   '#checkout-pay-button'                     # only when the order is meant to be placed
```

Each `fill` clicks the field at hit-tested page coordinates, selects all, types into the page target,
reads the value back out of the frame that owns the input, and fails with exit 8 and the page's own
message (`Enter a valid expiration date`) when the checkout is not satisfied. Exit 7 means the
element never came under the pointer and **nothing was dispatched**.

The old frame recipe, kept because a bare frame target still works (it is routed through the
embedding page automatically now):

```sh
tophat-cdp frames --filter checkout.pci --json          # urls collide; frame-map does not
tophat-cdp eval  $FRAME 'document.querySelector("input").name'
tophat-cdp fill  $FRAME 'input[name=number]' 4242424242424242
tophat-cdp tap   $PAGE  'button[type=submit]'
```

### The fixture

`test/cdp/fixtures-cdp-iframe` is a local reproduction of all of the above: a parent page on
`127.0.0.1:8910` embedding real OOPIFs from `localhost:8911` and `127.0.0.1:8912`, with three frames
sharing one url, a trusted-events-only field that publishes its error to the parent, a segmented card
input where Backspace walks backwards, and a submit button below the fold of a smooth-scrolling inner
container. `python3 packages/tools/test/cdp/iframe.py` drives the real CLI through a job named
`iframefix-test` and checks exit codes.
`parent/samesite.html` is a retail-checkout shape: a same-site cross-origin frame (no target) holding a field and an OOPIF. `parent/shadow.html` puts a cross-origin iframe two open shadow roots deep, two
unnamed iframes in sibling shadow hosts, and a field plus a trusted-only button inside shadow roots;
13 more assertions (`--only shadow`). The cases run against the Python tool.

## House rules this tool exists to serve

Agents work in their own explicit tab, which means **claim a job**: `tophat-cdp job claim <task> --url ...`, then `--job <task>` on every command, then `job release <task> --close`. Creating a bare tab with `new` and carrying the id by hand still works and is still refused to other jobs, but it records no owner, so nobody else can see that the tab is taken. Do not select the first tab, do not enable global auto-attach, do not restart or quit Chrome. Separate tabs still share cookies and account state, so coordinate anything that changes a shared session. Prefer CDP and DOM over native input on the shared desktop; native input belongs to a UI-automation tool, one window per job.

## Passkeys

`tophat-cdp passkey {list,status,attach,enroll,save,detach,forget,export,import}` plugs a software
authenticator into a job's tab through the DevTools WebAuthn domain, with the private keys in the
encrypted vault (`src/vault/passkeys/store-cli.mjs` over `EncryptedPasskeyStore`). A page's
`navigator.credentials.create()` and `.get()` then succeed with no hardware, no Touch ID and no
human gesture.

What it cannot do: adopt a passkey that already exists in iCloud Keychain or any other hardware
authenticator. Those private keys are non-exportable by design. A site is only reachable this way
if the credential was REGISTERED through a virtual authenticator, which means being signed in to
that site at registration time. Enrolment is "add a passkey to this account", never a way into an
account you cannot already reach.

Normal use:

```sh
tophat-cdp job claim mysite --url https://example.com/login
tophat-cdp passkey attach --job mysite --rp-id example.com   # BEFORE the sign-in page
# ... drive the sign-in; the ceremony answers itself ...
tophat-cdp passkey detach --job mysite
```

Enrolling, once, from inside a signed-in session:

```sh
tophat-cdp passkey enroll --job mysite --rp-id example.com --user-name jane
# ... click "add a passkey" on the site ...
tophat-cdp passkey save --job mysite --rp-id example.com --user-name jane
```

### Three things measured on Chrome 154.0.8037.98

1. **The virtual authenticator dies with the DevTools session.** Add one, close the websocket,
   reconnect, `WebAuthn.enable`, `getCredentials` and you get "Could not find a Virtual
   Authenticator matching the ID". Worse, a second session that calls `WebAuthn.enable` and then
   disconnects takes the environment down for the session that created it. So `attach` forks a
   keeper process holding one socket for the life of the job, and every other verb proxies through
   it. Chrome also allows only one `internal` authenticator per environment, so `detach` before
   experimenting by hand.

2. **Ed25519 credentials are created but cannot be re-imported.** If a relying party offers COSE
   alg -8 the authenticator will happily mint an Ed25519 key, and `WebAuthn.addCredential` then
   refuses that same key with "An error occurred trying to create the credential" (-32000). P-256
   (alg -7, a 138-byte PKCS#8) round-trips fine; the Ed25519 one is 48 bytes and is a dead
   credential you do not discover until the next sign-in. `enroll` therefore installs
   `ES256_ONLY_SHIM` on the page, wrapping `navigator.credentials.create` to strip everything but
   alg -7 from `pubKeyCredParams`. Before the shim, two stored webauthn.io
   credentials were both unreplayable; after it, the stored key is 138 bytes and replays.

3. **The ceremony needs real window focus.** WebAuthn rejects `create()` and `get()` with "The
   operation is not allowed at this time because the page does not have focus" unless the tab is
   active AND the Chrome window is frontmost on the desktop. `Emulation.setFocusEmulationEnabled`
   does not satisfy it. A locked screen makes it impossible, since nothing can be frontmost behind
   loginwindow; check `ioreg -n Root -d1 -a | grep CGSSessionScreenIsLocked` before blaming the
   code. Raise the window with a UI-automation job around the click.

### Proven round trip

Registered on https://webauthn.io through a virtual authenticator, saved to the vault, detached,
closed the tab, opened a fresh one, `passkey attach` injected the stored key, clicked Authenticate:
the page went to `/profile` reading "You're logged in!" with no gesture at any point.
