# cdp-iframe fixture

A local reproduction of the Shopify `checkout.pci.shopifyinc.com` card-field failures, so
`tophat-cdp`'s out-of-process-iframe (OOPIF) support can be measured without touching a live
payment page.

Run it with the test script beside it:

```sh
python3 packages/tools/test/cdp/iframe.py          # all cases
python3 .../iframe.py --keep                                  # leave the tab + servers up
python3 .../iframe.py --only frame-map,fill-strict
```

Two origins, which is what makes the child frames real OOPIFs on this Chrome:

- parent page: `http://127.0.0.1:8910/` (`parent/index.html`)
- card fields: `http://localhost:8911/...` (`child/`), a different site to Chrome, so each frame
  is its own CDP target with its own `/devtools/page/<id>` socket
- one more nesting level: `http://127.0.0.1:8912/field.html` embedded inside a `localhost:8911`
  frame, so frame chains of depth 2 are covered

What each piece reproduces, numbered as in the 2026-10-09 Yogibo measurement:

| fixture piece | observation reproduced |
| --- | --- |
| `#card-fields-number`, `#card-fields-verification_value`, `#card-fields-name` all with `src=http://localhost:8911/field.html` | (1) three distinct targets whose URL is byte-identical, so `url=` is ambiguous and only the embedding element names them |
| `number-ltr.html` + `issue_number-ltr.html` | (1) the substring alias: `number-ltr` matches both |
| `child/strict.html` (`#card-fields-expiry`) | (2) (5) accepts only `isTrusted` input, reverts a DOM `.value` write on the next frame, and publishes an inline error to the PARENT page |
| `child/segmented.html` (`#card-fields-segmented`) | (3) (4) four segments with auto-advance, and Backspace in an empty segment walks focus back and eats the previous segment |
| `#scrollbox` with `body{overflow:hidden}` | (6) the window never scrolls: `scrollY` stays 0 and `scrollHeight === innerHeight`, exactly like the Shopify checkout; the pay button sits below the fold of an inner container |
| `#pay-button` with an `isTrusted` check | (7) `el.click()`, `form.requestSubmit()` and synthetic pointer sequences do nothing; only a real `Input.dispatchMouseEvent` submits |
| `child/nested-outer.html` | nested frame chains (page -> frame -> frame) |
| `parent/samesite.html` (2026-10-22) | Home Depot checkout CVV: page `127.0.0.1:8910` -> `127.0.0.1:8913/samesite-outer.html` (cross-origin but same site, so NOT a CDP target, `contentDocument` null) -> `localhost:8911/field.html` (an OOPIF), plus a field directly inside the same-process frame; a fourth loopback port, 8913 |
| `parent/shadow.html` (2026-10-21) | myaccount.pge.com (Salesforce LWC): a cross-origin iframe two open shadow roots deep, two unnamed iframes told apart only by their shadow host, a field and a trusted-only button inside shadow roots |

Nothing here talks to the network beyond those four loopback ports (8910 to 8913).
