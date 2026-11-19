<script>
  // The app-wide right-click. One listener: the kit's contextOf finds the target (data-ctx and data-ctx-* attributes);
  // text fields, editable text, data-ctx="native" and Shift+right-click keep the browser's menu (spellcheck, paste,
  // inspect). The items come from the providers (client/context-menu.js); the open menu is kit state
  // (core/menu-state.js); the kit draws it.
  import ContextMenu from '../../../../runner/tools/docstore-kit/ui/ContextMenu.svelte';
  import { contextOf } from '../../../../runner/tools/docstore-kit/lib/menu.js';
  import { ulid } from '../../../../runner/tools/docstore-kit/lib/engine/ulid.js';
  import { menuDecl } from '$lib/core/menu-state.js';
  import { menuItems, provideMenu, tidy, SEP } from '$lib/client/context-menu.js';
  import { uiApp } from '$lib/client/ui-app.js';

  const menu = uiApp().use(menuDecl);
  const open = $derived($menu.open);
  // Items are recomputed when the menu opens (providers read live state), kept for as long as that menu is open.
  let items = $state([]);
  let extra = null;

  function oncontext(event) {
    const ctx = contextOf(event.target, { shiftKey: event.shiftKey });
    if (!ctx) return;
    const sel = String(globalThis.getSelection?.() || '');
    const link = event.target?.closest?.('a[href]');
    const img = event.target?.closest?.('img[src]');
    extra = { selection: sel, href: link?.href || null, src: img?.src || null, target: event.target };
    const list = tidy(menuItems(ctx, extra));
    if (!list.length) return;
    event.preventDefault();
    items = list;
    menu.dispatch('menu.open', { id: ulid(), x: event.clientX, y: event.clientY, ctx });
  }
  $effect(() => {
    globalThis.addEventListener('contextmenu', oncontext);
    return () => globalThis.removeEventListener('contextmenu', oncontext);
  });

  // The fallback for anything without its own menu: what the browser's would offer that matters here.
  $effect(() => provideMenu('app', (_ctx, x) => [
    x.src && { id: 'copy-image-data', label: 'Copy Image', run: () => copyImage(x.src) },
    x.selection && { id: 'copy', label: 'Copy', keys: '⌘C', run: () => navigator.clipboard?.writeText(x.selection) },
    x.href && { id: 'open-link', label: 'Open Link in New Tab', run: () => globalThis.open(x.href, '_blank', 'noopener') },
    x.href && { id: 'copy-link', label: 'Copy Link Address', run: () => navigator.clipboard?.writeText(x.href) },
    x.src && { id: 'open-image', label: 'Open Image in New Tab', run: () => globalThis.open(x.src, '_blank', 'noopener') },
    x.src && { id: 'copy-image', label: 'Copy Image Address', run: () => navigator.clipboard?.writeText(x.src) },
    SEP,
    { id: 'back', label: 'Back', keys: '⌘[', run: () => history.back() },
    { id: 'reload', label: 'Reload', keys: '⌘R', run: () => location.reload() }
  ]));

  // Copy the image itself (PNG on the clipboard; the clipboard API takes only PNG, so other types are redrawn through a canvas).
  // The blob is passed as a promise so Safari keeps the user-gesture.
  function copyImage(src) {
    const png = (async () => {
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      if (blob.type === 'image/png') return blob;
      const bitmap = await createImageBitmap(blob);
      const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error('toBlob failed'))), 'image/png'));
    })();
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      .catch((cause) => console.error('[context-menu] copy image', cause));
  }

  function run(item) {
    const id = open?.id;
    menu.dispatch('menu.close', { id });
    items = [];
    try { item.run?.(); } catch (cause) { console.error('[context-menu]', cause); }
  }
</script>

{#if open && items.length}
  <ContextMenu {items} x={open.x} y={open.y} active={open.active}
    onactive={(active) => menu.dispatch('menu.active', { id: open.id, active })}
    onrun={run}
    onclose={() => { menu.dispatch('menu.close', { id: open.id }); items = []; }} />
{/if}
