// The body of an inline script (serve.mjs puts it in the page's first head script, with G = a hash of this page's guest id).
// The webchat keeps its chats in IndexedDB (`tophat-engine*`) and its device state in localStorage (`qk:*`); both outlive a guest in the same
// browser, so a `?fresh=1` load or an expired session (a new guest) would show the old guests' chats beside the new one's. A page for a guest this
// browser has not shown yet starts them from nothing, and the Inbox folded (`tophat-workspaces:chats:main-folded`, the sidebar's own setting:
// the webchat reads it when it has no `qk:sidebar` record, then keeps it there). Runs before the app boots: a delete queued first is served first.
try {
  var ls = localStorage;
  if (ls.getItem('demo-guest') !== G) {
    var keys = [];
    for (var i = 0; i < ls.length; i++) keys.push(ls.key(i));
    keys.forEach(function (k) { if (/^(__archive__)?qk:/.test(k) || k === 'tophat-workspaces:chats') ls.removeItem(k); });
    ls.setItem('tophat-workspaces:chats:main-folded', '1');
    ls.setItem('demo-guest', G);
    var done = {};
    ['tophat-engine', 'tophat-engine-outbox', 'tophat-webchat'].forEach(function (n) { done[n] = 1; indexedDB.deleteDatabase(n); });
    if (indexedDB.databases) indexedDB.databases().then(function (all) { all.forEach(function (d) { if (/^tophat-engine/.test(d.name) && !done[d.name]) indexedDB.deleteDatabase(d.name); }); }).catch(function () {});
  }
} catch (e) { /* storage off: nothing to clear */ }
