<script>
  // The public face of a share link. One component for both surfaces, because a shared chat and a
  // shared document are the same page with a different body: title, the thing itself, and his
  // notes when this particular token is the notes one.
  import { splitImageLines } from '$lib/core/rich-content.js';
  import { mathInline, textBlocks } from '$lib/core/math.js';

  let { data } = $props();
  const view = data.view;
  const token = data.token;

  const dateOf = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        .format(new Date(iso));
    } catch { return ''; }
  };

  // Chat text arrives as markdown-ish plain text. Without a client bundle this page does no
  // markdown rendering; paragraphs and code fences are what matter for reading, and the text is
  // escaped by Svelte's own interpolation.
  //
  // An image written on its own line (`![alt](https://...)`) is the one exception: a remote one is
  // shown through this share's own image route (/s/<token>/img), which fetches only URLs written in
  // this chat's messages; a local path is never exposed, so it shows its caption only. No script
  // runs here, so a broken image is the browser's own alt text inside a link to the original.
  //
  // Math is rendered here, at render time, by KaTeX (its stylesheet and fonts come with the root
  // layout's CSS): closed $...$, $$...$$, \(...\), \[...\] only, never inside code.
  const paragraphs = (text) => textBlocks(text)
    .flatMap((block) => (block.code ? [{ type: 'code', text: block.text }] : splitImageLines(block.text)
      .map((part) => (part.type === 'text' ? { text: part.text.trim(), html: mathInline(part.text.trim()) } : part))))
    .filter((part) => part.type === 'image' || part.text);
</script>

<svelte:head>
  <title>{view.title}</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
  <meta property="og:title" content={view.title} />
  {#if view.ask}<script src="/share-ask.js?v=1" defer></script>{/if}
  {#if view.byline}<meta property="og:description" content={view.byline} />{/if}
</svelte:head>

<main class="share">
  <header>
    {#if view.withNotes && view.cleanUrl}
      <p class="from"><a class="hide" href={view.cleanUrl} rel="nofollow">notes hidden</a></p>
    {/if}
    <h1>{view.title}</h1>
    {#if view.byline || view.site}
      <p class="byline">{view.byline}{view.byline && view.site ? ' · ' : ''}{view.site}</p>
    {/if}
    {#if view.sourceUrl}
      <p class="source"><a href={view.sourceUrl} rel="noreferrer nofollow">{view.sourceUrl}</a></p>
    {/if}
  </header>

  {#if view.kind === 'doc'}
    <article class="body">
      {#each view.sections as section (section.idx)}
        {#if section.title && view.sections.length > 1}<h2>{section.title}</h2>{/if}
        <!-- Stored section html is sanitised at ingest (reader-extract.js). -->
        {@html section.html}
      {/each}
    </article>
  {:else}
    <article class="body transcript">
      {#each view.messages as message (message.id)}
        <div class="turn {message.role}">
          <p class="who">{message.role === 'owner' ? 'the owner' : 'Tophat'}</p>
          {#each paragraphs(message.text) as part}
            {#if part.type === 'code'}<pre class="code">{part.text}</pre>
            {:else if part.type !== 'image'}{#if part.html.includes('<div')}<div class="para">{@html part.html}</div>{:else}<p>{@html part.html}</p>{/if}
            {:else if part.remote}<figure><a href={part.source} rel="noreferrer nofollow"><img src={`/s/${token}/img?u=${encodeURIComponent(part.source)}`} alt={part.alt || 'Image'} loading="lazy" /></a></figure>
            {:else}<p class="caption">{part.alt || 'Image'}</p>{/if}
          {/each}
        </div>
      {/each}
    </article>
  {/if}

  {#if view.ask}
    <!-- Askable link only: the form is rendered here, wired by /share-ask.js (the one script this
         page loads). Read-only tokens never reach this block, so their pages stay script-free. -->
    <section id="ask" class="ask" data-token={token}>
      <h2>Ask about this chat</h2>
      <p class="ask-lede">Questions are answered from this transcript only; if it does not say, the answer will say so. Your name is just a label.</p>
      <div data-ask-thread class="ask-thread"></div>
      <form>
        <input data-ask-name type="text" maxlength="40" placeholder="Your name (shown with your question)" autocomplete="name" />
        <textarea rows="3" maxlength="1200" placeholder="Ask a question about this chat" required></textarea>
        <div class="ask-row">
          <button type="submit">Ask</button>
          <span data-ask-note class="ask-note"></span>
        </div>
      </form>
      <noscript><p class="ask-note bad">Asking needs JavaScript.</p></noscript>
    </section>
  {/if}

  {#if view.withNotes && view.notes.length}
    <section class="notes">
      <h2>the owner's notes{#if view.cleanUrl} <a class="hide" href={view.cleanUrl} rel="nofollow">notes hidden</a>{/if}</h2>
      {#each view.notes as note (note.id)}
        <div class="note">
          {#if note.quote}<blockquote>{note.quote}</blockquote>{/if}
          {#if note.note}<p class="said">{note.note}</p>{/if}
          {#each note.replies as reply (reply.id)}
            <p class="reply"><span class="who">{reply.author === 'owner' ? 'the owner' : 'Tophat'}</span> {reply.note}</p>
          {/each}
          {#if note.createdAt}<p class="when">{dateOf(note.createdAt)}</p>{/if}
        </div>
      {/each}
    </section>
  {/if}
</main>

<style>
  /** The same palette the app uses (src/app.css), dark by default and light when the reader's
   *     system is light, so a shared page does not flash a cream sheet at someone reading in dark
   *     mode.
   */
  .share {
    --page-bg: #0f1012; --page-raised: #17181c; --page-line: #26282e; --page-line-soft: #1c1e23;
    --page-ink: #e8e6e3; --page-ink-dim: #a1a09c; --page-ink-faint: #6d6c69; --page-accent: #d98a5c;
    --page-mark: #4a3c13; --page-mark-ink: #f3e7c4;
    color-scheme: dark;
    max-width: 44rem; margin: 0 auto; padding: 4rem 1.4rem 6rem;
    background: var(--page-bg); color: var(--page-ink);
    font-family: 'Iowan Old Style', Charter, 'Source Serif 4', Georgia, serif;
    font-size: 1.07rem; line-height: 1.62;
  }
  @media (prefers-color-scheme: light) {
    .share {
      --page-bg: #faf9f7; --page-raised: #ffffff; --page-line: #dedbd5; --page-line-soft: #e9e6e1;
      --page-ink: #1b1a18; --page-ink-dim: #56544f; --page-ink-faint: #8b8880; --page-accent: #b4632f;
      --page-mark: #fff1a8; --page-mark-ink: #1b1a18;
      color-scheme: light;
    }
  }
  /* The sheet is the page, so the colour has to be on the document, not only on this block. */
  :global(html) { background: #0f1012; }
  @media (prefers-color-scheme: light) { :global(html) { background: #faf9f7; } }
  :global(body) { margin: 0; background: inherit; }

    .hide {
    margin-left: 0;
    font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.72rem;
    letter-spacing: 0.04em; text-transform: none; color: var(--page-accent); margin-left: 0.6rem;
  }
  .from {
    font-family: ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif; font-size: 0.78rem;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--page-ink-faint); margin: 0 0 0.9rem;
  }
  h1 { font-family: ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif; font-size: 1.85rem; line-height: 1.2; margin: 0 0 0.5rem; }
  h2 { font-family: ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif; font-size: 1.1rem; margin: 2.4rem 0 0.8rem; }
  .byline, .source { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.9rem; color: var(--page-ink-dim); margin: 0 0 0.3rem; }
  .source a { color: var(--page-ink-dim); }
  .body { margin-top: 2.4rem; }
  .body :global(p) { margin: 0 0 1.05rem; }
  .body :global(p.lede) { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.98rem; color: var(--page-ink-dim); margin-bottom: 2rem; }
  .body :global(p.frame) { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.8rem; letter-spacing: 0.02em; color: var(--page-ink-faint); margin: 1.8rem 0 0.6rem; }
  .body :global(p.frame em) { font-style: normal; }
  .body :global(p.bridge) {
    font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.95rem; color: var(--page-ink-dim);
    padding-left: 0.85rem; border-left: 2px solid var(--page-line);
  }
  .body :global(blockquote) { margin: 0 0 1rem 1rem; color: var(--page-ink-dim); font-style: italic; }
  .body :global(mark.shared-mark) { background: var(--page-mark); color: var(--page-mark-ink); padding: 0.05em 0; }
  .body :global(img) { max-width: 100%; height: auto; }
  .body :global(a) { color: inherit; }
  .transcript .turn { margin: 0 0 1.8rem; }
  .transcript .para { margin: 0 0 1.05rem; }
  .transcript .code {
    font: 0.86rem/1.5 ui-monospace, 'SF Mono', Menlo, monospace; color: var(--page-ink-dim);
    background: var(--page-raised); border: 1px solid var(--page-line-soft); border-radius: 8px;
    padding: 0.7rem 0.9rem; margin: 0 0 1.05rem; overflow-x: auto; white-space: pre;
  }
  .transcript :global(.md-math-display) { display: block; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 0.15em 0; }
  .transcript :global(.md-math-display .katex-display) { margin: 0.3em 0; }
  .transcript figure { margin: 0 0 1.05rem; }
  .transcript figure img { display: block; max-width: 100%; max-height: 32rem; height: auto; border-radius: 8px; }
  .transcript .caption { font-style: italic; color: var(--page-ink-dim); }
  .transcript .who {
    font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.75rem;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--page-ink-faint); margin: 0 0 0.35rem;
  }
  .transcript .owner p:not(.who) { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 1rem; }
  /* The askable link's question box and thread. The thread is built by /share-ask.js, so its rules
     are global; they are scoped to #ask so nothing else on the page is touched. */
  .ask { margin-top: 3.5rem; border-top: 1px solid var(--page-line); padding-top: 1.2rem; }
  .ask h2 { margin-top: 0; }
  .ask-lede { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.88rem; color: var(--page-ink-dim); margin: 0 0 1.2rem; }
  .ask form { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1.2rem; }
  .ask input, .ask textarea {
    font: inherit; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.95rem;
    color: var(--page-ink); background: var(--page-raised); border: 1px solid var(--page-line);
    border-radius: 8px; padding: 0.55rem 0.7rem; width: 100%; box-sizing: border-box;
  }
  .ask textarea { resize: vertical; min-height: 4.5rem; }
  .ask input:focus, .ask textarea:focus { outline: none; border-color: var(--page-accent); }
  .ask-row { display: flex; align-items: center; gap: 0.8rem; }
  .ask button {
    font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.9rem; cursor: pointer;
    color: var(--page-ink); background: var(--page-raised); border: 1px solid var(--page-accent);
    border-radius: 8px; padding: 0.45rem 1.1rem;
  }
  .ask button:disabled { opacity: 0.5; cursor: default; }
  .ask :global(.ask-note) { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.8rem; color: var(--page-ink-faint); }
  .ask :global(.ask-note.bad), .ask :global(.ask-error) { color: #d9694f; }
  .ask :global(.ask-turn) { margin: 0 0 1.6rem; }
  .ask :global(.ask-who) {
    font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.75rem;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--page-ink-faint); margin: 0 0 0.3rem;
  }
  .ask :global(.ask-q) { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; margin: 0 0 0.6rem; white-space: pre-wrap; }
  .ask :global(.ask-a) { padding-left: 0.85rem; border-left: 2px solid var(--page-accent); }
  .ask :global(.ask-a p) { margin: 0 0 0.7rem; }
  .ask :global(.ask-pending) { color: var(--page-ink-faint); font-style: italic; }
  .notes { margin-top: 3.5rem; border-top: 1px solid var(--page-line); padding-top: 1.2rem; }
  .note { margin: 0 0 1.6rem; }
  .note blockquote { margin: 0 0 0.4rem; padding-left: 0.85rem; border-left: 2px solid var(--page-accent); color: var(--page-ink-dim); }
  .note .said { margin: 0; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.97rem; }
  .note .reply { margin: 0.3rem 0 0; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.93rem; color: var(--page-ink-dim); }
  .note .reply .who { font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--page-ink-faint); }
  .note .when { font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; font-size: 0.75rem; color: var(--page-ink-faint); margin: 0.25rem 0 0; }
</style>
