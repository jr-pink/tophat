// Warms the HTTP cache with what the visitor sees right after the intro: the figures (and image) the opener answer references.
// Inlined in the head by serve.mjs; reads the same `window.__demoBoot` promise as shim.js (the intro's state), whose `warm` lists the
// /api/file URLs exactly as the app will ask for them (same query, same conversation), in the order the answer reaches them.
// Low priority and one at a time, from an idle moment after the page's own load, so the typing and the app's boot never wait for it.
// The responses are cacheable for the guest (serve.mjs sets their cache-control), so the app's own fetch is answered from cache.
(function () {
  var boot = window.__demoBoot;
  if (!boot || !boot.then) return;
  var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 50); };
  var loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise(function (r) { window.addEventListener('load', r, { once: true }); });
  Promise.all([boot, loaded]).then(function (v) {
    var urls = v[0] && Array.isArray(v[0].warm) ? v[0].warm.slice() : [];
    function next() {
      var u = urls.shift();
      if (!u) return;
      fetch(u, { credentials: 'same-origin', priority: 'low' })
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; }) // read to the end: only a complete body is stored
        .catch(function () { /* the app fetches it itself */ })
        .then(function () { idle(next, { timeout: 2000 }); });
    }
    idle(next, { timeout: 2000 });
  });
})();
