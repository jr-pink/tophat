<script>
  // Everyone else's caret and selection in a public document, live: a coloured caret with a name flag,
  // a tint over what they have selected, one colour per person from a hash of their name (the same hue
  // as their avatar in the top bar), the flag fading when they stop and the caret going after a long
  // idle.
  //
  // Cursors are presence, never document: this tab sends where its caret is over the presence
  // endpoint (throttled to one per CURSOR_MS while it moves), the server passes it to the others on
  // the live stream, and each tab resolves it against its own copy of the block (NotesEditor's
  // `where`, over the block's Automerge document), so a caret stays on its character while text
  // shifts around it. Everything is drawn in a fixed layer that takes no pointer events.
  import { onMount } from 'svelte';
  import { liveClientId } from '$lib/client/live.js';
  import { colorOf, IDLE_FLAG_MS, IDLE_HIDE_MS, sameCursor } from '$lib/core/doc-presence.js';

  let { doc, api, presence = [], caretNow = () => null, where = () => null, rev = null } = $props();

  const CURSOR_MS = 40;

  let marks = $state([]);           // [{ client, name, color, caret: {x,y,h} | null, tint: [rects], idle }]
  let now = $state(Date.now());
  const moved = new Map();          // client -> { cursor, at }: when each person's cursor last changed here
  let layout = $state(0);

  // --- sending this tab's caret -------------------------------------------------------------------

  let lastSent;                     // undefined until the first send, so a first null still goes out
  let timer = null;
  let lastAt = 0;
  function schedule() {
    if (timer) return;
    const wait = Math.max(0, CURSOR_MS - (Date.now() - lastAt));
    timer = setTimeout(() => { timer = null; send(); }, wait);
  }
  function send() {
    const cursor = caretNow();
    if (lastSent !== undefined && sameCursor(cursor, lastSent)) return;
    lastSent = cursor;
    lastAt = Date.now();
    const client = liveClientId();
    fetch(`${api}/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-doc-name': encodeURIComponent(doc.name || ''), 'x-doc-client': client },
      body: JSON.stringify({ client, name: doc.name || '', cursor }),
      keepalive: true
    }).catch(() => {});
  }

  // --- drawing everyone else's ----------------------------------------------------------------------

  const scroller = () => document.querySelector('.notes.doc .scroller');
  const rowOf = (lineId) => scroller()?.querySelector(`.line[data-item="${CSS.escape(lineId)}"]`) || null;

  function rangeIn(el, start, end) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0, begun = false, last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue.length;
      last = node;
      if (!begun && start <= seen + length) { range.setStart(node, start - seen); begun = true; }
      if (begun && end <= seen + length) { range.setEnd(node, end - seen); return range; }
      seen += length;
    }
    if (last) { if (!begun) range.setStart(last, last.nodeValue.length); range.setEnd(last, last.nodeValue.length); return range; }
    range.selectNodeContents(el);
    return range;
  }

  // Where character `offset` of a textarea sits on screen: a mirror with the textarea's text
  // metrics, measured and thrown away.
  const MIRROR = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textIndent',
    'textTransform', 'wordSpacing', 'tabSize'];
  function boxPoint(box, offset) {
    const style = getComputedStyle(box);
    const mirror = document.createElement('div');
    for (const key of MIRROR) mirror.style[key] = style[key];
    Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
    const value = box.value || '';
    mirror.textContent = value.slice(0, offset);
    const mark = document.createElement('span');
    mark.textContent = value.slice(offset) || '.';
    mirror.appendChild(mark);
    document.body.appendChild(mirror);
    const top = mark.offsetTop, left = mark.offsetLeft;
    const height = parseFloat(style.lineHeight) || mark.offsetHeight || 18;
    mirror.remove();
    const rect = box.getBoundingClientRect();
    return { x: rect.left + left - box.scrollLeft, y: rect.top + top - box.scrollTop, h: height };
  }

  /** The caret point for { lineId, local }, or null when the line is not on this page. */
  function pointOf(end) {
    const row = rowOf(end.lineId);
    if (!row) return null;
    const span = row.querySelector('[data-text]');
    if (span) {
      const length = (span.textContent || '').length;
      const range = rangeIn(span, Math.min(end.local, length), Math.min(end.local, length));
      const rect = range.getClientRects()[0] || range.getBoundingClientRect();
      const box = span.getBoundingClientRect();
      if (!rect || (!rect.height && !rect.width && !rect.x)) return { x: box.left, y: box.top, h: box.height || 18 };
      return { x: rect.left, y: rect.top, h: rect.height || box.height || 18 };
    }
    const box = row.querySelector('textarea.box.text');
    if (box) return boxPoint(box, Math.min(end.local, (box.value || '').length));
    const rect = row.getBoundingClientRect();
    return { x: rect.left, y: rect.top, h: rect.height };
  }

  /** Tint rectangles from anchor to head, across lines in document order. */
  function tintOf(anchor, head) {
    if (anchor.lineId === head.lineId && anchor.local === head.local) return [];
    const rows = [...(scroller()?.querySelectorAll('.line[data-item]') || [])];
    const ia = rows.findIndex((row) => row.dataset.item === anchor.lineId);
    const ih = rows.findIndex((row) => row.dataset.item === head.lineId);
    if (ia < 0 || ih < 0) return [];
    let [from, to] = ia < ih || (ia === ih && anchor.local <= head.local) ? [anchor, head] : [head, anchor];
    const [i0, i1] = [Math.min(ia, ih), Math.max(ia, ih)];
    const out = [];
    for (let i = i0; i <= i1; i += 1) {
      const row = rows[i];
      const span = row.querySelector('[data-text]');
      const length = span ? (span.textContent || '').length : (row.querySelector('textarea.box.text')?.value || '').length;
      const a = i === i0 ? Math.min(from.local, length) : 0;
      const b = i === i1 ? Math.min(to.local, length) : length;
      if (b <= a) continue;
      if (span) {
        for (const rect of rangeIn(span, a, b).getClientRects()) out.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      } else {
        const box = row.querySelector('textarea.box.text');
        if (!box) continue;
        const p = boxPoint(box, a), q = boxPoint(box, b);
        if (Math.abs(p.y - q.y) < 2) out.push({ x: p.x, y: p.y, w: Math.max(2, q.x - p.x), h: p.h });
        else out.push({ x: p.x, y: p.y, w: Math.max(2, box.getBoundingClientRect().right - p.x), h: p.h });
      }
    }
    return out;
  }

  function draw() {
    const self = liveClientId();
    const seen = new Set();
    const next = [];
    for (const entry of presence) {
      if (!entry?.client || entry.client === self) continue;
      seen.add(entry.client);
      const prior = moved.get(entry.client);
      if (!prior || !sameCursor(prior.cursor, entry.cursor)) moved.set(entry.client, { cursor: entry.cursor, at: Date.now() });
      if (!entry.cursor) continue;
      const idle = now - (moved.get(entry.client)?.at || now);
      if (idle > IDLE_HIDE_MS) continue;
      let at = null;
      try { at = where(entry.cursor); } catch { at = null; }
      if (!at) continue;
      const caret = pointOf(at.head);
      if (!caret) continue;
      const name = entry.name || 'anonymous';
      next.push({ client: entry.client, name, owner: entry.owner, color: colorOf(name), caret, tint: tintOf(at.anchor, at.head), quiet: idle > IDLE_FLAG_MS });
    }
    for (const client of [...moved.keys()]) if (!seen.has(client)) moved.delete(client);
    marks = next;
  }

  let frame = 0;
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); };
  $effect(() => { presence; rev; layout; now; redraw(); });

  onMount(() => {
    const onInput = () => schedule();
    document.addEventListener('selectionchange', onInput);
    window.addEventListener('keyup', onInput, true);
    window.addEventListener('pointerup', onInput, true);
    window.addEventListener('input', onInput, true);
    window.addEventListener('focusout', onInput, true);
    window.addEventListener('scroll', redraw, true);
    window.addEventListener('resize', redraw);
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    let pending = 0;
    const observer = new MutationObserver((records) => {
      if (pending || records.every((record) => (record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest?.('[data-doc-cursors]'))) return;
      pending = requestAnimationFrame(() => { pending = 0; layout += 1; });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => {
      document.removeEventListener('selectionchange', onInput);
      window.removeEventListener('keyup', onInput, true);
      window.removeEventListener('pointerup', onInput, true);
      window.removeEventListener('input', onInput, true);
      window.removeEventListener('focusout', onInput, true);
      window.removeEventListener('scroll', redraw, true);
      window.removeEventListener('resize', redraw);
      clearInterval(clock);
      clearTimeout(timer);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (pending) cancelAnimationFrame(pending);
    };
  });
</script>

<div class="cursors" data-doc-cursors aria-hidden="true" data-testid="doc-cursors">
  {#each marks as mark (mark.client)}
    {#each mark.tint as rect, i (i)}
      <div class="tint" style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.w}px" style:height="{rect.h}px" style:background={mark.color}></div>
    {/each}
    <div class="caret" class:quiet={mark.quiet} data-testid="doc-cursor" data-name={mark.name}
      style:left="{mark.caret.x}px" style:top="{mark.caret.y}px" style:height="{mark.caret.h}px" style:--who={mark.color}>
      <span class="flag" data-testid="doc-cursor-flag">{mark.name}</span>
    </div>
  {/each}
</div>

<style>
  .cursors { position: fixed; inset: 0; pointer-events: none; z-index: 30; overflow: hidden; }
  .tint { position: absolute; opacity: 0.22; border-radius: 2px; }
  .caret { position: absolute; width: 2px; margin-left: -1px; background: var(--who); transition: left 60ms linear, top 60ms linear; }
  .flag {
    position: absolute; left: -1px; bottom: 100%; transform: translateY(-1px);
    background: var(--who); color: #fff; font-size: 10.5px; font-weight: 600; line-height: 1; white-space: nowrap;
    padding: 3px 5px; border-radius: 4px 4px 4px 0; transition: opacity 400ms ease;
  }
  .caret.quiet .flag { opacity: 0; }
</style>
