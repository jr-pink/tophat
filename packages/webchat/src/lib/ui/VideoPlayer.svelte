<script>
  // Inline player for any video in a chat (attachments and assistant embeds). Local files go
  // through /api/file: `videometa` gives source resolution/fps/duration and starts a server-side
  // H.264 transcode when the browser cannot play the original (MJPEG .avi from microscopes);
  // `video` serves the playable form with Range so seeking works. Frame stepping uses source fps.
  const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

  // One player; with `items` it is a gallery: the same controls over a list of titled entries.
  let { url = '', title = 'Video', items = null } = $props();

  const list = $derived(items?.length ? items : [{ url, title }]);
  // Strings, not the array: the markdown compiler hands over a fresh array on every streamed token.
  const urls = $derived(list.map((i) => i.url).join('\n'));
  let index = $state(0);
  const current = $derived(list[Math.min(index, list.length - 1)]);
  const local = (u) => String(u || '').startsWith('/api/file?');
  const downloadUrl = $derived(local(current.url) ? current.url.replace('raw=1', 'download=1') : current.url);

  // Metadata per entry url: {meta} once read, {failed} when the server refused it.
  let metas = $state({});
  let el = $state();
  let root = $state();
  let playing = $state(false);
  let time = $state(0);
  let duration = $state(0);
  let speed = $state(1);
  let loop = $state(true);
  let playError = $state('');

  $effect(() => {
    const targets = urls.split('\n').filter(local);
    let stop = false;
    const timers = [];
    for (const u of targets) {
      let misses = 0;
      const poll = async () => {
        try {
          const response = await fetch(u.replace('raw=1', 'videometa=1'), { cache: 'no-store' });
          const body = await response.json().catch(() => ({}));
          if (stop) return;
          // A 404 is usually an upload still landing: keep looking for two minutes.
          if (response.status === 404 && ++misses < 40) { metas[u] = { waiting: 'waiting for the upload…' }; }
          else if (!response.ok) { metas[u] = { failed: body.message || `could not read video (${response.status})` }; return; }
          else { metas[u] = { meta: body, failed: body.error || '' }; if (body.ready || body.error) return; }
        } catch { if (stop) return; }
        timers.push(setTimeout(poll, 3000));
      };
      poll();
    }
    return () => { stop = true; timers.forEach(clearTimeout); };
  });

  const state = $derived(metas[current.url] || {});
  const meta = $derived(state.meta || null);
  const failed = $derived(state.failed || '');
  const src = $derived(!local(current.url) ? current.url : meta?.ready ? current.url.replace('raw=1', 'video=1') : '');
  function pick(i) { index = i; playError = ''; time = 0; duration = 0; playing = false; }
  const fps = $derived(meta?.fps || 30);
  $effect(() => { if (el) el.playbackRate = speed; });

  const fmt = (s) => {
    if (!Number.isFinite(s)) return '0:00.00';
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
  };
  const frameOf = (t) => Math.floor(t * fps + 1e-3);

  function toggle() { if (!el) return; el.paused ? el.play() : el.pause(); }
  function step(frames) {
    if (!el) return;
    el.pause();
    const end = (el.duration || duration) - 1 / fps;
    // Land a quarter frame into the target so the decoder shows that frame, not its neighbour.
    const target = (frameOf(el.currentTime) + frames + 0.25) / fps;
    el.currentTime = Math.max(0, Math.min(end > 0 ? end : target, target));
  }
  function seekBy(seconds) { if (el) el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds)); }
  function shiftSpeed(d) { speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + d))]; }
  function fullscreen() { document.fullscreenElement ? document.exitFullscreen() : root?.requestFullscreen?.(); }

  function key(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const k = event.key;
    if (k === ' ') toggle();
    else if (k === 'ArrowRight') event.shiftKey ? seekBy(1) : step(1);
    else if (k === 'ArrowLeft') event.shiftKey ? seekBy(-1) : step(-1);
    else if (k === ']') shiftSpeed(1);
    else if (k === '[') shiftSpeed(-1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const describe = (m) => m ? [m.width && m.height ? `${m.width}x${m.height}` : '', m.fps ? `${+m.fps.toFixed(3)} fps` : '', m.duration ? fmt(m.duration) : ''].filter(Boolean).join(' · ') : '';
  const info = $derived(meta ? [describe(meta), meta.transcoded ? 'transcoded' : ''].filter(Boolean).join(' · ') : '');
  const aspect = $derived(meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : '16 / 9');
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="player" bind:this={root} tabindex="0" onkeydown={key} role="group" aria-label={current.title} data-testid="video-player">
  <div class="head"><span class="title">{current.title}</span><a href={downloadUrl} target="_blank" rel="noreferrer">download</a></div>
  <div class="stage" style:aspect-ratio={aspect}>
    {#if src}
      <video bind:this={el} {src} {loop} playsinline preload="auto"
        onclick={toggle}
        onplay={() => playing = true} onpause={() => playing = false}
        ontimeupdate={() => time = el.currentTime} onseeked={() => time = el.currentTime}
        onloadedmetadata={() => { duration = el.duration; el.playbackRate = speed; }}
        onerror={() => playError = 'the browser could not play this video'}><track kind="captions" /></video>
    {:else}
      <p class="wait">{failed || state.waiting || (meta?.transcoded ? 'transcoding…' : 'loading…')}</p>
    {/if}
  </div>
  {#if (failed || playError) && src}<p class="wait">{failed || playError}</p>{/if}
  <div class="bar">
    <button type="button" onclick={toggle} disabled={!src} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'pause' : 'play'}</button>
    <button type="button" onclick={() => step(-1)} disabled={!src} title="Previous frame (←)">‹</button>
    <button type="button" onclick={() => step(1)} disabled={!src} title="Next frame (→)">›</button>
    <input type="range" min="0" max={duration || 0} step={1 / fps} value={time} disabled={!src} aria-label="Seek"
      oninput={(e) => { if (el) el.currentTime = Number(e.currentTarget.value); }} />
    <span class="time">{fmt(time)} / {fmt(duration)} · f{frameOf(time)}</span>
    <select bind:value={speed} aria-label="Speed" title="Speed ([ ])">{#each SPEEDS as s (s)}<option value={s}>{s}x</option>{/each}</select>
    <button type="button" class:off={!loop} onclick={() => loop = !loop} aria-pressed={loop}>loop</button>
    <button type="button" onclick={fullscreen} title="Fullscreen">full</button>
  </div>
  {#if info}<div class="info">{info}</div>{/if}
  {#if list.length > 1}
    <ol class="list" data-testid="video-list">
      {#each list as entry, i (entry.url)}
        <li><button type="button" class:on={i === index} aria-current={i === index} onclick={() => pick(i)}>
          <span class="n">{i + 1}</span><span class="cap">{entry.title}</span><span class="dim">{metas[entry.url]?.failed ? 'unavailable' : describe(metas[entry.url]?.meta)}</span>
        </button></li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .player { margin: 1rem 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-sunken); font: 12px var(--mono); color: var(--ink-dim); width: 100%; outline: none; overflow: hidden; }
  .player:focus-visible { border-color: var(--ink-faint); }
  .head { display: flex; justify-content: space-between; gap: .75rem; padding: .45rem .7rem; border-bottom: 1px solid var(--line); }
  .title { color: var(--ink); overflow-wrap: anywhere; }
  .head a { color: inherit; }
  .stage { width: 100%; max-height: 75vh; background: #000; display: flex; align-items: center; justify-content: center; }
  video { display: block; width: 100%; height: 100%; max-height: 75vh; object-fit: contain; image-rendering: pixelated; background: #000; cursor: pointer; }
  .wait { margin: 0; padding: 1rem; color: var(--ink-faint); }
  .bar { display: flex; align-items: center; gap: .55rem; padding: .4rem .7rem; border-top: 1px solid var(--line); flex-wrap: wrap; }
  .bar input { flex: 1 1 120px; min-width: 80px; accent-color: var(--ink-dim); }
  button { font: inherit; color: var(--ink); background: none; border: 0; padding: .15rem .1rem; cursor: pointer; }
  select { font: inherit; color: var(--ink); background: none; border: 0; padding: 0; cursor: pointer; }
  button:disabled { color: var(--ink-faint); cursor: default; }
  button.off { color: var(--ink-faint); text-decoration: line-through; }
  .time { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .info { padding: 0 .7rem .45rem; color: var(--ink-faint); }
  .list { list-style: none; margin: 0; padding: .25rem 0; border-top: 1px solid var(--line); max-height: 16rem; overflow: auto; }
  .list button { display: flex; gap: .7rem; width: 100%; text-align: left; padding: .3rem .7rem; color: var(--ink-dim); }
  .list button.on { color: var(--ink); background: var(--bg-raised); }
  .list .n { color: var(--ink-faint); min-width: 1.5em; text-align: right; }
  .list .cap { flex: 1; overflow-wrap: anywhere; }
  .list .dim { color: var(--ink-faint); white-space: nowrap; }
  .player:fullscreen .list { display: none; }
  .player:fullscreen { display: flex; flex-direction: column; border: 0; border-radius: 0; }
  .player:fullscreen .stage { flex: 1; max-height: none; aspect-ratio: auto !important; }
  .player:fullscreen video { max-height: none; }
</style>
