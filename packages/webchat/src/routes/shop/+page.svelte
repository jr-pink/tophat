<script>
  // Shop: a query box and a grid of real product cards.
  //
  // Every picture, price and link on this page came off a retailer's own search page a moment
  // ago. There are no placeholders: a card that could not get its image says so in the space the
  // image would have filled, and a card whose price could not be read says that instead of
  // printing a number nobody wrote. The line under the box says how many the sources put up and
  // how many are shown, so a capped grid does not read as a short one.
  //
  // Nothing here buys anything. Every link opens the retailer's page in a new tab and that is the
  // end of what this page does.

  import { onMount } from 'svelte';
  import Nav from '$lib/ui/Nav.svelte';

  let query = $state('');
  let asked = $state('');            // the query the results on screen belong to
  let data = $state(null);
  let loading = $state(false);
  let error = $state(null);
  let broken = $state(new Set());    // images the browser could not load

  async function run(text, { refresh = false } = {}) {
    const q = String(text || '').trim();
    if (!q || loading) return;
    loading = true;
    error = null;
    asked = q;
    broken = new Set();
    try {
      const url = `/api/shop?q=${encodeURIComponent(q)}${refresh ? '&refresh=1' : ''}`;
      const response = await fetch(url);
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `the search failed (${response.status})`);
      data = body;
      const next = new URL(location.href);
      next.searchParams.set('q', q);
      history.replaceState(history.state, '', next);
    } catch (cause) {
      error = cause.message;
      data = null;
    } finally {
      loading = false;
    }
  }

  function imageFailed(id) {
    const next = new Set(broken);
    next.add(id);
    broken = next;
  }

  const priceOf = (item) => (item.price ? item.price.text : null);

  onMount(() => {
    const q = new URLSearchParams(location.search).get('q');
    if (q) { query = q; run(q); }
  });
</script>

<svelte:head><title>{asked ? `${asked} — shop` : 'Shop'}</title></svelte:head>

<div class="shop">
  <header>
    <Nav current="shop" />
    <form
      class="box"
      onsubmit={(event) => { event.preventDefault(); run(query); }}
    >
      <input
        type="search"
        bind:value={query}
        placeholder="what are you looking for"
        aria-label="Search for a product"
        data-testid="shop-query"
        autocomplete="off"
      />
      <button class="go press focus-ring" type="submit" disabled={loading || !query.trim()}>
        {loading ? 'looking…' : 'search'}
      </button>
    </form>
  </header>

  {#if error}
    <p class="bad" role="alert">{error}</p>
  {/if}

  {#if loading && !data}
    <p class="quiet">reading the retailers’ search pages…</p>
  {/if}

  {#if data}
    <div class="ledger">
      <p class="count" data-testid="shop-count">
        {#if data.shown === 0}
          nothing found for “{data.query}”
        {:else if data.found > data.shown}
          showing {data.shown} of {data.found} found
        {:else}
          {data.shown} found
        {/if}
        {#if data.shown > data.complete}
          · {data.shown - data.complete} of them incomplete
        {/if}
        {#if data.cached}
          · from the cache{#if Number.isFinite(data.ageMs)}, {Math.round(data.ageMs / 60000)} min old{/if}
        {/if}
      </p>
      <button class="refetch press focus-ring" type="button" onclick={() => run(asked, { refresh: true })} disabled={loading}>
        re-read prices
      </button>
    </div>

    {#each data.notes as note (note)}
      <p class="note">{note}</p>
    {/each}

    <ul class="grid" data-testid="shop-grid">
      {#each data.results as item (item.id)}
        <li class="card" class:gappy={!item.image || !item.price || !item.url}>
          <div class="shot">
            {#if item.image && !broken.has(item.id)}
              <img
                src={item.image}
                alt={item.title}
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror={() => imageFailed(item.id)}
              />
            {:else}
              <span class="missing">{item.image ? 'image would not load' : 'no image on the listing'}</span>
            {/if}
          </div>
          <div class="body">
            <p class="title">{item.title}</p>
            <p class="line">
              {#if priceOf(item)}
                <span class="price">{priceOf(item)}</span>
              {:else}
                <span class="missing-price">price not shown by the source</span>
              {/if}
              <span class="where">{item.retailer || 'unknown retailer'}</span>
              {#if item.sponsored}<span class="tag">sponsored</span>{/if}
            </p>
            {#if item.url}
              <a class="open focus-ring" href={item.url} target="_blank" rel="noopener noreferrer">open the listing ↗</a>
            {:else}
              <span class="missing-link">no link could be read for this one</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if data.sources.length}
      <p class="sources">
        {#each data.sources as source, i (source.url)}{i ? ' · ' : ''}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>: {source.ok ? `${source.found} tiles, ${source.used} read` : `unreachable (${source.status || 'no response'})`}{/each}
      </p>
    {/if}
  {/if}
</div>

<style>
  .shop {
    min-height: 100dvh;
    padding: 14px var(--column-gutter) 60px;
    font-family: var(--sans);
    color: var(--ink);
    background: var(--bg);
  }
  header { display: flex; flex-direction: column; gap: 14px; margin-bottom: 18px; }
  .box { display: flex; gap: 8px; }
  input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 16px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--ink);
  }
  input:focus { outline: none; border-color: var(--accent); }
  .go, .refetch {
    font: inherit;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg-raised);
    color: var(--ink);
    padding: 10px 16px;
    cursor: pointer;
  }
  .go:disabled, .refetch:disabled { opacity: 0.5; cursor: default; }
  .refetch { padding: 4px 10px; font-size: 13px; color: var(--ink-dim); }

  .ledger { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .count { font-size: 13px; color: var(--ink-dim); margin: 0; }
  .note { font-size: 13px; color: var(--accent); margin: 6px 0 0; }
  .quiet { font-size: 14px; color: var(--ink-faint); }
  .bad { font-size: 14px; color: var(--warn); }

  .grid {
    list-style: none;
    margin: 18px 0 0;
    padding: 0;
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  }
  .card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    background: var(--bg-raised);
    overflow: hidden;
  }
  .card.gappy { border-style: dashed; border-color: var(--line); }
  .shot {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    background: var(--bg-sunken);
    padding: 10px;
  }
  .shot img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .missing { font-size: 12px; color: var(--ink-faint); text-align: center; padding: 0 10px; }
  .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .title {
    margin: 0;
    font-size: 13px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .line { margin: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
  .price { font-size: 16px; font-weight: 600; }
  .missing-price { color: var(--warn); }
  .where { color: var(--ink-dim); }
  .tag { color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; font-size: 10px; }
  .open { font-size: 13px; color: var(--accent); text-decoration: none; }
  .open:hover { text-decoration: underline; }
  .missing-link { font-size: 12px; color: var(--warn); }
  .sources { margin-top: 24px; font-size: 12px; color: var(--ink-faint); }
  .sources a { color: inherit; }
</style>
