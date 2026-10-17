export const archiveSchema = `
CREATE TABLE archive_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),archive_id TEXT NOT NULL,restore_generation TEXT NOT NULL,restore_marker TEXT,stream_id TEXT) STRICT;
CREATE TABLE archive_events(stream_seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,producer_id TEXT NOT NULL,producer_seq INTEGER NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,UNIQUE(producer_id,producer_seq)) STRICT;
CREATE TABLE archive_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,message_seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(conversation_id,message_seq)) STRICT;
CREATE TABLE archive_message_state(message_id TEXT PRIMARY KEY REFERENCES archive_messages(id),revision INTEGER NOT NULL,content TEXT NOT NULL,deleted_at TEXT) STRICT;
CREATE TABLE archive_records(resource TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,deleted_at TEXT,PRIMARY KEY(resource,id)) STRICT;
CREATE TABLE archive_record_versions(resource TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(resource,id,revision)) STRICT;
CREATE TABLE archive_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seq INTEGER NOT NULL DEFAULT 0,event_id TEXT,payload_hash TEXT) STRICT;
INSERT INTO archive_cursor(singleton) VALUES (1);
CREATE TABLE archive_retry(singleton INTEGER PRIMARY KEY CHECK(singleton=1),failures INTEGER NOT NULL,next_retry_at INTEGER NOT NULL,phase TEXT NOT NULL,last_error TEXT) STRICT;
INSERT INTO archive_retry VALUES (1,0,0,'offline',NULL);
CREATE TABLE archive_conflicts(evidence_hash TEXT PRIMARY KEY,code TEXT NOT NULL,evidence TEXT NOT NULL,recorded_at TEXT NOT NULL) STRICT;
CREATE TABLE archive_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT;
`;
