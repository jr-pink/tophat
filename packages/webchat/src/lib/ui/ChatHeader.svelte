<script>
  import Icon from './Icon.svelte';
  import PaneMenu from './PaneMenu.svelte';
  import ShareLinks from './ShareLinks.svelte';
  import ScopeBar from './ScopeBar.svelte';
  import { ensureScopes, scopeState } from '$lib/core/scopes.svelte.js';
  import { effectiveFastMode, fastModeAvailable } from '$lib/core/contract.js';
  import { familyOf } from '$lib/core/model-family.js';
  import { CATALOGUE, PROVIDER_LABELS, REASONING_EFFORTS, capabilitiesOf, providerOfModel } from '$lib/core/providers.js';
  import { backends, ensureBackends } from '$lib/core/backends.svelte.js';
  import { INCOGNITO_LABEL, isIncognito } from '$lib/core/incognito.js';
  import { placeMenu, shouldCollapse } from '$lib/core/menu-place.js';

  let {
    conversation = null,
    dim = false,
    onfind = () => {},
    onfork = () => {},
    pane = null,
    onpane = () => {},
    onclosepane = null,
    onsettings = () => {},
    onrename = () => {},
    onmovescope = () => {},
    forkCount = 0
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let menuOpen = $state(false);

  const paneItems = $derived(pane ? [
    { id: 'duplicate', label: 'Duplicate', disabled: pane.count >= pane.max },
    { id: 'left', label: 'Move left', disabled: pane.index <= 0 },
    { id: 'right', label: 'Move right', disabled: pane.index >= pane.count - 1 },
    { id: 'close', label: 'Close pane', disabled: pane.count <= 1 }
  ] : []);

  // With one pane open, move left, move right and close pane are all dead, so
  // the menu would be one live item under three grey ones. The button is then
  // the action itself: a click duplicates. It goes back to being a menu the
  // moment there is a second pane.
  const soloDuplicate = $derived(!!pane && pane.count <= 1 && pane.count < pane.max);
  // Losing the second pane while its menu is open leaves no menu behind.
  $effect(() => { if (soloDuplicate) menuOpen = false; });

  const settings = $derived(conversation?.settings || {});
  const scopeOn = $derived(!!scopeState.enabled && (scopeState.scopes?.length || 0) > 0);
  // An incognito chat (core/incognito.js) runs on the direct provider only and has nothing to share.
  const incognito = $derived(isIncognito(conversation?.id));

  $effect(() => { ensureBackends(); ensureScopes(); });
  const offered = $derived.by(() => {
    const current = settings.provider || providerOfModel(settings.model);
    const list = backends.providers.includes(current)
      ? backends.providers
      : [...backends.providers, current];
    return list.filter((p) => CATALOGUE[p] && (!incognito || p === 'direct'));
  });


  function commitTitle() {
    editing = false;
    const value = draft.trim();
    if (value && value !== conversation.title) onrename(value);
  }

  // The header answers to the PANE's width, not the window's. The title takes every spare pixel;
  // the pane button and the close X never shrink and never leave the bar; the settings and
  // secondary actions fold into a menu button when they would leave the title less than TITLE_MIN
  // (and always below a 420px bar, by a CSS container query that needs no measuring).
  let bar = $state(null);
  let moreBtn = $state(null);
  let more = $state(null);
  let moreOpen = $state(false);
  let place = $state(null);
  const MENU_WIDTH = 272;

  function reposition() {
    if (!moreBtn || !moreOpen) return;
    // The button is display:none once the pane is wide again; the controls are back on the bar.
    if (!moreBtn.offsetParent) { moreOpen = false; return; }
    place = placeMenu({ anchor: moreBtn.getBoundingClientRect(), width: MENU_WIDTH, vw: window.innerWidth, vh: window.innerHeight });
  }

  function toggleMore() {
    if (moreOpen) { closeMore(); return; }
    moreOpen = true;
    reposition();
  }

  function closeMore(refocus = false) {
    moreOpen = false;
    if (refocus) moreBtn?.focus();
  }

  const focusables = () => [...(more?.querySelectorAll('button:not([disabled]), select:not([disabled]), input, textarea, [tabindex="0"]') || [])]
    .filter((el) => el.offsetParent !== null);

  // The menu lives on <body> so no pane clips it and no neighbouring pane's header paints over it.
  function portal(node) {
    document.body.appendChild(node);
    return () => node.remove();
  }

  // Fold the inline controls into the menu when they would squeeze the title below TITLE_MIN.
  // Measured in a ResizeObserver, which runs after layout and before paint, so the bar is never
  // drawn in the in-between state. The controls' natural width is remembered while they are
  // hidden; when they come back and turn out wider, the observer folds them again in the same frame.
  let inlineEl = $state(null);
  let endsEl = $state(null);
  let collapsed = $state(false);
  let natural = 0;
  const TITLE_MIN = 180;

  function measure() {
    if (!bar) return;
    if (inlineEl && inlineEl.offsetParent !== null) natural = inlineEl.offsetWidth;
    const style = getComputedStyle(bar);
    const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2 * (parseFloat(style.columnGap) || 0);
    collapsed = shouldCollapse({ barWidth: bar.clientWidth, inlineWidth: natural, endsWidth: endsEl?.offsetWidth || 0, titleMin: TITLE_MIN, chrome });
    reposition();
  }

  $effect(() => {
    if (!bar) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(bar);
    if (inlineEl) observer.observe(inlineEl);
    if (endsEl) observer.observe(endsEl);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!moreOpen) return;
    queueMicrotask(() => focusables()[0]?.focus());
    const away = (event) => {
      if (more?.contains(event.target) || moreBtn?.contains(event.target)) return;
      closeMore();
    };
    const onresize = () => reposition();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', onresize);
    window.addEventListener('scroll', onresize, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', onresize);
      window.removeEventListener('scroll', onresize, true);
    };
  });

  function menuKey(event) {
    if (event.key === 'Escape') {
      // A sheet opened from inside the menu (scope rules, move confirm) closes first.
      if (event.defaultPrevented || more?.querySelector('[role="dialog"]')) return;
      event.preventDefault(); event.stopPropagation(); closeMore(true); return;
    }
    const tag = event.target?.tagName;
    const typing = tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
    const list = focusables();
    const at = list.indexOf(document.activeElement);
    if (event.key === 'Tab' && list.length) {
      // Focus stays in the menu until it is closed, so Tab never lands somewhere behind it.
      if (!event.shiftKey && at === list.length - 1) { event.preventDefault(); list[0].focus(); }
      else if (event.shiftKey && at <= 0) { event.preventDefault(); list[list.length - 1].focus(); }
      return;
    }
    if (typing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    }
  }
</script>


{#snippet settingsControls(inMenu)}
  {#if inMenu && scopeOn}<div class="row" data-testid="more-scope"><span class="label">scope</span><span class="ctl"><ScopeBar {conversation} onmove={onmovescope} /></span></div>
  {:else if !inMenu}<ScopeBar {conversation} onmove={onmovescope} />{/if}

  {#if inMenu}<span class="label row-label" aria-hidden="true">model</span>{/if}
  <select
    class="model focus-ring"
    value={settings.model}
    onchange={(event) => {
      const model = event.currentTarget.value;
      // The option knows which group it was picked from: a model id offered by two providers (gpt-6-astra under Codex and Direct) must not flip the provider.
      const picked = event.currentTarget.selectedOptions?.[0]?.dataset?.provider;
      onsettings({ model, provider: picked || providerOfModel(model), autoModel: false });
    }}
    aria-label="Model"
    data-testid={inMenu ? 'more-model' : 'model'}
  >
    {#each offered as provider (provider)}
      <optgroup label={PROVIDER_LABELS[provider]}>
        {#each CATALOGUE[provider] as model (model)}<option value={model} data-provider={provider}>{model}</option>{/each}
      </optgroup>
    {/each}
    {#if settings.model && !offered.some((p) => CATALOGUE[p].includes(settings.model))}
      <optgroup label={PROVIDER_LABELS[settings.provider] || 'Other'}>
        <option value={settings.model}>{settings.model}</option>
      </optgroup>
    {/if}
  </select>

  {#if (settings.provider || providerOfModel(settings.model)) === 'direct'}
    {#if inMenu}<span class="label row-label" aria-hidden="true">auto</span>{/if}
    <button
      class="fast press focus-ring"
      class:on={settings.autoModel !== false}
      onclick={() => onsettings({ autoModel: settings.autoModel === false })}
      title="Auto model, by family: Opus for requests to build or fix or 'can u', Sonnet for questions, always the newest version of the family. Picking a model by hand turns this off."
      aria-pressed={settings.autoModel !== false}
      data-testid={inMenu ? 'more-auto-model' : 'auto-model'}
      data-auto={settings.autoModel === false ? 'off' : 'on'}
    >auto{settings.autoModel === false ? '' : ` · ${familyOf(settings.model) || ''} ${String(settings.model || '').replace(/^claude-[a-z]+-/, '').replace('-', '.')}`}</button>
  {/if}

  {#if capabilitiesOf(settings.provider || providerOfModel(settings.model)).reasoningEffort}
    {#if inMenu}<span class="label row-label" aria-hidden="true">effort</span>{/if}
    <select
      class="model focus-ring"
      value={settings.reasoningEffort || 'medium'}
      onchange={(event) => onsettings({ reasoningEffort: event.currentTarget.value })}
      aria-label="Reasoning effort"
      data-testid={inMenu ? 'more-effort' : 'effort'}
    >
      {#each REASONING_EFFORTS as effort (effort)}<option value={effort}>{effort}</option>{/each}
    </select>
  {/if}

  {#if inMenu}<span class="label row-label" aria-hidden="true">fast</span>{/if}
  <button
    class="fast press focus-ring"
    class:on={effectiveFastMode(settings)}
    class:kept={settings.fastMode && !fastModeAvailable(settings.model, settings.provider)}
    disabled={!fastModeAvailable(settings.model, settings.provider)}
    onclick={() => onsettings({ fastMode: !settings.fastMode })}
    title={fastModeAvailable(settings.model, settings.provider)
      ? 'Fast mode'
      : settings.fastMode
        ? 'Fast mode needs Opus on Claude; kept for when you switch back'
        : 'Fast mode needs Opus on Claude'}
    aria-pressed={effectiveFastMode(settings)}
    data-testid={inMenu ? 'more-fast' : 'fast'}
    data-fast={effectiveFastMode(settings) ? 'on' : settings.fastMode ? 'kept' : 'off'}
  >fast</button>
{/snippet}

<header bind:this={bar} class="bar" class:collapsed class:dim class:incognito data-testid="chat-toolbar" data-dim={dim ? 'true' : 'false'} data-incognito={incognito ? 'true' : 'false'}>
  <div class="head">
  {#if editing}
    <input
      class="title-edit focus-ring"
      bind:value={draft}
      onblur={commitTitle}
      onkeydown={(event) => { if (event.key === 'Enter') commitTitle(); if (event.key === 'Escape') editing = false; }}
      aria-label="Chat title"
    />
  {:else}
    <button
      class="title press focus-ring"
      data-testid="chat-title"
      ondblclick={() => { editing = true; draft = conversation?.title || ''; }}
      title={conversation?.title ? `${conversation.title}\nDouble-click to rename` : 'Double-click to rename'}
    >
      <span data-testid="chat-name">{conversation?.title || 'New chat'}</span>
      {#if forkCount}<span class="forks">{forkCount} fork{forkCount === 1 ? '' : 's'}</span>{/if}
    </button>
  {/if}

  {#if incognito}
    <span class="incognito-tag" data-testid="incognito-tag" title="Nothing from this chat is saved: not the transcript, not memory, not tasks. It is gone when you close it.">{INCOGNITO_LABEL}</span>
  {/if}
  </div>

  <div class="inline" bind:this={inlineEl} data-testid="chat-toolbar-inline">
    {@render settingsControls(false)}
    {#if conversation?.id && !incognito}
      <ShareLinks kind="chat" targetId={conversation.id} label="Share" />
    {/if}
    <button class="icon-btn press focus-ring" onclick={onfind} title="Find in chat (⌘F)" aria-label="Find in chat" data-testid="find"><Icon name="search" /></button>
    <button class="icon-btn press focus-ring" onclick={onfork} title="Fork this chat" aria-label="Fork" data-testid="fork"><Icon name="fork" /></button>
  </div>

  <button
    bind:this={moreBtn}
    class="icon-btn more-btn press focus-ring"
    class:on={moreOpen}
    onclick={toggleMore}
    title="Model, auto, effort, fast, share, find, fork"
    aria-label="Chat controls"
    aria-haspopup="dialog"
    aria-expanded={moreOpen}
    data-testid="chat-more"
    data-collapsed={collapsed ? 'true' : 'false'}
  ><Icon name="menu" /></button>

  <div class="ends" bind:this={endsEl}>
  {#if pane}
    <div class="panemenu">
      <button
        class="icon-btn press focus-ring"
        class:on={menuOpen}
        onclick={() => { if (soloDuplicate) onpane('duplicate'); else menuOpen = !menuOpen; }}
        title={soloDuplicate ? 'Duplicate this chat into a second pane' : 'Pane'}
        aria-label={soloDuplicate ? 'Duplicate pane' : 'Pane menu'}
        aria-haspopup={soloDuplicate ? undefined : 'menu'}
        aria-expanded={soloDuplicate ? undefined : menuOpen}
        data-testid="split"
      ><Icon name="split" /></button>
      {#if menuOpen && !soloDuplicate}
        <PaneMenu
          items={paneItems}
          onpick={(action) => { menuOpen = false; onpane(action); }}
          onclose={() => (menuOpen = false)}
        />
      {/if}
    </div>
  {/if}
  {#if onclosepane}
    <button class="icon-btn press focus-ring" onclick={onclosepane} title="Close this split" aria-label="Close split" data-testid="close-pane"><Icon name="close" /></button>
  {/if}
  </div>
</header>

{#if moreOpen && place}
  <div
    class="more"
    role="dialog"
    aria-label="Chat controls"
    tabindex="-1"
    bind:this={more}
    {@attach portal}
    onkeydown={menuKey}
    style:left="{place.left}px"
    style:width="{place.width}px"
    style:top={place.top === null ? null : `${place.top}px`}
    style:bottom={place.bottom === null ? null : `${place.bottom}px`}
    style:max-height="{place.maxHeight}px"
    data-testid="chat-more-menu"
    data-drop={place.drop}
  >
    <div class="grid">{@render settingsControls(true)}</div>
    <div class="sep"></div>
    {#if conversation?.id && !incognito}
      <div class="share-row"><ShareLinks kind="chat" targetId={conversation.id} label="Share" /></div>
    {/if}
    <button class="item press focus-ring" onclick={() => { closeMore(); onfind(); }} data-testid="more-find"><Icon name="search" /><span>Find in chat</span><kbd>⌘F</kbd></button>
    <button class="item press focus-ring" onclick={() => { closeMore(); onfork(); }} data-testid="more-fork"><Icon name="fork" /><span>Fork this chat</span></button>
  </div>
{/if}

<style>
  .bar {
    /* A size container: the queries below read this bar's own width, which is the pane's. */
    container: chatbar / inline-size;
    display: flex; align-items: center; gap: 6px;
    position: relative; z-index: 5;
    padding: 8px 12px;
    padding-top: max(8px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--line-soft);
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(12px);
    min-height: 46px;
    min-width: 0;
    transition: opacity var(--panel) var(--ease);
  }
  .bar.dim { opacity: 0.5; }
  .bar.incognito { background: color-mix(in srgb, var(--ink) 7%, var(--bg)); border-bottom-color: color-mix(in srgb, var(--ink) 18%, transparent); }
  /* The title side takes every spare pixel and is the only thing that gives way. */
  .head { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .incognito-tag {
    flex: none; font-size: 10.5px; color: var(--ink-dim); letter-spacing: 0.02em;
    border: 1px dashed color-mix(in srgb, var(--ink) 35%, transparent); border-radius: 999px; padding: 1px 8px;
  }
  .title {
    font-size: 13.5px; font-weight: 600;
    min-width: 0; max-width: 100%; overflow: hidden; white-space: nowrap;
    padding: 3px 6px; border-radius: 6px;
    display: flex; align-items: center; gap: 8px;
  }
  .title:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .title [data-testid='chat-name'] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .forks { flex: none; font-size: 10px; color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; font-weight: 400; }
  .title-edit {
    font-size: 13.5px; font-weight: 600;
    background: var(--bg-raised); border: 1px solid var(--accent); border-radius: 6px;
    padding: 3px 6px; color: var(--ink); outline: none; width: 100%; min-width: 0;
  }
  .inline { flex: none; display: flex; align-items: center; gap: 6px; }
  .ends { flex: none; display: flex; align-items: center; gap: 2px; }
  .panemenu { position: relative; display: flex; }
  .model {
    background: var(--bg-raised); border: 1px solid var(--line); border-radius: 7px;
    color: var(--ink-dim); font-size: 11.5px; padding: 3px 6px; outline: none;
  }
  .fast {
    border: 1px solid var(--line); border-radius: 7px;
    font-size: 11.5px; padding: 3px 9px; color: var(--ink-faint);
  }
  .fast.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-soft); }
  .fast:disabled { opacity: 0.4; cursor: default; }
  .fast.kept { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .icon-btn {
    flex: none;
    width: 28px; height: 28px; border-radius: 7px;
    display: grid; place-items: center; color: var(--ink-faint); font-size: 12px;
  }
  .icon-btn:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .icon-btn.on { color: var(--accent); background: var(--accent-soft); }
  .more-btn { display: none; }

  /* A narrow pane: settings and the secondary actions move behind the menu button, the title
     keeps the room. Pure CSS, so the switch lands in one frame with no measuring pass. */
  .bar.collapsed .inline { display: none; }
  .bar.collapsed .more-btn { display: grid; }
  /* The floor, for the frame before anything is measured: a pane this narrow always folds. */
  @container chatbar (max-width: 420px) {
    .inline { display: none; }
    .more-btn { display: grid; }
  }
  @container chatbar (max-width: 300px) {
    .forks { display: none; }
  }
  @media (max-width: 860px) {
    .bar { gap: 4px; padding-left: 8px; padding-right: 8px; }
  }

  /* The menu: fixed on <body>, placed by placeMenu so it is always inside the viewport,
     scrolling when taller than the room it has. */
  .more {
    position: fixed; z-index: 60;
    box-sizing: border-box;
    overflow-y: auto; overscroll-behavior: contain;
    background: var(--bg-raised); color: var(--ink);
    border: 1px solid var(--line); border-radius: 9px;
    padding: 8px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
    outline: none;
    display: flex; flex-direction: column; gap: 2px;
    animation: more-in var(--tap) var(--ease);
  }
  @keyframes more-in { from { opacity: 0; } }
  .grid {
    display: grid; grid-template-columns: max-content minmax(0, 1fr);
    align-items: center; column-gap: 10px; row-gap: 6px; padding: 2px 2px 4px;
  }
  .row { display: contents; }
  .ctl { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .label { font-size: 11px; color: var(--ink-faint); letter-spacing: 0.02em; }
  .grid .model { width: 100%; min-width: 0; text-overflow: ellipsis; padding: 4px 6px; }
  .grid .fast { justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 9px; }
  .grid :global(.scope) { flex: 1; min-width: 0; max-width: none; }
  .sep { height: 1px; background: var(--line-soft); margin: 4px 0; }
  .share-row { padding: 2px; }
  .share-row :global(.share) { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
  .share-row :global(.trigger) { align-self: flex-start; }
  /* Inside the menu the share panel opens in place, under its button, instead of floating. */
  .share-row :global(.panel) { position: static; width: auto; box-shadow: none; padding: 9px; }
  .item {
    display: flex; align-items: center; gap: 9px;
    text-align: left; padding: 6px 7px; border-radius: 6px;
    font-size: 12.5px; color: var(--ink);
  }
  .item:hover, .item:focus-visible { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  .item :global(svg) { color: var(--ink-faint); flex: none; }
  .item span { flex: 1; }
  kbd { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); }
</style>
