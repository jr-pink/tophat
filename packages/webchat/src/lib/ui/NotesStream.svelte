<script>
  // The notes stream: everything he has marked up lately, books and chats in one list, beside the
  // notes document so a note can be moved into it without leaving the page.
  //
  // The rows come from `GET /api/reader/notes?limit=N`, which is the reader's own note store and now
  // holds chat notes too, because a conversation is a document there. So the stream is one fetch,
  // not two, and a chat note and a book note differ only by the marker on the row and by where the
  // backlink goes.
  //
  // It does not page forever. A screenful arrives first and "more" asks for the next screenful by
  // raising the limit, which is all the endpoint offers; when a request comes back short of what
  // it asked for, that was the end of the list and the control goes away.

  import { onMount } from 'svelte';
  import { shortAgo, sortNotes, sourceOf } from '$lib/core/notes-stream.js';

  let {
    transcluded = new Set(),   // note ids already in the document, so a row can say so
    busyId = null,             // the note being written right now
    ontransclude = () => {},
    onclose = () => {},
    page = 20                  // one screenful; "more" asks for another on top of it
  } = $props();

  let notes = $state([]);
  let shown = $state(0);       // the limit the last answer was fetched with
  let more = $state(false);    // whether the list was full, meaning there is likely another page
  let loading = $state(false);
  let error = $state(null);
  let now = $state(Date.now()); // the clock the ago column reads; ticked, not computed per render

  const SWATCH = { yellow: '#e3c34a', blue: '#5b8dd6', rose: '#d67ba8', green: '#6fae74' };
  const swatch = (note) => SWATCH[note?.color] || SWATCH.yellow;

  /**
   * One fetch, at a limit. The answer replaces the list rather than being merged into it: the
   * endpoint always hands back the newest N, a note he edited in between has moved to the top of
   * them, and a note he deleted has to leave the rail rather than linger because it was once on
   * screen. "more" is the same call with a bigger N, so the rows it keeps are the same rows.
   */
  export async function load(size = page) {
    loading = true;
    try {
      const response = await fetch(`/api/reader/notes?limit=${size}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `notes ${response.status}`);
      const rows = body.highlights || [];
      notes = sortNotes(rows);
      shown = size;
      more = rows.length >= size;
      error = null;
    } catch (cause) {
      error = String(cause?.message || cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load(page);
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(tick);
  });
</script>

<aside class="stream" data-testid="notes-stream">
  <div class="stream-bar">
    <span class="stream-title">recent notes</span>
    <button class="chip" onclick={() => load(shown || page)} disabled={loading}
      data-testid="notes-stream-refresh" title="Fetch the newest notes again">{loading ? '...' : 'refresh'}</button>
    <button class="chip" onclick={onclose} data-testid="notes-stream-close" title="Close the stream">close</button>
  </div>

  {#if error}
    <p class="note-state bad" data-testid="notes-stream-error">{error}</p>
  {/if}

  <ul class="notes">
    {#each notes as note (note.id)}
      {@const source = sourceOf(note)}
      <li class="note" style:--swatch={swatch(note)} data-testid="notes-stream-row" data-note={note.id}>
        <div class="head">
          <span class="kind" data-kind={source.kind}>{source.kind}</span>
          <span class="from" title={source.title}>{source.title}</span>
          {#if note.author === 'tophat'}<span class="by">tophat</span>{/if}
          <span class="when">{shortAgo(note.updatedAt || note.createdAt, now)}</span>
        </div>
        {#if note.quote}<p class="quote">{note.quote}</p>{/if}
        {#if note.note}<p class="body">{note.note}</p>{/if}
        {#if note.replies?.length}
          <p class="replies">{note.replies.length} {note.replies.length === 1 ? 'reply' : 'replies'}</p>
        {/if}
        <div class="actions">
          <button
            class="chip"
            disabled={busyId === note.id}
            onclick={() => ontransclude(note)}
            data-testid="notes-stream-add"
            title="Put this note into the notes document, under NEXT"
          >{busyId === note.id ? 'adding' : transcluded.has(note.id) ? 'add again' : 'add'}</button>
          {#if transcluded.has(note.id)}<span class="in" data-testid="notes-stream-in">in notes</span>{/if}
          {#if source.href}
            <a class="chip" href={source.href} data-testid="notes-stream-open"
              title={source.kind === 'chat' ? 'Open the chat at this message' : 'Open the document at this note'}>open</a>
          {:else}
            <span class="chip off" title="This note has no document to open">no source</span>
          {/if}
        </div>
      </li>
    {:else}
      {#if !loading && !error}<li class="note-state" data-testid="notes-stream-empty">No notes yet.</li>{/if}
    {/each}
  </ul>

  {#if more}
    <button class="load-more" onclick={() => load(shown + page)} disabled={loading}
      data-testid="notes-stream-more">{loading ? 'loading' : 'more'}</button>
  {/if}
</aside>

<style>
  /** The rail borrows the notes page's own vocabulary: hairline borders, the chip, the faint ink
   *     Nothing new is introduced here.
   */
  .stream {
    flex: 0 0 min(34vw, 26rem); display: flex; flex-direction: column; min-width: 0;
    border-left: 1px solid var(--line); background: var(--bg); overflow: hidden;
  }
  .stream-bar {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    border-bottom: 1px solid var(--line);
  }
  .stream-title {
    flex: 1; min-width: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--ink-faint);
  }
  .chip {
    border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised);
    color: var(--ink-dim); font: inherit; font-size: 11.5px; padding: 3px 10px; cursor: pointer;
    text-decoration: none;
  }
  .chip:hover { color: var(--ink); }
  .chip:disabled { opacity: 0.5; cursor: default; }
  .chip.off { opacity: 0.45; cursor: default; }

  .notes { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 8px 10px; list-style: none; }
  .note {
    border-left: 2px solid var(--swatch); padding: 6px 0 10px 10px; margin: 0 0 12px;
  }
  .head { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--ink-faint); }
  .kind {
    flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 0 6px;
    text-transform: uppercase; letter-spacing: 0.06em; font-size: 9.5px; line-height: 1.6;
  }
  .from { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .by { flex: 0 0 auto; opacity: 0.8; }
  .when { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  /* The quote is the thing he recognises the note by, so it gets three lines and no more: a stream
     where one highlight fills the rail is not a stream. */
  .quote {
    margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--ink-dim);
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }
  .body { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; }
  .replies { margin: 4px 0 0; font-size: 11px; color: var(--ink-faint); }
  .actions { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .in { font-size: 11px; color: var(--ink-faint); }
  .note-state { font-size: 12px; color: var(--ink-faint); padding: 8px 10px; }
  .note-state.bad { color: var(--warn); }
  .load-more {
    border: 0; border-top: 1px solid var(--line); background: none; color: var(--ink-faint);
    font: inherit; font-size: 11px; padding: 8px; cursor: pointer;
  }
  .load-more:hover { color: var(--ink); }

  @media (max-width: 860px) {
    .stream { flex-basis: min(80vw, 22rem); }
  }
</style>
