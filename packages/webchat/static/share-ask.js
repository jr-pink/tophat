// The small client script of an askable chat share link (/s/<token>, minted with ask = 1). Only that
// page loads it; the clean and notes pages stay server-rendered with no script at all. Plain DOM, no
// framework, no innerHTML: every piece of text, the visitor's and the answer's, goes in as a text node.
// The form is rendered by the page (src/routes/s/[token]/+page.svelte); this wires it.
(function () {
  'use strict';
  var root = document.getElementById('ask');
  if (!root) return;
  var token = root.getAttribute('data-token') || '';
  var endpoint = '/s/' + encodeURIComponent(token) + '/ask';
  var thread = root.querySelector('[data-ask-thread]');
  var form = root.querySelector('form');
  var nameInput = root.querySelector('[data-ask-name]');
  var box = root.querySelector('textarea');
  var button = root.querySelector('button[type=submit]');
  var note = root.querySelector('[data-ask-note]');
  if (!thread || !form || !box || !button) return;

  var memory = {};
  function store(key, value) {
    try { if (value === undefined) return window.localStorage.getItem(key); window.localStorage.setItem(key, value); }
    catch (e) { if (value === undefined) return memory[key] || null; memory[key] = value; }
    return null;
  }
  function randomId() {
    var bytes = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[bytes[i] % 62];
    return out;
  }
  var visitKey = 'tophat-share-visit-' + token;
  var visit = store(visitKey);
  if (!visit || visit.length < 16) { visit = randomId(); store(visitKey, visit); }
  if (nameInput) nameInput.value = store('tophat-share-name') || '';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // Paragraphs on blank lines, line breaks inside them, **bold** as strong; nothing else is markup.
  function fill(node, text) {
    node.textContent = '';
    String(text || '').split(/\n{2,}/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p');
      para.split('\n').forEach(function (line, i) {
        if (i) p.appendChild(document.createElement('br'));
        line.split(/(\*\*[^*]+\*\*)/).forEach(function (part) {
          if (/^\*\*[^*]+\*\*$/.test(part)) p.appendChild(el('strong', '', part.slice(2, -2)));
          else if (part) p.appendChild(document.createTextNode(part));
        });
      });
      node.appendChild(p);
    });
  }
  function turn(asker, question) {
    var wrap = el('div', 'ask-turn');
    wrap.appendChild(el('p', 'ask-who', (asker || 'A visitor') + ' asked'));
    wrap.appendChild(el('p', 'ask-q', question));
    var answer = el('div', 'ask-a');
    wrap.appendChild(answer);
    thread.appendChild(wrap);
    return { wrap: wrap, answer: answer };
  }
  function setNote(text, bad) {
    if (!note) return;
    note.textContent = text || '';
    note.className = 'ask-note' + (bad ? ' bad' : '');
  }

  fetch(endpoint + '?visit=' + encodeURIComponent(visit), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : { asks: [] }; })
    .then(function (data) {
      (data.asks || []).forEach(function (a) {
        var t = turn(a.asker, a.question);
        if (a.answer) fill(t.answer, a.answer);
        else t.answer.appendChild(el('p', 'ask-pending', a.status === 'pending' ? 'Still answering...' : 'No answer was saved.'));
      });
    })
    .catch(function () {});

  var busy = false;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var question = box.value.trim();
    if (!question) return;
    var name = nameInput ? nameInput.value.trim() : '';
    if (nameInput) store('tophat-share-name', name);
    busy = true; button.disabled = true; setNote('');
    var t = turn(name, question);
    t.answer.appendChild(el('p', 'ask-pending', 'Reading the chat...'));
    var text = '';
    function finish(failed) { busy = false; button.disabled = false; if (!failed) { box.value = ''; } box.focus(); }
    function fail(message) {
      t.answer.textContent = '';
      t.answer.appendChild(el('p', 'ask-error', message));
      setNote('', false);
      finish(true);
    }
    fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: question, name: name, visit: visit })
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (body) { fail(body.error || 'That did not go through (' + res.status + ').'); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var pending = '';
      var finished = false;
      function handle(line) {
        if (!line) return;
        var ev; try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === 'reset') { text = ''; t.answer.textContent = ''; t.answer.appendChild(el('p', 'ask-pending', 'Reading the chat...')); }
        else if (ev.type === 'delta') { text += ev.text; fill(t.answer, text); }
        else if (ev.type === 'done') { finished = true; fill(t.answer, ev.answer); finish(false); }
        else if (ev.type === 'error') { finished = true; fail(ev.error || 'No answer came back.'); }
      }
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            pending.split('\n').forEach(handle);
            if (!finished) fail('The connection dropped before the answer finished. Reload to see it if it was saved.');
            return;
          }
          pending += decoder.decode(chunk.value, { stream: true });
          var lines = pending.split('\n'); pending = lines.pop();
          lines.forEach(handle);
          return pump();
        });
      }
      return pump();
    }).catch(function () { fail('Could not reach the server. Check your connection and try again.'); });
  });
  box.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
  });
})();
