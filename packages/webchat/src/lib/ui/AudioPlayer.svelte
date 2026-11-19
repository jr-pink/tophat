<script>
  // Inline audio player card for `![caption](/path/clip.m4a)` (and mp3, wav, ogg, opus, aac, flac). The
  // media element is the engine and has no controls of its own; this card is the whole surface: play or
  // pause, a seek bar, elapsed / total time, a speed choice, and a download link. A file the server cannot
  // find or the browser cannot decode says so in the card (with the reason and the link) rather than
  // leaving a dead control row. Local files stream from /api/file?raw=1, which answers Range requests, so
  // seeking works in Safari and on iOS.
  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

  let { url = '', title = 'Audio' } = $props();

  const local = $derived(String(url).startsWith('/api/file?'));
  const downloadUrl = $derived(local ? url.replace('raw=1', 'download=1') : url);

  let el = $state();
  let playing = $state(false);
  let time = $state(0);
  let duration = $state(0);
  let speed = $state(1);
  let loaded = $state(false);
  let failure = $state('');
  let scrubbing = $state(false);

  // The element reports only "could not play" (MEDIA_ERR_*); a probe of the same URL tells a missing
  // file from a file the browser cannot decode.
  async function explain(code) {
    let reason = code === 4 ? 'this browser cannot play the format' : code === 3 ? 'the file could not be decoded' : code === 2 ? 'the network failed while loading it' : 'loading was aborted';
    try {
      const response = await fetch(url, { headers: { range: 'bytes=0-0' }, cache: 'no-store' });
      if (response.status === 404) reason = 'the file was not found (404): the path may be wrong or the file moved';
      else if (response.status === 401 || response.status === 403) reason = `the server refused it (${response.status})`;
      else if (!response.ok) reason = `the server answered ${response.status}`;
    } catch { reason = 'the server could not be reached'; }
    failure = `Could not play this audio: ${reason}.`;
  }

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
  };
  const toggle = () => { if (!el) return; if (el.paused) el.play().catch((cause) => { if (cause?.name !== 'AbortError') failure = `Could not start playback: ${cause?.message || cause}.`; }); else el.pause(); };
  const seekBy = (seconds) => { if (el) el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds)); };
  $effect(() => { if (el) el.playbackRate = speed; });
  // A new url is a new clip: forget the old one's state.
  $effect(() => { url; failure = ''; loaded = false; playing = false; time = 0; duration = 0; });

  function key(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target?.tagName === 'SELECT') return;
    if (event.key === ' ' || event.key === 'k') toggle();
    else if (event.key === 'ArrowRight') seekBy(5);
    else if (event.key === 'ArrowLeft') seekBy(-5);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
  const status = $derived(failure ? 'error' : playing ? 'playing' : loaded ? 'ready' : 'loading');
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="audio" tabindex="0" onkeydown={key} role="group" aria-label={title} data-testid="audio-player" data-state={status}>
  <div class="head">
    <span class="title" {title}>{title}</span>
    <a href={downloadUrl} target="_blank" rel="noreferrer" title="Download" aria-label="Download">download</a>
  </div>
  <audio bind:this={el} src={url} preload="metadata"
    onloadedmetadata={() => { duration = el.duration; loaded = true; el.playbackRate = speed; }}
    ondurationchange={() => { duration = el.duration; }}
    oncanplay={() => { loaded = true; }}
    onplaying={() => { playing = true; failure = ''; }} onpause={() => { playing = false; }}
    onended={() => { playing = false; time = 0; }}
    ontimeupdate={() => { if (!scrubbing) time = el.currentTime; }}
    onerror={() => explain(el?.error?.code)}></audio>
  {#if failure}
    <p class="fail" role="alert">{failure} <a href={downloadUrl} target="_blank" rel="noreferrer">Download the file</a></p>
  {:else}
    <div class="bar">
      <button type="button" class="play" onclick={toggle} disabled={!loaded} aria-label={playing ? 'Pause' : 'Play'} data-testid="audio-play">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{#if playing}<path d="M4.5 3v10M11.5 3v10" />{:else}<path d="M5 3l8 5-8 5z" />{/if}</svg>
      </button>
      <span class="time" data-testid="audio-time">{fmt(time)}</span>
      <input type="range" min="0" max={duration || 0} step="0.01" value={time} disabled={!loaded} aria-label="Seek"
        oninput={(e) => { scrubbing = true; time = Number(e.currentTarget.value); }}
        onchange={(e) => { if (el) el.currentTime = Number(e.currentTarget.value); scrubbing = false; }} />
      <span class="time">{fmt(duration)}</span>
      <select bind:value={speed} aria-label="Speed" title="Speed">{#each SPEEDS as s (s)}<option value={s}>{s}x</option>{/each}</select>
    </div>
  {/if}
</div>

<style>
  .audio { margin: 1rem 0; border: 1px solid var(--line, #aaa5); border-radius: var(--radius, 12px); background: var(--bg-sunken, #8881); font: 12px var(--mono, monospace); color: var(--ink-dim, inherit); width: 100%; max-width: 34rem; outline: none; overflow: hidden; }
  .audio:focus-visible { border-color: var(--ink-faint, currentColor); }
  .head { display: flex; justify-content: space-between; gap: .75rem; padding: .45rem .7rem; border-bottom: 1px solid var(--line, #aaa5); }
  .title { color: var(--ink, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .head a { color: inherit; flex-shrink: 0; }
  audio { display: none; }
  .bar { display: flex; align-items: center; gap: .55rem; padding: .5rem .7rem; }
  .bar input { flex: 1 1 80px; min-width: 60px; accent-color: var(--ink-dim, currentColor); }
  .play { display: inline-grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0; border: 1px solid var(--line, #aaa5); border-radius: 50%; }
  .play svg { fill: currentColor; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  button { font: inherit; color: var(--ink, inherit); background: none; padding: 0; cursor: pointer; border: 0; }
  button:disabled { color: var(--ink-faint, #888); cursor: default; }
  select { font: inherit; color: var(--ink, inherit); background: none; border: 0; padding: 0; cursor: pointer; }
  .time { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fail { margin: 0; padding: .7rem; color: var(--ink, inherit); }
  .fail a { color: inherit; }
</style>
