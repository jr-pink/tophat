// The body of an inline script (serve.mjs puts it in the page's first head script). G is the `demo_guest` cookie: a hash of the guest's id, set with the
// session cookie (readable on purpose, so it is the current guest even when the app's service worker served an older copy of this page).
// The webchat keeps its chats in IndexedDB (`tophat-engine*`) and its device state in localStorage (`qk:*`); both outlive a guest in the same
// browser, so a `?fresh=1` load or an expired session (a new guest) would show the old guests' chats beside the new one's. A page for a guest this
// browser has not shown yet starts them from nothing, the folders laid out and folded as below, and the Inbox folded (`tophat-workspaces:chats:main-folded`, the sidebar's own setting:
// the webchat reads it when it has no `qk:sidebar` record, then keeps it there). Runs before the app boots: a delete queued first is served first.
try {
  var ls = localStorage, m = /(?:^|; )demo_guest=([0-9a-f]+)/.exec(document.cookie), G = m && m[1];
  var GV = G && G + ':__SEED_V__'; // the guest and the seed version: a new seed (or layout) resets a returning guest's local sidebar too
  var was = ls.getItem('demo-guest'), sameGuest = Boolean(was) && was.split(':')[0] === G;
  if (G && was !== GV) {
    var keys = [];
    for (var i = 0; i < ls.length; i++) keys.push(ls.key(i));
    keys.forEach(function (k) { if (/^(__archive__)?qk:/.test(k) || k === 'tophat-workspaces:chats') ls.removeItem(k); });
    ls.setItem('tophat-workspaces:chats:main-folded', '1');
    // The folders as the seed lays them out, in the sidebar's own legacy record (it imports this when it has no `qk:sidebar` yet, then keeps its own):
    // top to bottom healthhh (folded), personal assistant project (open), then the tophat folder (open), curiosity / collection (folded). The chats in them are
    // seed/chats.json; test/seed-chats.test.mjs checks these names and states against it.
    ls.setItem('tophat-workspaces:chats', JSON.stringify({ names: ['healthhh', 'personal assistant project', 'tophat', 'curiosity / collection'], current: null, layout: { order: ['healthhh', 'personal assistant project', 'tophat', 'curiosity / collection', '\u0000unfiled'], parent: {} }, open: ['personal assistant project', 'tophat'] }));
    ls.setItem('demo-guest', GV);
    // The chat cache is only cleared for a different guest. The same guest with a new seed keeps it: the server retires the old seed rows with
    // the app's own drop marker and the new ones are newer than the cache's cursor, so the next sync brings both. Clearing it there (2026-11-10)
    // went wrong whenever the previous page's chat engine (a SharedWorker) outlived the navigation: it kept its cursor over the emptied cache, so the
    // starter chats written before that cursor never came back, only the intro chats, and the intro sent its message three times into a broken page.
    if (!sameGuest) {
      var done = {};
      ['tophat-engine', 'tophat-engine-outbox', 'tophat-webchat'].forEach(function (n) { done[n] = 1; indexedDB.deleteDatabase(n); });
      if (indexedDB.databases) indexedDB.databases().then(function (all) { all.forEach(function (d) { if (/^tophat-engine/.test(d.name) && !done[d.name]) indexedDB.deleteDatabase(d.name); }); }).catch(function () {});
    }
  }
} catch (e) { /* storage off: nothing to clear */ }
