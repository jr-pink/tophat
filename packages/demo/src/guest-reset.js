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
  window.__chatEngineWorker = 'tophat-chat-engine-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var ls = localStorage;
  ls.clear();
  ls.setItem('tophat-workspaces:chats:main-folded', '1');
  // The folders as the seed lays them out, in the sidebar's own legacy record (it imports this when it has no `qk:sidebar` yet, then keeps its own):
  // top to bottom healthhh (folded), personal assistant project (open), then the tophat folder (open), curiosity / collection (folded). The chats in them are
  // seed/chats.json; test/seed-chats.test.mjs checks these names and states against it.
  ls.setItem('tophat-workspaces:chats', JSON.stringify({ names: ['healthhh', 'personal assistant project', 'tophat', 'curiosity / collection'], current: null, layout: { order: ['healthhh', 'personal assistant project', 'tophat', 'curiosity / collection', '\u0000unfiled'], parent: {} }, open: ['personal assistant project', 'tophat'] }));
  ls.setItem('demo-guest', '__SEED_V__');
} catch (e) { /* storage off: nothing to clear */ }
try {
  var done = {};
  ['tophat-engine', 'tophat-engine-outbox', 'tophat-webchat'].forEach(function (n) { done[n] = 1; indexedDB.deleteDatabase(n); });
  if (indexedDB.databases) indexedDB.databases().then(function (all) { all.forEach(function (d) { if (d.name && !done[d.name]) indexedDB.deleteDatabase(d.name); }); }).catch(function () {});
} catch (e) { /* no IndexedDB */ }
try { if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }).catch(function () {}); } catch (e) {}
try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {}); } catch (e) {}
