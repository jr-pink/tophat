<script>
  import { tick, setContext } from 'svelte';
  import Markdown from './Markdown.svelte';
  import Message from './Message.svelte';
  import ToolRun from './ToolRun.svelte';
  import { groupToolRuns } from '$lib/core/toolruns.js';
  import { conversationItems } from '$lib/core/reducer.js';
  import { readDraft, writeDraft } from '$lib/core/attachments.js';
  import { followDecision } from '$lib/core/follow.js';
  import { isMod } from '$lib/core/keys.js';

  let {
    session,
    chatState,
    thread,
    // Whether this card holds focus: the parent reads it from the kit intent record (threadFocus), never from a flag of its own.
    focused = false,
    oncollapse = () => {},
    onnewchat = () => {},
    // Comment mode, for the public documents (src/lib/ui/DocComments.svelte): the same card over
    // people's comments instead of a side chat. Each entry carries its author and time, the header
    // carries resolve, and nothing here runs an agent. Off, the card is the chat's, unchanged.
    comments = false,
    resolved = false,
    onresolve = null,
    // Delete the whole thread (comment mode): `ondelete()` is called on every press; `deleteArmed` is the state the host
    // keeps (the first press arms, the second deletes), so the label here is only a projection of it.
    ondelete = null,
    deleteArmed = false,
    // Extra header buttons, a snippet given the thread (the reader's Edit / Open link / Delete).
    actions = null
  } = $props();

  // folds (tool runs, thinking) are kept per side chat in the disclosure store, as the main transcript keeps them per chat
  setContext('artifact-conversation', () => thread.id);
  let field = $state(null);
  let text = $state('');
  let body = $state(null);
  let restoredFor = $state(null);

  const items = $derived(conversationItems(chatState, thread.id).filter((item) => !item.agentId));
  const turns = $derived(items.filter((item) => item.type === 'user' || item.type === 'assistant'));
  const tools = $derived(items.filter((item) => item.type === 'tool'));
  // a side chat renders like the main chat: the same message and tool-run components, tool calls folded into runs the same way
  const rows = $derived(groupToolRuns(items.filter((item) => ['user', 'assistant', 'tool', 'thinking'].includes(item.type))));
  const running = $derived(['queued', 'starting', 'thinking', 'running'].includes(thread.runState));
  const quote = $derived(String(thread.sidechat?.quote || '').replace(/\s+/gu, ' ').trim());

  $effect(() => {
    if (thread.id === restoredFor) return;
    restoredFor = thread.id;
    text = readDraft(thread.id);
    tick().then(resize);
  });
  $effect(() => { if (thread.id === restoredFor) writeDraft(thread.id, text); });

  $effect(() => {
    text;
    if (field) tick().then(resize);
  });

  function resize() {
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
  }

  let stickBody = true;
  let wrote = -1;
  let seenHeight = 0;
  let seenTop = 0;
  let seenAt = 0;
  function bodyScrolled() {
    if (!body) return;
    const out = followDecision({
      seenHeight,
      seenTop,
      seenAt,
      now: performance.now(),
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      following: stickBody,
      wrote
    });
    seenHeight = out.seen.height;
    seenTop = out.seen.top;
    seenAt = out.seen.at;
    if (out.ours) return;
    wrote = -1;
    stickBody = out.stick;
  }
  $effect(() => {
    items.length;
    items.at(-1)?.text?.length;
    if (!body || !stickBody) return;
    if (wrote >= 0 && Math.abs(body.scrollTop - wrote) > 1.5) {
      wrote = -1;
      stickBody = false;
      return;
    }
    tick().then(() => {
      if (!body || !stickBody) return;
      if (wrote >= 0 && Math.abs(body.scrollTop - wrote) > 1.5) {
        wrote = -1;
        stickBody = false;
        return;
      }
      body.scrollTop = body.scrollHeight;
      wrote = body.scrollTop;
      seenHeight = body.scrollHeight;
      seenAt = performance.now();
    });
  });

  function submit() {
    const value = text.trim();
    if (!value) return;
    text = '';
    writeDraft(thread.id, '');
    try { field?.dispatchEvent(new CustomEvent('tophat-measure', { bubbles: true, detail: { type: 'send', text: value, valueAfter: '', thread: thread.id, anchor: thread.sidechat } })); } catch {  }
    session.send(thread.id, value);
  }

  function keydown(event) {
    if (event.key === 'Enter' && isMod(event) && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      // The words typed ride along; a host that takes them (the reader hands the note to the
      // agent) answers true and the box empties. The chat's handler ignores them, as before.
      const said = text.trim();
      if (onnewchat({ split: event.shiftKey, text: said }) === true) { text = ''; writeDraft(thread.id, ''); }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !isMod(event) && !event.isComposing) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) { allowBreak = true; return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      oncollapse();
    }
  }

  // A phone's keyboard sends its checkmark as a line break on beforeinput, never as a keydown of
  // Enter, so the composer has to read that too or the only way to send from a phone is the arrow.
  let allowBreak = false;

  function beforeinput(event) {
    if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') return;
    if (allowBreak) { allowBreak = false; return; }
    event.preventDefault();
    submit();
  }

</script>


<article
  class="card"
  class:focused
  class:running
  data-testid="sidechat"
  data-sidechat={thread.id}
  data-thread={thread.id}
  data-focused={focused ? 'true' : 'false'}
  data-focus-at={`thread:${thread.id}`}
>
  <header>
    <p class="quote" data-testid="sidechat-quote" title={quote}>{quote}</p>
    {#if actions}{@render actions(thread)}{/if}
    {#if comments && onresolve && turns.length}
      <button class="resolve press focus-ring" onclick={() => onresolve(!resolved)} data-testid="comment-resolve"
        aria-label={resolved ? 'Reopen this thread' : 'Resolve this thread'} title={resolved ? 'Reopen' : 'Resolve'}>{resolved ? 'reopen' : '✓'}</button>
    {/if}
    {#if comments && ondelete && turns.length}
      <button class="del press focus-ring" class:armed={deleteArmed} onclick={ondelete} data-testid="comment-delete"
        aria-label={deleteArmed ? 'Press again to delete this thread and its replies' : 'Delete this thread and its replies'}
        title={deleteArmed ? 'Press again to delete' : 'Delete this thread'}>{deleteArmed ? 'delete?' : 'delete'}</button>
    {/if}
    <button class="x press focus-ring" onclick={oncollapse} data-testid="sidechat-collapse" aria-label="Collapse this thread" title="Collapse (Esc)">×</button>
  </header>

  <div class="body" bind:this={body} onscroll={bodyScrolled} data-testid="sidechat-body">
    {#if !comments}
      {#each rows as row (row.id)}
        <div class="srow">
          {#if row.type === 'toolrun'}<ToolRun run={row} />{:else}<Message item={row} />{/if}
        </div>
      {/each}
    {:else}
    {#each turns as item (item.id)}
      {#if item.type === 'user' && comments}
        <div class="remark" data-testid="comment" data-comment={item.id}>
          <p class="by"><span class="name" class:owner={item.owner} data-testid="comment-author">{item.author || 'anonymous'}</span>
            {#if item.at}<time datetime={item.at} title={new Date(item.at).toLocaleString()}>{new Date(item.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>{/if}
            {#if item.pending}<span class="pending" title="Not sent yet; it goes when the server is back">sending</span>{/if}</p>
          <p class="said comment-text" data-testid="sidechat-user">{item.text}</p>
        </div>
      {:else if item.type === 'user'}
        <p class="said" data-testid="sidechat-user">{item.text}</p>
      {:else}
        
        <div class="reply" data-testid="sidechat-reply" data-item={item.id} data-role="assistant" data-streaming={item.streaming ? 'true' : 'false'}>
          <Markdown text={item.text} />
        </div>
      {/if}
    {/each}
    {/if}
    {#if running && !turns.some((item) => item.type === 'assistant' && item.streaming)}
      <p class="working" data-testid="sidechat-working"><span class="dot"></span> working…</p>
    {/if}
  </div>

  <div class="ask">
    <textarea
      bind:this={field}
      bind:value={text}
      onkeydown={keydown}
      onbeforeinput={beforeinput}
      enterkeyhint="send"
      rows="1"
      placeholder={comments ? (turns.length ? 'Reply…' : 'Comment…') : turns.length ? 'Follow up…' : 'Ask about this…'}
      data-testid="sidechat-composer"
      data-focus-field
      aria-label={comments ? 'Comment on this line' : 'Ask about the highlighted passage'}
    ></textarea>
    <button class="send press focus-ring" onclick={submit} disabled={!text.trim()} data-testid="sidechat-send" aria-label="Send">↑</button>
  </div>
</article>

<style>
  .card {
    width: 100%;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.16);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    
    transition: border-color var(--panel) var(--ease), box-shadow var(--panel) var(--ease);
  }
  .card.focused {
    border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
  }

  header { display: flex; align-items: flex-start; gap: 6px; padding: 9px 8px 6px 11px; }
  .quote {
    flex: 1; min-width: 0; margin: 0;
    font-size: 11.5px; line-height: 1.35; color: var(--ink-faint);
    border-left: 2px solid var(--accent);
    padding-left: 7px;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    overflow: hidden;
  }
  
  .x {
    color: var(--ink-faint);
    font-size: 15px; line-height: 1;
    flex: none;
    width: 24px; height: 24px;
    display: grid; place-items: center;
    border-radius: 6px;
  }
  .x:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .resolve {
    flex: none; height: 24px; min-width: 24px; padding: 0 6px; border-radius: 6px;
    font-size: 12px; color: var(--ink-faint); display: grid; place-items: center;
  }
  .resolve:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .del {
    flex: none; height: 24px; padding: 0 6px; border-radius: 6px;
    font-size: 12px; color: var(--ink-faint); display: grid; place-items: center;
  }
  .del:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .del.armed { background: var(--warn, #c0392b); color: #fff; }
  .remark { margin: 0 0 8px; }
  .by { margin: 0 0 2px; font-size: 11px; color: var(--ink-faint); display: flex; gap: 6px; align-items: baseline; }
  .by .name { color: var(--ink); font-weight: 600; }
  .by .name.owner { color: var(--accent); }
  .by .pending { font-style: italic; }
  .said.comment-text { background: transparent; padding: 0; border-radius: 0; margin: 0; }
  @media (hover: none) { .x { width: 34px; height: 34px; } }

  .body {
    padding: 0 11px;
    max-height: min(60vh, 494px); /* 30% taller than min(46vh, 380px) */
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .body:empty { display: none; }
  .said {
    margin: 0 0 7px;
    align-self: flex-end;
    background: var(--accent-soft);
    border-radius: 10px 10px 3px 10px;
    padding: 6px 9px;
    font-size: 12.5px; line-height: 1.4;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reply { margin: 0 0 9px; font-size: 12.5px; line-height: 1.5; color: var(--ink-dim); }
  .reply :global(p) { margin: 0 0 0.55em; }
  .reply :global(pre) { font-size: 11px; }
  .srow { margin: 0 0 6px; font-size: 13.5px; }
  .srow :global(.row) { padding-left: 0; padding-right: 0; }
  .tools, .working { margin: 0 0 8px; font-size: 11px; color: var(--ink-faint); font-family: var(--mono); }
  .working { display: flex; align-items: center; gap: 6px; }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
    animation: sidechat-pulse 1.6s ease-in-out infinite;
  }
  @keyframes sidechat-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.9; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }

  .ask { display: flex; align-items: flex-end; gap: 6px; padding: 7px 8px 8px 11px; border-top: 1px solid var(--line-soft); }
  textarea {
    flex: 1; min-width: 0;
    resize: none;
    background: transparent;
    border: 0;
    padding: 4px 0;
    color: var(--ink);
    font-family: var(--sans);
    
    font-size: 16px;
    line-height: 1.35;
    max-height: 132px;
    outline: none;
  }
  .send {
    width: 24px; height: 24px; flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: #14100d;
    font-size: 13px; font-weight: 600;
    display: grid; place-items: center;
  }
  .send:disabled { background: var(--line); color: var(--ink-faint); cursor: default; transform: none; }
</style>
