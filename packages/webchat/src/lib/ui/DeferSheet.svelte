<script>
  /** Defer until: a time, a condition, or both, in one field with the usual picks beside it.
   *
   * So the field takes exactly what an await todo takes, and `core/defer.js` decides the clock
   * half for nothing; a condition with no hour in it waits on the nightly step or on him. Chats
   * and documents both mount this.
   */
  import { DEFER_PRESETS, parseDefer } from '$lib/core/defer.js';

  let {
    title = '',
    value = '',
    deferred = false,       // already deferred, so there is something to clear
    oncommit = () => {},    // ({ until, condition }) once he has chosen
    onclear = () => {},
    onclose = () => {},
    testid = 'defer-sheet'
  } = $props();

  let text = $state(value);
  let field = $state(null);

  $effect(() => { field?.focus(); field?.select?.(); });

  // What the words mean, said back to him as he types: a parse he cannot see is a parse he
  // cannot trust.
  const parsed = $derived(parseDefer(text));
  const reading = $derived.by(() => {
    if (!text.trim()) return '';
    if (!parsed.until) return 'waits on that condition';
    const when = new Date(parsed.until);
    const sameDay = when.toDateString() === new Date().toDateString();
    const day = sameDay ? 'today' : when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `back ${day} at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  });

  function commit(words) {
    const raw = String(words ?? text).trim();
    if (!raw) return;
    oncommit(parseDefer(raw));
  }

  function keydown(event) {
    if (event.key === 'Enter') { event.preventDefault(); commit(); return; }
    if (event.key === 'Escape') { event.stopPropagation(); onclose(); }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') onclose(); }} />

<div class="scrim" role="presentation" onclick={onclose} data-testid={`${testid}-scrim`}></div>
<div class="sheet" data-testid={testid} role="dialog" aria-label="Defer until">
  <div class="head">
    <span class="what">Defer{title ? ` ${title}` : ''}</span>
    <button class="x press" onclick={onclose} aria-label="Close">✕</button>
  </div>
  <input
    class="field focus-ring"
    bind:this={field}
    bind:value={text}
    onkeydown={keydown}
    placeholder="tomorrow 9am, in 2 hours, when the invoice arrives"
    aria-label="Defer until a time or a condition"
    data-testid={`${testid}-field`}
  />
  {#if reading}<p class="reading" data-testid={`${testid}-reading`}>{reading}</p>{/if}
  <div class="picks">
    {#each DEFER_PRESETS as preset (preset.text)}
      <button class="pick press" onclick={() => commit(preset.text)}>{preset.label}</button>
    {/each}
  </div>
  <div class="foot">
    {#if deferred}
      <button class="clear press" onclick={onclear} data-testid={`${testid}-clear`}>Bring it back now</button>
    {/if}
    <button class="go press" onclick={() => commit()} disabled={!text.trim()} data-testid={`${testid}-commit`}>Defer</button>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, var(--bg-sunken, #000) 40%, transparent); border: 0; }
  .sheet {
    position: fixed; z-index: 21;
    left: 50%; top: 22vh; transform: translateX(-50%);
    width: min(420px, calc(100vw - 32px));
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px;
    background: var(--bg-raised, #fff); color: var(--ink);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 18px 48px color-mix(in srgb, black 22%, transparent);
  }
  .head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-faint); }
  .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { margin-left: auto; border: 0; background: none; color: var(--ink-faint); cursor: pointer; font-size: 12px; }
  .x:hover { color: var(--ink); }
  .field {
    width: 100%; box-sizing: border-box;
    padding: 9px 10px; font: inherit; font-size: 13px;
    color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  }
  .reading { margin: 0; font-size: 11.5px; color: var(--ink-faint); }
  .picks { display: flex; flex-wrap: wrap; gap: 5px; }
  .pick {
    border: 1px solid var(--line-soft); border-radius: 999px;
    padding: 4px 10px; font: inherit; font-size: 12px;
    background: none; color: var(--ink-dim); cursor: pointer;
  }
  .pick:hover { color: var(--ink); background: color-mix(in srgb, var(--ink, #888) 7%, transparent); }
  .foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .clear { border: 0; background: none; color: var(--ink-faint); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 0; }
  .clear:hover { color: var(--ink); text-decoration: underline; }
  .go {
    margin-left: auto;
    border: 0; border-radius: 8px; padding: 6px 14px;
    background: var(--accent-soft, #eee); color: var(--ink); font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .go:disabled { opacity: 0.45; cursor: default; }
</style>
