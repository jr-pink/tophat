<script>
  import Icon from './Icon.svelte';
  import PaneMenu from './PaneMenu.svelte';

  let { current = 'chats', items = [], onpick = () => {}, onactivate = null, drop = 'down', align = 'left' } = $props();

  let open = $state(false);

  const TABS = [
    { id: 'notes', label: 'notes', href: '/notes' },
    { id: 'chats', label: 'chats', href: '/?stay' },
    { id: 'fnf', label: 'fnf', href: '/fnf' }
  ];

  // Incognito chat: a chat that keeps nothing (core/incognito.js). From another page it opens the chats page on a
  // new one; the chats page passes its own item without an href, which opens one in place and keeps the tab's other
  // incognito chats alive.
  const ALWAYS = [
    { id: 'incognito', label: 'Incognito chat', href: '/?incognito' },
    { id: 'reader', label: 'Reader', href: '/reader' },
    { id: 'docs', label: 'Docs', href: '/docs' },
    { id: 'shop', label: 'Shop', href: '/shop' },
    { id: 'secrets', label: 'Secrets', href: '/secrets' }
  ];

  // An instance that serves one surface (a public demo that is only chats) names the ids it shows in window.__tophatSurfaces
  // before the app loads; unset, every tab and menu entry shows.
  const surfaces = typeof window !== 'undefined' && Array.isArray(window.__tophatSurfaces) ? new Set(window.__tophatSurfaces) : null;
  const shown = (entry) => !surfaces || surfaces.has(entry.id);
  const menuItems = $derived([...items, ...ALWAYS.filter((entry) => !items.some((item) => item.id === entry.id))].filter(shown));

  function pick(id) {
    open = false;
    const item = menuItems.find((entry) => entry.id === id);
    if (!item) return;
    if (item.href) { location.href = item.href; return; }
    onpick(id);
  }
</script>

<nav class="pill" data-testid="nav-pill" aria-label="Sections">
  {#each TABS.filter(shown) as tab (tab.id)}
    <a
      class="tab press focus-ring"
      class:active={current === tab.id}
      href={tab.href}
      data-testid={`nav-${tab.id}`}
      aria-current={current === tab.id ? 'page' : undefined}
      onclick={(event) => {
        if (current !== tab.id || !onactivate || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        open = false;
        onactivate();
      }}
    >{tab.label}</a>
  {/each}
  <span class="sep"></span>
  
  <span class="more">
    <button
      class="overflow press focus-ring"
      class:on={open}
      onclick={() => (open = !open)}
      aria-label="More"
      aria-haspopup="menu"
      aria-expanded={open}
      title="More"
      data-testid="nav-more"
    ><Icon name="menu" size={13} /></button>
    {#if open}
      <PaneMenu
        items={menuItems}
        prefix="nav-menu"
        {align}
        {drop}
        onpick={pick}
        onclose={() => (open = false)}
      />
    {/if}
  </span>
</nav>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg-raised);
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1;
    
    font-weight: 400;
    letter-spacing: normal;
    font-style: normal;
  }
  .tab {
    padding: 6px 12px;
    border-radius: 999px;
    color: var(--ink-faint);
    text-decoration: none;
    transition: color var(--tap) var(--ease), background var(--tap) var(--ease);
  }
  .tab:hover { color: var(--ink-dim); }
  .active { background: var(--accent-soft); color: var(--ink); }
  .sep { width: 1px; align-self: stretch; margin: 3px 2px; background: var(--line); }
  
  .more { position: relative; display: inline-flex; }
  .overflow {
    
    width: 26px; height: 24px;
    border-radius: 999px;
    display: grid; place-items: center;
    color: var(--ink-faint);
  }
  .overflow:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 8%, transparent); }
  .overflow.on { color: var(--ink); background: color-mix(in srgb, var(--ink) 10%, transparent); }

</style>
