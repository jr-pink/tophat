<script>
  // The multiplayer room, on the webchat's own client. The transcript, the composer and the notices
  // are the components his chats use, and the state behind them is the app's own session
  // (client/session.js) pointed at this one room by client/mp-session.js: the room's IndexedDB
  // replica paints the transcript before the network answers, events fold through core/reducer.js
  // in the session's batches, sends go through the session's outbox and survive a dropped
  // connection, and the stream, watchdog and heal ladder are the ones the app runs. What differs is
  // only what the session talks to: the gated projection of the room under /api/mp/<token>/ (or
  // /api/mp/ for the legacy room), in the app's shapes (src/lib/server/mp-sync-routes.js).
  //
  // Left out on purpose, because each needs his session or reaches past this room: the sidebar and
  // nav, notes, voice and dictation, chat settings, rename, forks and side threads, search, files.
  import { onMount } from 'svelte';
  import Transcript from '$lib/ui/Transcript.svelte';
  import Composer from '$lib/ui/Composer.svelte';
  import RejectedNotice, { dismiss, rejectedFor } from '$lib/ui/RejectedNotice.svelte';
  import RetryNotice, { retryingNote } from '$lib/ui/RetryNotice.svelte';
  import SkippedNotice from '$lib/ui/SkippedNotice.svelte';
  import TranscriptError, { transcriptFailed } from '$lib/ui/TranscriptError.svelte';
  import { conversationItems } from '$lib/core/reducer.js';
  import { createRoomSession } from '$lib/client/mp-session.js';
  import { classify, readUnsent, writeUnsent } from '$lib/client/mp-outbox.js';
  import { newId } from '$lib/core/contract.js';

  let { token = null } = $props();

  // svelte-ignore state_referenced_locally
  const room = createRoomSession({ token });
  const session = room.session;

  let chatState = $state.raw(session.state);
  let status = $state.raw(session.status);
  let info = $state.raw(room.info);
  let dismissed = $state([]);
  let composer = $state(null);

  // The room says which conversation it is when it answers the join; before that, on a reload, the
  // one conversation the room's own replica holds is it.
  const conversationId = $derived(info.conversationId ?? Object.keys(chatState.conversations)[0] ?? null);
  const conversation = $derived(conversationId ? chatState.conversations[conversationId] : null);
  const items = $derived(conversationId ? conversationItems(chatState, conversationId) : []);
  const running = $derived(['queued', 'starting', 'thinking', 'running'].includes(conversation?.runState));
  const connected = $derived(Boolean(status.connected) && !status.offline);
  const title = $derived(info.title ?? conversation?.title ?? null);
  const refused = $derived(rejectedFor(status?.rejected, conversationId, dismissed));
  const retrying = $derived(retryingNote(status));
  const transcriptDown = $derived(transcriptFailed(status, conversation));

  // His message is kept in a persisted outbox of this tab from the press until the server has it
  // (client/mp-outbox.js). The composer clears at once and the session's own outbox starts only
  // once the room has joined, so before this a send made in the wrong moment, or refused, was
  // gone.
  const namespace = room.names.draftKey.slice('mp:'.length);
  let unsent = $state.raw(readUnsent(namespace));
  let ready = $state(false);
  let failure = $state(null);
  const handedOver = new Set();

  const store = (next) => { unsent = next; writeUnsent(namespace, next); };

  function send(text) {
    const body = typeof text === 'string' ? text : text?.text || '';
    if (!body.trim()) return;
    store([...unsent, { id: newId(), text: body, at: new Date().toISOString() }]);
  }

  // Hand what is waiting to the session, and drop what the server has stored. Replaying an entry
  // under its own action id is idempotent: the server answers a repeated id with `replayed`.
  $effect(() => {
    if (!ready || !conversationId) return;
    const have = new Set(items.map((item) => item.id));
    const outboxIds = new Set((session.outbox || []).map((a) => a.id ?? a.action_id));
    const states = classify(unsent, { outboxIds, rejected: status.rejected || [], itemIds: have, handedOver });
    let keep = states;
    for (const { entry, state, reason } of states) {
      if (state === 'replay') { handedOver.add(entry.id); session.send(conversationId, entry.text, [], { actionId: entry.id }); }
      if (state === 'failed') {
        // Refused for good: the words come back into the composer, with the server's reason.
        failure = `Not sent: ${reason}. Your message is back in the box.`;
        composer?.insert(entry.text);
        dismissed = [...dismissed, entry.id];
      }
    }
    keep = states.filter(({ state }) => state !== 'acked' && state !== 'failed');
    if (keep.length !== unsent.length) store(keep.map(({ entry }) => entry));
  });

  // Everything still in the outbox is not yet acknowledged by the server, even when its optimistic row
  // is already in the transcript, so it is always said.
  const waiting = $derived(unsent);

  function swap() {
    room.rejoinAs(info.identity === 'owner' ? 'anon' : 'owner');
    location.reload();
  }

  onMount(() => {
    const unsubscribe = session.subscribe((next, nextStatus) => {
      chatState = next;
      status = nextStatus;
      if (nextStatus.readyMs !== undefined) {
        window.__webchatBoot = { firstPaintMs: nextStatus.firstPaintMs, readyMs: nextStatus.readyMs, cached: nextStatus.cached };
      }
      // When the transcript first had rows, and how many room responses had finished by then: zero
      // means a reload painted from the room's replica before the network answered.
      if (!window.__mpRoomBoot && Object.values(next.items || {}).some((list) => list?.length)) {
        window.__mpRoomBoot = {
          firstItemsMs: Math.round(performance.now()),
          cached: Boolean(nextStatus.cached),
          roomResponsesDone: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/mp/')).length
        };
      }
    });
    const unroom = room.subscribe((next) => { info = next; });
    room.start().catch(() => null).finally(() => { ready = true; });
    if (typeof window !== 'undefined') window.__mpRoom = room;
    return () => { unsubscribe(); unroom(); };
  });
</script>

<svelte:head><title>{title || 'multiplayer room'}</title></svelte:head>

<section class="room">
  <header>
    {#if title && token}<span class="title">{title}</span>{/if}
    <span class="me" class:owner={info.identity === 'owner'}>{info.identity ?? 'joining…'}</span>
    <span class="here">{info.here.length ? info.here.join(', ') : ''}</span>
    <span class="gate" title="every sentence the assistant emits is classified before it reaches this page">
      {connected ? 'privacy gate on' : status.offline ? 'offline' : 'reconnecting…'}
    </span>
    {#if info.authenticated}
      <button class="swap" onclick={swap}>
        {info.identity === 'owner' ? 'rejoin anonymous' : 'rejoin as owner'}
      </button>
    {/if}
  </header>

  <div class="scroll">
    <SkippedNotice count={status?.skipped || 0} reason={status?.skipReason || ''} />
    {#if transcriptDown}
      <TranscriptError message={status.transcriptError} onretry={() => session.hydrate(conversationId)} />
    {:else}
      <Transcript
        viewerParticipantId={info.participantId}
        {items}
        {running}
        {conversationId}
        loading={!conversation || !conversation.hydrated}
        canLoadEarlier={() => session.canLoadEarlier(conversationId)}
        onLoadEarlier={() => session.loadEarlier(conversationId)}
      />
    {/if}
  </div>

  <div class="chrome">
    <RejectedNotice entries={refused} onresend={(entry) => { dismissed = dismiss(dismissed, entry); if (entry.text) composer?.insert(entry.text); composer?.focus(); }} ondiscard={(entry) => { dismissed = dismiss(dismissed, entry); }} />
    <RetryNotice note={retrying} />
    {#if failure}
      <div class="unsent failed" role="alert" data-testid="mp-failure">{failure} <button onclick={() => { failure = null; }}>dismiss</button></div>
    {/if}
    {#if waiting.length}
      <div class="unsent" role="status" data-testid="mp-unsent">
        {connected ? 'Sending' : 'Offline, will send when the connection is back'}: {waiting.length === 1 ? waiting[0].text.slice(0, 140) : `${waiting.length} messages`}
      </div>
    {/if}
    <Composer
      bind:this={composer}
      onsend={send}
      oninterrupt={() => session.interrupt(conversationId)}
      {running}
      queued={status.queued || 0}
      online={status.online !== false && !status.offline}
      placeholder={info.identity ? `Message the room as ${info.identity}…` : 'Joining…'}
      autofocus
      draftKey={room.names.draftKey}
    />
  </div>
</section>

<style>
  .room {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--bg);
    color: var(--ink);
  }
  header {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .title { font-weight: 600; color: var(--ink-dim); }
  .me { font-weight: 600; }
  .here { color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gate { margin-left: auto; color: var(--live); }
  .title + .me { margin-left: 4px; }
  .swap {
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    border-radius: 8px;
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .scroll { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .chrome { border-top: 1px solid var(--line); }
  .unsent { padding: 6px 16px; font-size: 13px; color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unsent.failed { color: var(--danger, #c0392b); }
  .unsent button { border: 0; background: transparent; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
</style>
