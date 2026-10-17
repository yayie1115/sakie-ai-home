/** Additive v3 schema. Raw messages and outbox have no automatic retention policy. */
export const chatSchema = `
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
  next_turn_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_turn_seq >= 1)
) STRICT;
CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  client_message_id TEXT NOT NULL, content_hash TEXT NOT NULL, turn_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown')),
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(conversation_id,client_message_id), UNIQUE(conversation_id,turn_seq)
) STRICT;
CREATE UNIQUE INDEX chat_one_unresolved_turn ON chat_turns(conversation_id) WHERE status != 'succeeded';
CREATE INDEX chat_pending_turns ON chat_turns(status,created_at);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  turn_id TEXT NOT NULL REFERENCES chat_turns(id), message_seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(conversation_id,message_seq), UNIQUE(turn_id,role)
) STRICT;
CREATE TABLE chat_attempts (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id),
  provider TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown')),
  started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cache_miss_tokens INTEGER,
  currency TEXT, cost_micros INTEGER, price_version TEXT, provider_request_id TEXT
) STRICT;
CREATE INDEX chat_attempts_turn ON chat_attempts(turn_id,started_at);
CREATE TABLE chat_retry_requests (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE chat_archive_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), producer_id TEXT NOT NULL) STRICT;
CREATE TABLE chat_outbox (
  stream_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  producer_id TEXT NOT NULL, producer_seq INTEGER NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1),
  kind TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(producer_id,producer_seq)
) STRICT;
`;
