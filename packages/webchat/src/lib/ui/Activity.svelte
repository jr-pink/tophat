<script>
  import { activityOf, isLive } from '$lib/core/activity.js';

  let {
    online = true,
    connected = false,
    runState = 'idle',
    awaitingFirstToken = false,
    linked = false,
    since = null,
    maintenance = false,
    noteAt = null
  } = $props();

  const live = $derived(isLive({ online, connected, runState }));
  let now = $state(Date.now());
  $effect(() => {
    if (!live) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  const state = $derived(activityOf({
    online, connected, runState, awaitingFirstToken, linked, since, maintenance, noteAt, now
  }));
</script>


<div
  class="activity {state.tone}"
  data-testid="activity"
  data-phase={state.phase}
  data-caret={state.caret}
  role="status"
  aria-label={state.text || 'connected'}
  title={state.text || 'connected to the server'}
>
  <span
    class="glyph"
    class:blink={state.caret === 'blink'}
    class:hollow={state.caret === 'hollow'}
    aria-hidden="true"
  ></span>
  <span class="spin" class:on={state.spinner} aria-hidden="true"></span>
  <span class="label">{state.text}</span>
</div>

<style>
  .activity {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 16px;
    font-size: 11.5px;
    color: var(--ink-faint);
    
  }
  .glyph {
    flex: none;
    width: 0.42em;
    height: 1.05em;
    
    font-size: 15px;
    background: var(--ink-faint);
    border-radius: 1px;
  }
  
  .glyph.hollow {
    background: none;
    box-shadow: inset 0 0 0 1px var(--ink-faint);
  }
  .live .glyph:not(.hollow) { background: var(--accent); }
  
  .warn .glyph:not(.hollow) { background: var(--warn); }
  .warn .glyph.hollow { box-shadow: inset 0 0 0 1px var(--warn); }
  .glyph.blink { animation: caret 1.05s steps(2, jump-none) infinite; }
  
  @keyframes caret { 0%, 45% { opacity: 1; } 46%, 100% { opacity: 0.15; } }

  .spin {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    
    border: 1.5px solid transparent;
    visibility: hidden;
  }
  .spin.on {
    visibility: visible;
    border-color: color-mix(in srgb, var(--ink-faint) 45%, transparent);
    border-top-color: var(--accent);
  }
  .warn .spin.on { border-top-color: var(--warn); }
  @media (prefers-reduced-motion: no-preference) {
    .spin.on { animation: activity-spin 0.9s linear infinite; }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin.on { animation: pulse-live 1.8s ease-in-out infinite; }
  }
  @keyframes activity-spin { to { transform: rotate(360deg); } }

  .label {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .warn .label { color: var(--ink-dim); }
</style>
