// Who answers a right-click: providers by target kind (the element's data-ctx), each `(ctx, event) => items` with the
// item model of the kit's lib/menu.js plus `run()`. Functions live here, in a registry, never in state; the open menu is
// core/menu-state.js. A kind with no provider falls to 'app' (copy, links, reload).
const providers = new Map();

/** Register a provider for a kind; returns the unregister function (call it on unmount). */
export function provideMenu(kind, fn) {
  providers.set(kind, fn);
  return () => { if (providers.get(kind) === fn) providers.delete(kind); };
}

/** The items for a context, or [] when nobody answers. */
export function menuItems(ctx, extra = {}) {
  const fn = providers.get(ctx?.kind) || providers.get('app');
  try { return (fn?.(ctx, extra) || []).filter(Boolean); } catch (cause) { console.error('[context-menu]', cause); return []; }
}

/** Drops separators at the ends and doubled ones, so a provider can build its list with conditional groups. */
export function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
    out.push(it.children ? { ...it, children: tidy(it.children) } : it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

export const SEP = { separator: true };
