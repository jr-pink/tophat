<script>
  import { onMount, tick } from 'svelte';
  import Composer from './Composer.svelte';
  import DictationMic from '../services/voice/ui/DictationMic.svelte';
  import { newChatSettings } from '$lib/client/agent-preference.js';

  let { session, online = true, onnewchat } = $props();
  let surface = $state('closed');
  let mounted = $state(false);
  let root;
  let composer = $state(null);
  let mic;
  let hold;
  let origin;
  let suppressClick = false;
  let keyboardInset = $state(0);
  let viewportHeight = $state(800);
  let notice = $state('');

  function dismiss() { mic?.holdStop(); surface = 'closed'; }
  function showMenu() { dismiss(); surface = 'menu'; }
  function cancelHold() { clearTimeout(hold); hold = null; }
  function press(event) {
    if (event.button !== 0) return;
    suppressClick = false;
    origin = { x: event.clientX, y: event.clientY };
    cancelHold();
    hold = setTimeout(() => { showMenu(); suppressClick = true; }, 450);
  }
  function move(event) {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelHold();
  }
  function click() {
    cancelHold();
    if (suppressClick) { suppressClick = false; return; }
    if (surface !== 'closed') dismiss();
    else onnewchat();
  }
  async function openComposer() {
    mounted = true;
    surface = 'composer';
    notice = '';
    await tick();
    composer?.focus();
  }
  function send(text, attachments) {
    const id = session.newConversationId();
    session.create(id, { title: 'New chat', ...newChatSettings() });
    session.send(id, text, attachments.map((a) => ({ id: a.key, name: a.name, size: a.size })));
    mic?.noteSent(text);
    dismiss();
    notice = 'Chat created in background';
  }
  onMount(() => {
    const outside = (event) => { if (!root?.contains(event.target)) dismiss(); };
    const escape = (event) => {
      if (event.key === 'Escape' && surface !== 'closed') {
        event.preventDefault(); event.stopImmediatePropagation();
        dismiss(); root?.querySelector('[data-testid="new-chat"]')?.focus();
      }
    };
    const resize = () => {
      const view = window.visualViewport;
      viewportHeight = view?.height ?? window.innerHeight;
      keyboardInset = Math.max(0, window.innerHeight - viewportHeight - (view?.offsetTop ?? 0));
    };
    resize();
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerup', cancelHold);
    window.addEventListener('pointercancel', cancelHold);
    window.addEventListener('blur', cancelHold);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      cancelHold();
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerup', cancelHold);
      window.removeEventListener('pointercancel', cancelHold);
      window.removeEventListener('blur', cancelHold);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  });
</script>

{#snippet dictateControl()}
  <DictationMic bind:this={mic} conversationId="background-chat-draft"
    onbegin={(token, options) => composer?.dictateBegin(token, options)}
    onpartial={(token, text) => composer?.dictatePartial(token, text)}
    oncommit={(token, text, options) => composer?.dictateCommit(token, text, options)}
    onextend={(token, text) => composer?.dictateExtend(token, text)}
    onwords={(token, info) => composer?.dictateWords(token, info)}
    oncancel={(token) => composer?.dictateCancel(token)} />
{/snippet}

<div class="chat-launcher" bind:this={root} style:--keyboard-inset={`${keyboardInset}px`} style:--visible-height={`${viewportHeight}px`}>
  {#if mounted}
  <div class="floating-composer" hidden={surface !== 'composer'} role="dialog" aria-label="Create chat behind" data-testid="background-chat">
    <header><span>Create chat behind</span><button class="focus-ring" aria-label="Close background composer" onclick={dismiss}>×</button></header>
    <Composer bind:this={composer} draftKey="background-chat-draft" {online}
      placeholder="Message a new chat…" onsend={send} dictate={dictateControl}
      onsubmit={() => mic?.holdStop({ send: true })}
      onstage={(key) => session.stageUpload(key)}
      onuploadfail={(key, { error } = {}) => session.failUpload(key, error)} />
  </div>
  {/if}
  {#if surface === 'menu'}
    <div class="chat-menu" role="menu" aria-label="New chat options">
      <button role="menuitem" class="focus-ring" onclick={openComposer}>Create chat behind</button>
    </div>
  {/if}
  <button class="fab press focus-ring" data-testid="new-chat" aria-label="New chat"
    aria-haspopup="menu" aria-expanded={surface !== 'closed'} title="New chat (⌘⇧O) · hold for options"
    onpointerdown={press} onpointermove={move} onpointerleave={cancelHold}
    oncontextmenu={(event) => { event.preventDefault(); cancelHold(); showMenu(); suppressClick = true; }}
    onkeydown={(event) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); showMenu(); tick().then(() => root.querySelector('[role="menuitem"]')?.focus());
      }
    }} onclick={click}><span>+</span></button>
</div>
<div class="background-notice" role="status">{notice}</div>

<style>
  .chat-launcher { position: fixed; left: clamp(12px, 4vw, 20px); bottom: calc(max(18px, env(safe-area-inset-bottom)) + var(--keyboard-inset)); z-index: 40; }
  /* On a phone the composer runs to the bottom edge of the screen, so the button rides
     above it: --pane-chrome-h is the focused pane's composer height, published by ChatPane.
     Without this the fab sat on top of the text field. --notif-lift is the height of a notice
     standing in the band above the composer (UndoBar), so the button rides over it too. */
  @media (max-width: 860px) {
    .chat-launcher { bottom: calc(var(--pane-chrome-h, 0px) + 10px + var(--notif-lift, 0px) + var(--keyboard-inset)); }
  }
  .fab { width: 48px; height: 48px; border-radius: 50%; background: var(--accent); color: #14100d; border: 0; font-size: 26px; font-weight: 300; line-height: 1; box-shadow: 0 6px 20px rgb(0 0 0 / 0.32); display: grid; place-items: center; touch-action: manipulation; -webkit-touch-callout: none; user-select: none; }
  .fab:hover { box-shadow: 0 9px 26px rgb(0 0 0 / 0.38); }
  .fab:active { transform: scale(.94); }
  .chat-menu, .floating-composer { position: absolute; bottom: 60px; left: 0; background: var(--bg-raised); color: var(--ink); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 40px rgb(0 0 0 / .3); }
  .chat-menu { padding: 6px; width: 232px; }
  .chat-menu button { width: 100%; min-height: 44px; padding: 10px 14px; text-align: left; border: 0; border-radius: 10px; }
  .chat-menu button:hover { background: var(--bg-sunken); }
  .floating-composer { width: min(460px, calc(100vw - 32px)); max-height: calc(var(--visible-height) - 100px); overflow-y: auto; }
  .floating-composer[hidden] { display: none; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px 0 16px; font-size: 13px; color: var(--ink-dim); }
  header button { width: 44px; height: 44px; font-size: 24px; border: 0; }
  .floating-composer :global(.run-row) { min-height: 0; padding: 0 12px; }
  .floating-composer :global(.composer) { margin: 0; padding: 8px 12px 12px; }
  .floating-composer :global(textarea) { min-width: 0; max-height: max(44px, min(240px, calc(var(--visible-height) - 240px))); }
  .background-notice { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
