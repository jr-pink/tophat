// The app's one context menu, open or not, on the docstore kit core. Plain data only: where it opened, what was
// right-clicked (`ctx`, from the target's data-ctx attributes, kit lib/menu.js contextOf) and the highlighted path. The
// items are computed from ctx by the providers (client/context-menu.js), never stored. scope ephemeral: a reload closes
// it.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { field, on } from '../../../../runner/tools/docstore-kit/lib/schema.js';

const plainCtx = (c) => (c && typeof c === 'object' && typeof c.kind === 'string'
  ? Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string').slice(0, 16)) : null);
const path = (a) => (Array.isArray(a) && a.length <= 8 && a.every((i) => Number.isInteger(i) && i >= 0 && i < 500) ? a : null);
const cleanOpen = (o) => {
  if (!o || typeof o !== 'object') return null;
  const ctx = plainCtx(o.ctx), x = Number(o.x), y = Number(o.y);
  if (!ctx || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { id: typeof o.id === 'string' ? o.id : '', x: Math.round(x), y: Math.round(y), ctx, active: path(o.active) ?? [] };
};

export const menuDecl = declare({
  name: 'contextmenu',
  scope: 'ephemeral',
  fields: { open: field(null, cleanOpen) },
  actions: {
    // Absolute: this menu (id minted by the opener), at this point, for this target. A repeat is the same state.
    'menu.open': on('open', (cur, p) => { const next = cleanOpen({ ...p, active: [] }); if (!next) return cur; return cur && cur.id === next.id ? cur : next; }),
    // The highlighted path in the menu `id` (ignored once that menu is gone or another opened).
    'menu.active': on('open', (cur, { id, active } = {}) => { const a = path(active); if (!cur || cur.id !== id || !a || a.join() === cur.active.join()) return cur; return { ...cur, active: a }; }),
    'menu.close': on('open', (cur, { id } = {}) => (cur && (id === undefined || cur.id === id) ? null : cur))
  }
});
