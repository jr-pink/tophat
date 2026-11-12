// A reload (or back/forward) of a page that is not the opener's goes back to the opener: the URL names a chat the app would open alone, with no intro.
// The window's own state (sessionStorage `qk:*`: the pane layout with its tabs, `qk:landed`, the reading session) is dropped on every load too, so a
// layout that names a retired opener generation or a tab the visitor opened never comes back (2026-11-11: reload on another chat 'totally borks').
// The demo's own keys (demo-tune, demo-tune-on, demo-fail) and tophat.window-seen are left alone.
try {
  var ss = sessionStorage;
  Object.keys(ss).filter(function (k) { return /^(qk:|sveltekit:)/.test(k); }).forEach(function (k) { ss.removeItem(k); });
  var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  var qc = new URLSearchParams(location.search).get('chat');
  if (nav && (nav.type === 'reload' || nav.type === 'back_forward') && qc && !/^opener-/.test(qc)) { window.__demoBounce = true; location.replace('/'); }
} catch (e) { /* storage off */ }
// The body of an inline script (serve.mjs puts it in the page's first head script). G is the `demo_guest` cookie: a hash of the guest's id, set with the
// session cookie (readable on purpose, so it is the current guest even when the app's service worker served an older copy of this page).
// The webchat keeps its chats in IndexedDB (`tophat-engine*`) and its device state in localStorage (`qk:*`); both outlive a guest in the same
// browser, so a `?fresh=1` load or an expired session (a new guest) would show the old guests' chats beside the new one's. A page for a guest this
// browser has not shown yet starts them from nothing, the folders laid out and folded as below, and the Inbox folded (`tophat-workspaces:chats:main-folded`, the sidebar's own setting:
// the webchat reads it when it has no `qk:sidebar` record, then keeps it there). Runs before the app boots: a delete queued first is served first.
// Every load starts from nothing: all of this origin's IndexedDB, localStorage, Cache Storage and service workers are dropped before the app boots (a delete
// queued first is served first), and the app gets a fresh engine worker name, so a SharedWorker that outlived the previous page (with its cursor
// over the cache just wiped: the 2026-11-10 failure) is never reused. The server is the only record; the sidebar layout below is re-laid each load.
try {
  var SUF = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  window.__chatEngineWorker = 'tophat-chat-engine-' + SUF; // the worker keeps its cache in IndexedDB 'tophat-engine-' + SUF (webchat engine/worker.js)
  var ls = localStorage;
  ls.clear();
  ls.setItem('tophat-workspaces:chats:main-folded', '1');
  // The folders as the seed lays them out, in the sidebar's own legacy record (it imports this when it has no `qk:sidebar` yet, then keeps its own):
  // top to bottom healthhh (folded), personal assistant project (open), then the tophat folder (open) with faqs nested inside it (folded), curiosity / collection (folded). The chats in them are
  // seed/chats.json; test/seed-chats.test.mjs checks these names and states against it.
  ls.setItem('tophat-workspaces:chats', JSON.stringify({ names: ['healthhh', 'personal assistant project', 'tophat', 'faqs', 'curiosity / collection'], current: null, layout: { order: ['healthhh', 'personal assistant project', 'tophat', 'faqs', 'curiosity / collection', '\u0000unfiled'], parent: { faqs: 'tophat' } }, open: ['personal assistant project', 'tophat'] }));
  // The demo page lists a folder's own chats directly under it, above its subfolders, instead of under a Misc row (the sidebar reads this flag).
  ls.setItem('tophat-demo-inline-own', '1');
  ls.setItem('demo-guest', '__SEED_V__');
  // The known-good defaults, written after the wipe (an empty store is not a default: it brought back the webchat's first-run tour, 2026-11-11):
  // the tour is skipped (kit record qk:onboarding, onboardingDecl version 1, its initial state with seeded and skipped set).
  ls.setItem('qk:onboarding', JSON.stringify({ version: 1, base: { seeded: true, step: 'first', skipped: true, done: {}, chats: [], archived: [], created: [], firstChat: null, firstN: 0, autoChat: null, tip: null } }));
} catch (e) { /* storage off: nothing to clear */ }
try {
  // This load's engine opens its own database ('tophat-engine-' + SUF), so it starts empty and never queues behind these deletes: a delete of a
  // database another open tab still holds stays blocked until that tab closes (2026-11-11: with a second tophat.md tab open, a reload waited on the
  // blocked delete and showed an empty sidebar and no intro). Every other database of this origin is dropped in the background.
  var own = 'tophat-engine-' + (typeof SUF === 'string' ? SUF : '');
  var keep = function (n) { return n === own || n === own + '-outbox'; };
  ['tophat-engine', 'tophat-engine-outbox', 'tophat-webchat'].forEach(function (n) { indexedDB.deleteDatabase(n); });
  if (indexedDB.databases) indexedDB.databases().then(function (all) { all.forEach(function (d) { if (d.name && !keep(d.name) && !/^tophat-engine$|^tophat-engine-outbox$|^tophat-webchat$/.test(d.name)) indexedDB.deleteDatabase(d.name); }); }).catch(function () {});
} catch (e) { /* no IndexedDB */ }
try { if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }).catch(function () {}); } catch (e) {}
try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {}); } catch (e) {}
