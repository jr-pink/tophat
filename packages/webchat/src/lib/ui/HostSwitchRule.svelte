<script>
  // The rule drawn where a chat changed machine: "machine switched" with the host it moved to. Host labels come from the shared
  // host list (core/hosts.svelte.js); an id the list does not know shows as the id.
  import { hostState } from '$lib/core/hosts.svelte.js';
  import { hostLabel } from '$lib/core/host-notes.js';

  let { item } = $props();
  const to = $derived(hostLabel(hostState.list, item.to) || 'this machine');
</script>

<div class="hostswitch" data-testid="host-switch" data-host={item.to || ''} role="separator" aria-label="Machine switched to {to}">
  <span class="line"></span>
  <span class="text">machine switched · {to}</span>
  <span class="line"></span>
</div>

<style>
  .hostswitch { display: flex; align-items: center; gap: 10px; margin: 8px 0; color: var(--ink-faint); font-size: 11.5px; font-family: var(--mono, ui-monospace, monospace); }
  .line { flex: 1; height: 1px; background: var(--line); }
  .text { white-space: nowrap; }
</style>
