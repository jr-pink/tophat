// Test and replay support: the live rev5 memory.sqlite schema, read from the pre-migration backup
// (sqlite3 .schema, FTS shadow tables omitted). rev6 push never creates a store; tests need one.
export const SCHEMA = `
CREATE TABLE raw_data(
  id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL DEFAULT '',
  native_id TEXT NOT NULL, revision TEXT NOT NULL, role TEXT NOT NULL, author TEXT,
  participants TEXT NOT NULL DEFAULT '[]', thread TEXT, occurred_at TEXT NOT NULL,
  available_at TEXT NOT NULL, ingested_at TEXT NOT NULL, text TEXT NOT NULL,
  locator TEXT NOT NULL, policy TEXT NOT NULL, processed_batch TEXT REFERENCES batches(id), claimed_until TEXT,
  UNIQUE(source, account, native_id, revision));
CREATE INDEX raw_pending ON raw_data(processed_batch, available_at);
CREATE INDEX raw_thread ON raw_data(source, account, thread, occurred_at);
CREATE INDEX raw_author ON raw_data(source, author);
CREATE INDEX raw_pending_policy ON raw_data(processed_batch, json_extract(policy,'$.model'), occurred_at, available_at, claimed_until, source, account, native_id);
CREATE VIRTUAL TABLE raw_search USING fts5(id UNINDEXED, text);
CREATE TABLE entities(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'misc',
  aliases TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, merged_into TEXT REFERENCES entities(id), name_status TEXT NOT NULL DEFAULT 'unreviewed', name_problem TEXT);
CREATE TABLE identities(
  source TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', native TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id), created_at TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(source, account, native));
CREATE TABLE notes(
  id TEXT PRIMARY KEY, body TEXT NOT NULL, author TEXT NOT NULL, at TEXT,
  source_refs TEXT NOT NULL, note_refs TEXT NOT NULL DEFAULT '[]',
  batch_id TEXT NOT NULL REFERENCES batches(id), created_at TEXT NOT NULL);
CREATE TABLE note_entities(
  note_id TEXT NOT NULL REFERENCES notes(id), entity_id TEXT NOT NULL REFERENCES entities(id),
  PRIMARY KEY(note_id, entity_id));
CREATE TABLE work(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('todo','done','dropped')),
  source_refs TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_kind TEXT NOT NULL DEFAULT 'unknown', owner_ref TEXT, parent_id TEXT REFERENCES work(id), context_refs TEXT NOT NULL DEFAULT '[]', bindings TEXT NOT NULL DEFAULT '[]');
CREATE TABLE work_entities(
  work_id TEXT NOT NULL REFERENCES work(id), entity_id TEXT NOT NULL REFERENCES entities(id),
  PRIMARY KEY(work_id, entity_id));
CREATE TABLE pages(
  entity_id TEXT PRIMARY KEY REFERENCES entities(id), revision TEXT, nodes TEXT NOT NULL DEFAULT '[]',
  input_digest TEXT, as_of TEXT, generated_at TEXT, model TEXT,
  dirty INTEGER NOT NULL DEFAULT 1, touched_at TEXT NOT NULL, updated_at TEXT);
CREATE VIRTUAL TABLE mem_search USING fts5(kind UNINDEXED, id UNINDEXED, text);
CREATE TABLE batches(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, received_at TEXT NOT NULL,
  input_digest TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES batches(id),
  kind TEXT NOT NULL, target_id TEXT NOT NULL, op TEXT NOT NULL, before TEXT, after TEXT, at TEXT NOT NULL);
CREATE INDEX changes_target ON changes(kind, target_id, seq);
CREATE TABLE calls(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, purpose TEXT NOT NULL, model TEXT,
  ok INTEGER NOT NULL, reason TEXT, input_chars INTEGER, output_chars INTEGER, usage TEXT, at TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'steady');
CREATE TABLE mentions(
  id TEXT PRIMARY KEY, text TEXT NOT NULL, key TEXT NOT NULL,
  raw_id TEXT REFERENCES raw_data(id), source TEXT NOT NULL DEFAULT '', account TEXT NOT NULL DEFAULT '',
  thread TEXT, at TEXT NOT NULL, entity_id TEXT REFERENCES entities(id),
  method TEXT NOT NULL DEFAULT 'unresolved', considered TEXT NOT NULL DEFAULT '[]',
  batch_id TEXT REFERENCES batches(id), created_at TEXT NOT NULL, verbatim INTEGER NOT NULL DEFAULT 0);
CREATE INDEX mentions_key ON mentions(key, at);
CREATE INDEX mentions_entity ON mentions(entity_id, at);
CREATE INDEX mentions_thread ON mentions(source, account, thread, at);
CREATE INDEX mentions_raw ON mentions(raw_id);
CREATE INDEX identities_key ON identities(key);
CREATE INDEX entities_provisional ON entities(name_status, updated_at);
CREATE INDEX work_owner ON work(owner_kind, owner_ref, status);
CREATE INDEX calls_at_lane ON calls(at, lane);
CREATE TABLE wakes(
  key TEXT PRIMARY KEY, raw_id TEXT NOT NULL, work_id TEXT, conversation_id TEXT,
  group_key TEXT NOT NULL, action TEXT NOT NULL DEFAULT '', batch_id TEXT,
  decided_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, message_id TEXT, posted_at TEXT, detail TEXT, route TEXT);
CREATE INDEX wakes_pending ON wakes(status, decided_at);
`;
import { DatabaseSync } from 'node:sqlite';
/** A fresh, empty store with the live schema at `file` (tests and replay only). */
export function createTestStore(file) { const db = new DatabaseSync(file); db.exec(SCHEMA); db.close(); return file; }
