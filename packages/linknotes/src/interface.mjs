// The MemoryStore interface: one shape over a replica. The shipped backend is sqlite: a local SQLite replica, end-to-end
// encrypted, that optionally syncs through a hub which stores and relays ciphertext only (it never holds a scope key).
// Every method is async, so a caller (the push plane, the CLI, an agent) depends on the interface, never on the backend;
// registerBackend() adds another. A scope is a group: a set of users with roles read < write < admin.
//
// Types (JSDoc; the README carries the same table):
/**
 * @typedef {string} Scope            group id, /^[a-z][a-z0-9-]{1,47}$/
 * @typedef {'read'|'write'|'admin'|'none'} Role
 * @typedef {{ id: string, name: string, type?: string, aliases?: string[], scopes?: Scope[], merge_into?: string }} EntityChange
 *   id: '$temp' to create (the result's id_map gives the stable id) or an existing id to update.
 * @typedef {{ body: string, entities?: string[], at?: string, author?: string, scopes?: Scope[], source_refs?: string[] }} NoteChange
 *   Notes are append-only. entities: ids, '$temp' refs from the same batch, or exact names.
 * @typedef {{ id: string, title?: string, body?: string, status?: 'todo'|'done'|'dropped', scopes?: Scope[], entities?: string[] }} WorkChange
 * @typedef {{ entities?: EntityChange[], notes?: NoteChange[], work?: WorkChange[] }} Changes
 * @typedef {{ id: string, source: string, text: string, time: string, author?: string, participants?: string[], thread?: string,
 *   account?: string, revision?: string, role?: 'owner'|'human'|'assistant'|'tool'|'system', locator?: object }} RawRecord
 *   The unit every source adapter produces (id unique within source; revision changes when the record does).
 * @typedef {{ entity_id: string, key: string|null, cached: boolean, note_ids: string[], cnf: Scope[][], nodes: object[], outline: string }} Page
 *   A derived page: built from every note the viewer can read across all scopes they hold (linked entities merged),
 *   cached under sha256(prompt version, visible note ids); cnf is the AND of the notes' scope sets: a reader must
 *   satisfy every clause, so the cached page is never served to someone missing any note it was built from.
 */

/**
 * @interface MemoryStore
 * whoami(): Promise<{ user, device, backend, writeScopes }>
 * apply(changes: Changes, opts?: { scopes?: Scope[], batchId?: string, sourceRefs?: string[], ackRaw?: string[] }): Promise<ApplyResult>
 *   Write entities, notes and work. opts.scopes: the scopes of every new row that names none (default: writeScopes).
 *   Notes cite raw data; with no sourceRefs the call itself is recorded as one raw record (source 'linknotes-apply').
 * ingest(records: RawRecord[], opts?: { scopes?: Scope[], pusher?: string }): Promise<{ stored: string[], duplicates: string[], rejected: object[] }>
 * pending(opts: { pusher: string, limit?: number }): Promise<object[]>   raw rows this pusher ingested and nothing derived from yet
 * search(query: string, opts?: { limit?: number, kind?: 'raw'|'entity'|'note'|'work'|'page' }): Promise<{ hits: object[] }>
 * read(kind: 'entity'|'note'|'work'|'raw', id: string): Promise<object>
 * entity(id: string): Promise<{ entity, notes, work }>    the entity with every note the viewer can read (linked ids merged)
 * page(entityId: string): Promise<Page>
 * putPageNode(record: object, opts?: { scopes?: Scope[], publicKey?: string }): Promise<{ id, scopes, audience, op }>
 *   Store one signed PageNode record (a derived page node, @tophat-md/groups): replicated like a note, never a note and
 *   never evidence. Its audience is the scopes holding every note it cites; opts.scopes must lie inside that audience
 *   (a page node never widens access), and defaults to the writable part of it.
 * pageNodes(opts: { entity: string, key?: string, scopes?: Scope[] }): Promise<{ id, record, scopes }[]>
 *   The page nodes of one entity this viewer reads (it holds a scope of the node's audience and reads every cited
 *   note), oldest clock first.
 * share(kind: 'note'|'entity'|'work'|'raw', id: string, scopes: Scope[]): Promise<object>   set who can read one row (widen or narrow)
 * retract(kind, id): Promise<object>   take a row out of every scope (it stays in the append-only log)
 * link(a: string, b: string, linked?: boolean): Promise<object>   two entity ids are one thing for reads (reversible)
 * scopes(): Promise<{ scope: Scope, role: Role }[]>
 * createScope(scope: Scope): Promise<object>      the creator is its admin
 * addMember(scope: Scope, user: string, role: Role): Promise<object>   role 'none' removes (and rotates the scope key)
 * sync(): Promise<{ pushed, pulled, cursor }>     push and pull ciphertext with the hub, then wrap scope keys to new member devices
 * close(): Promise<void>
 */
export const METHODS = ['whoami', 'apply', 'ingest', 'pending', 'search', 'read', 'entity', 'page', 'putPageNode', 'pageNodes', 'share', 'retract', 'link', 'scopes', 'createScope', 'addMember', 'sync'];
export const KINDS = ['entity', 'note', 'work', 'raw'];
