// The demo page's script: the chat list (seeded chats, then the visitor's own), switching chats, the composer, the
// Turnstile check before the first send, the turn counter and the gray-out after the last turn. Server-rendered HTML
// comes from the server; nothing here renders markdown or reaches anything but this origin and Turnstile.
(() => {
  const D = window.__DEMO, $ = (id) => document.getElementById(id);
  const demo = document.querySelector('.demo'), list = $('list'), chat = $('chat'), scroll = $('scroll'), text = $('text'), send = $('send'), left = $('left'), note = $('note'), center = $('center');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KEY = 'tophat-demo-session';
  let token = sessionStorage.getItem(KEY) || '', mine = [], turns = 0, resting = false, busy = false;
  let cur = { kind: 'seed', id: D.selected };
  const api = async (path, body) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'include', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-demo-session': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
  const tab = (t) => { demo.dataset.tab = t; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); };
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

  function renderList() {
    const seed = (s) => `<a data-k="seed" data-id="${esc(s.id)}" class="${cur.kind === 'seed' && cur.id === s.id ? 'on' : ''}">${s.pinned ? '<span class="pin">pinned · daily</span>' : ''}<span class="t">${esc(s.title)}</span>${s.at ? `<span class="d">${esc(day(s.at))}</span>` : ''}</a>`;
    const own = (m) => `<a data-k="mine" data-id="${esc(m.id)}" class="${cur.kind === 'mine' && cur.id === m.id ? 'on' : ''}"><span class="t">${esc(m.title)}</span><span class="d">yours · ${esc(day(m.updated_at))}</span></a>`;
    list.innerHTML = (mine.length ? `<h2>Your chats</h2>${mine.map(own).join('')}` : '') + `<h2>Sample chats</h2>${D.seeds.map(seed).join('')}`;
    list.querySelectorAll('a').forEach((a) => (a.onclick = () => open(a.dataset.k, a.dataset.id)));
  }
  const turnHtml = (m) => m.role === 'user' ? `<div class="turn user"><div class="bubble">${esc(m.text)}</div></div>`
    : `<div class="turn assistant">${m.steps && m.steps.length ? `<div class="steps">${m.steps.map((s) => esc(s.tool)).join(' · ')}</div>` : ''}<div class="prose">${m.html || esc(m.text)}</div></div>`;
  function render() {
    if (cur.kind === 'new') { chat.innerHTML = '<header><h1>New chat</h1><p class="meta">Ask anything about tophat; it answers from the tophat-dev memory.</p></header>'; }
    else if (cur.kind === 'seed') {
      const s = D.seeds.find((x) => x.id === cur.id);
      chat.innerHTML = `<header><h1>${esc(s.title)}</h1><p class="meta">${s.daily ? 'refreshed daily · ' : ''}${s.at ? `answered ${esc(day(s.at))}${s.model ? ' by ' + esc(s.model) : ''}` : 'not answered yet'} · reply to continue it</p></header>` + turnHtml({ role: 'user', text: s.prompt }) + turnHtml({ role: 'assistant', html: s.html, steps: (s.tools || []).map((t) => ({ tool: t })) });
    } else {
      const m = mine.find((x) => x.id === cur.id);
      chat.innerHTML = `<header><h1>${esc(m.title)}</h1><p class="meta">your chat · only you can see it</p></header>` + m.messages.map(turnHtml).join('');
    }
    renderList();
  }
  function open(kind, id) { cur = { kind, id }; render(); scroll.scrollTop = 0; tab('chat'); }
  $('new').onclick = () => open('new', null);
  document.querySelectorAll('[data-open]').forEach((a) => (a.onclick = () => open('seed', a.dataset.open)));
  function counter() {
    const n = Math.max(0, D.cap - turns);
    left.textContent = resting ? 'the demo is resting; try again tomorrow' : `${n} turn${n === 1 ? '' : 's'} left`;
    center.classList.toggle('done', n === 0 && !resting);
    send.disabled = busy || resting || n === 0;
    text.disabled = resting || n === 0;
  }
  $('copy').onclick = async () => { try { await navigator.clipboard.writeText($('onboard').textContent); $('copy').textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents($('onboard')); getSelection().removeAllRanges(); getSelection().addRange(r); } };

  // Turnstile before the first send: a token from the widget, exchanged for a session (cookie, and the header fallback)
  let tsWidget = null;
  const human = () => new Promise((resolve, reject) => {
    if (!D.siteKey) return resolve('');
    const go = () => {
      const opts = { sitekey: D.siteKey, appearance: 'interaction-only', callback: resolve, 'error-callback': () => reject(new Error('the check failed')), 'expired-callback': () => reject(new Error('the check expired')) };
      if (tsWidget != null) { window.turnstile.reset(tsWidget); return; }
      tsWidget = window.turnstile.render('#ts', opts);
    };
    if (window.turnstile) go(); else { let n = 0; const t = setInterval(() => { if (window.turnstile) { clearInterval(t); go(); } else if (++n > 100) { clearInterval(t); reject(new Error('the check did not load')); } }, 100); }
  });
  async function ensureSession() {
    const st = await api('api/state');
    if (st.verified) return true;
    note.textContent = 'checking you are a person';
    const r = await api('api/session', { turnstile: await human() });
    note.textContent = '';
    if (!r.token) throw new Error(r.error === 'resting' ? 'the demo is resting; try again tomorrow' : 'the check failed; try again');
    token = r.token; sessionStorage.setItem(KEY, token);
    return true;
  }
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    const said = text.value.trim();
    if (!said || busy) return;
    busy = true; counter();
    try {
      await ensureSession();
      chat.insertAdjacentHTML('beforeend', turnHtml({ role: 'user', text: said }) + '<p class="thinking" id="thinking">thinking…</p>');
      text.value = ''; scroll.scrollTop = scroll.scrollHeight;
      const body = cur.kind === 'mine' ? { chatId: cur.id, text: said } : cur.kind === 'seed' ? { slot: cur.id, text: said } : { text: said };
      const r = await api('api/turn', body);
      $('thinking')?.remove();
      if (r.status === 200) {
        turns = r.turns;
        const st = await api('api/state'); mine = st.chats || []; turns = st.turns;
        cur = { kind: 'mine', id: r.chat.id }; render(); scroll.scrollTop = scroll.scrollHeight;
        if (r.focus) $('graph').src = 'graph#e=' + encodeURIComponent(r.focus);
      } else if (r.error === 'limit') { turns = D.cap; }
      else if (r.error === 'resting') { resting = true; }
      else { note.textContent = 'that did not go through; try again'; text.value = said; }
    } catch (err) { $('thinking')?.remove(); note.textContent = err.message; text.value = said; }
    busy = false; counter();
  };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); } });
  text.addEventListener('input', () => { text.style.height = 'auto'; text.style.height = Math.min(160, text.scrollHeight) + 'px'; });

  renderList(); counter();
  api('api/state').then((st) => { mine = st.chats || []; turns = st.turns || 0; resting = Boolean(st.resting); renderList(); counter(); }).catch(() => {});
})();
