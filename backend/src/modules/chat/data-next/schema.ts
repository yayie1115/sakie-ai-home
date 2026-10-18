import { migrations, type Migration, migrate, schemaVersion } from '../../../database/migrations.js';
import type { DatabaseSync } from 'node:sqlite';
import { assertData01Database } from './guard.js';
/** Synthetic-only extension. Official migration list and v4 protocol remain unchanged. */
export const data01Migration: Migration = { version: 5, name: 'chat-data01-synthetic-candidate', sql: `
CREATE TABLE chat_bubbles (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
 turn_id TEXT NOT NULL REFERENCES chat_turns(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 position INTEGER NOT NULL CHECK(position>=0), revision INTEGER NOT NULL CHECK(revision>=1),
 active_version_id TEXT NOT NULL REFERENCES chat_bubble_versions(id) DEFERRABLE INITIALLY DEFERRED,
 created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 UNIQUE(turn_id,role,position)
) STRICT;
CREATE TABLE chat_bubble_versions (
 id TEXT PRIMARY KEY, bubble_id TEXT NOT NULL REFERENCES chat_bubbles(id) DEFERRABLE INITIALLY DEFERRED,
 ordinal INTEGER NOT NULL CHECK(ordinal>=1), content TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('original','edit','regeneration','legacy')),
 created_at TEXT NOT NULL, UNIQUE(bubble_id,ordinal)
) STRICT;
CREATE TABLE chat_bubble_states (bubble_id TEXT NOT NULL REFERENCES chat_bubbles(id), revision INTEGER NOT NULL, version_id TEXT NOT NULL REFERENCES chat_bubble_versions(id), PRIMARY KEY(bubble_id,revision)) STRICT;
CREATE TABLE chat_bubble_quotes (
 bubble_id TEXT PRIMARY KEY REFERENCES chat_bubbles(id), conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
 target_bubble_id TEXT NOT NULL REFERENCES chat_bubbles(id), target_version_id TEXT NOT NULL REFERENCES chat_bubble_versions(id),
 target_revision INTEGER NOT NULL, selected_text TEXT NOT NULL
) STRICT;
CREATE TABLE chat_bubble_operations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL) STRICT;
CREATE TABLE chat_bubble_jobs (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id), kind TEXT NOT NULL CHECK(kind IN ('reply','regeneration')),
 request_hash TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','unknown','failed')),
 result_hash TEXT, error_code TEXT
) STRICT;
CREATE UNIQUE INDEX chat_bubble_one_active_job ON chat_bubble_jobs(turn_id) WHERE status IN ('queued','running','unknown');
CREATE TABLE chat_bubble_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 payload TEXT NOT NULL, payload_hash TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived=0)
) STRICT;
CREATE TABLE chat_tool_events (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id), tool_name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('requested','succeeded','failed','unknown')), detail TEXT NOT NULL
) STRICT;
-- Only known legacy revisions are retained; v4 never stored intervening edits.
INSERT INTO chat_bubbles SELECT m.id,m.conversation_id,m.turn_id,m.role,0,COALESCE(s.revision,1),
 CASE WHEN s.message_id IS NULL THEN m.id||':legacy:1' ELSE m.id||':legacy:'||s.revision END,m.created_at,
 CASE WHEN s.deleted_at IS NULL THEN 0 ELSE 1 END FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id;
INSERT INTO chat_bubble_versions SELECT id||':legacy:1',id,1,content,'legacy',created_at FROM chat_messages;
INSERT INTO chat_bubble_versions SELECT m.id||':legacy:'||s.revision,m.id,s.revision,s.content,'legacy',m.created_at
 FROM chat_messages m JOIN chat_message_state s ON s.message_id=m.id;
INSERT INTO chat_bubble_states SELECT id,revision,active_version_id FROM chat_bubbles;
-- A candidate-only database must not mix normalized admissions with legacy odd/even writers.
-- The original v4 schema/protocol is unchanged outside this explicitly opted-in fixture.
CREATE TRIGGER data01_block_legacy_insert BEFORE INSERT ON chat_messages BEGIN SELECT RAISE(ABORT,'CANDIDATE_LEGACY_WRITER_BLOCKED'); END;
CREATE TRIGGER data01_block_legacy_state_insert BEFORE INSERT ON chat_message_state BEGIN SELECT RAISE(ABORT,'CANDIDATE_LEGACY_WRITER_BLOCKED'); END;
CREATE TRIGGER data01_block_legacy_state_update BEFORE UPDATE ON chat_message_state BEGIN SELECT RAISE(ABORT,'CANDIDATE_LEGACY_WRITER_BLOCKED'); END;
CREATE TRIGGER data01_block_legacy_state_delete BEFORE DELETE ON chat_message_state BEGIN SELECT RAISE(ABORT,'CANDIDATE_LEGACY_WRITER_BLOCKED'); END;

` };
export const data01Migrations: readonly Migration[] = [...migrations, data01Migration];
export function migrateSyntheticChatData(db: DatabaseSync) { assertData01Database(db); migrate(db, data01Migrations, { beforeApply() {
        if (schemaVersion(db) === 4 && db.prepare("SELECT 1 FROM chat_turns WHERE status!='succeeded' LIMIT 1").get())
            throw Error('LEGACY_UNRESOLVED_TURN');
    } }); }
