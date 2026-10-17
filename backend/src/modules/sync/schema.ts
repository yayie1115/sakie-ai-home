/** Additive v4: no raw-message rewrite, no cleanup or ACK inference. */
export const syncSchema = `
CREATE TABLE sync_pairings (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER) STRICT;
CREATE TABLE sync_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, archive_id TEXT NOT NULL, restore_generation TEXT NOT NULL,
 created_at TEXT NOT NULL, revoked_at TEXT, ack_seq INTEGER NOT NULL DEFAULT 0, delivered_seq INTEGER NOT NULL DEFAULT 0,
 ack_event_id TEXT, ack_payload_hash TEXT,
 CHECK(ack_seq>=0 AND delivered_seq>=ack_seq)
) STRICT;
CREATE UNIQUE INDEX sync_one_active_archive ON sync_devices(archive_id) WHERE revoked_at IS NULL;
CREATE TABLE sync_mutations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
CREATE TABLE sync_record_events (resource TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, PRIMARY KEY(resource,record_id,revision)) STRICT;
CREATE TABLE chat_message_state (
 message_id TEXT PRIMARY KEY REFERENCES chat_messages(id), revision INTEGER NOT NULL CHECK(revision>=2),
 content TEXT NOT NULL, deleted_at TEXT
) STRICT;
`;
