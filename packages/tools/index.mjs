// @tophat-md/tools: the memory as agent tools. A registry of tool definitions (name, description, JSON schema,
// handler(ctx, args)) bound to a MemoryStore (any backend), plus an MCP stdio server (bin/tophat-mcp.mjs) so an agent
// harness can mount them. Register more: registerTool({ name, description, inputSchema, handler }).
const TOOLS = new Map();
export function registerTool(t) { if (!t?.name || typeof t.handler !== 'function') throw new Error('tool needs name and handler'); TOOLS.set(t.name, t); }
export function listTools() { return [...TOOLS.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })); }
export async function callTool(ctx, name, args = {}) {
  const t = TOOLS.get(name);
  if (!t) throw new Error(`unknown tool ${name}`);
  for (const k of t.inputSchema.required || []) if (args[k] === undefined) throw new Error(`${name}: missing ${k}`);
  return t.handler(ctx, args);
}
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const scopes = { type: 'array', items: { type: 'string' }, description: 'scopes (groups) that may read the new rows; default: your write scopes' };

registerTool({ name: 'memory_search', description: 'Full-text search over your memory (entities, notes, work, raw records) across every scope you can read.',
  inputSchema: S({ query: { type: 'string' }, kind: { type: 'string', enum: ['raw', 'entity', 'note', 'work', 'page'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['query']),
  handler: ({ store }, a) => store.search(a.query, { kind: a.kind, limit: a.limit ?? 20 }) });
registerTool({ name: 'memory_entity', description: 'One entity with every note you can read about it (linked entities merged).',
  inputSchema: S({ id: { type: 'string' } }, ['id']), handler: ({ store }, a) => store.entity(a.id) });
registerTool({ name: 'memory_page', description: 'The derived page for an entity, built from every note you can read across your scopes.',
  inputSchema: S({ id: { type: 'string' } }, ['id']), handler: async ({ store }, a) => { const p = await store.page(a.id); return { entity_id: p.entity_id, outline: p.outline, notes: p.note_ids.length, cached: p.cached }; } });
registerTool({ name: 'memory_read', description: 'Read one row by kind and id.',
  inputSchema: S({ kind: { type: 'string', enum: ['entity', 'note', 'work', 'raw'] }, id: { type: 'string' } }, ['kind', 'id']), handler: ({ store }, a) => store.read(a.kind, a.id) });
registerTool({ name: 'memory_apply', description: 'Write entities, notes (append-only, each attached to at least one entity) and work items. Use "$name" ids for new entities in the same call.',
  inputSchema: S({ entities: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'object' } }, work: { type: 'array', items: { type: 'object' } }, scopes }),
  handler: ({ store }, a) => store.apply({ entities: a.entities, notes: a.notes, work: a.work }, { scopes: a.scopes }) });
registerTool({ name: 'memory_share', description: 'Set the scopes that may read one row (widen or narrow).',
  inputSchema: S({ kind: { type: 'string', enum: ['entity', 'note', 'work', 'raw'] }, id: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } }, ['kind', 'id', 'scopes']),
  handler: ({ store }, a) => store.share(a.kind, a.id, a.scopes) });
registerTool({ name: 'memory_scopes', description: 'The scopes you belong to and your role in each.', inputSchema: S({}), handler: ({ store }) => store.scopes() });
