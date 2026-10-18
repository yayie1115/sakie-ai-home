/** Synthetic extension only: neither 5 nor 6 allocates a production migration number. */
import type { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../../database/migrations.js';
import { data01Migrations, migrateSyntheticChatData } from './schema.js';
import { assertData01Database } from './guard.js';
export const opsMigrations = [...data01Migrations, { version: 6, name: 'chat-ops02-synthetic-only', sql: `
CREATE TABLE chat_generation_attempts (
 job_id TEXT NOT NULL REFERENCES chat_bubble_jobs(id), attempt INTEGER NOT NULL CHECK(attempt>=1),
 PRIMARY KEY(job_id,attempt)
) STRICT;
CREATE TRIGGER ops_start_attempt AFTER UPDATE OF status ON chat_bubble_jobs
 WHEN OLD.status='queued' AND NEW.status='running' BEGIN
 INSERT INTO chat_generation_attempts SELECT NEW.id,COALESCE(MAX(attempt),0)+1 FROM chat_generation_attempts WHERE job_id=NEW.id;
END;
CREATE TABLE chat_generation_targets (
 job_id TEXT NOT NULL REFERENCES chat_bubble_jobs(id), bubble_id TEXT NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(job_id,bubble_id), UNIQUE(job_id,position)
) STRICT;
CREATE TABLE chat_generation_chunks (
 job_id TEXT NOT NULL, attempt INTEGER NOT NULL, seq INTEGER NOT NULL, bubble_id TEXT NOT NULL, content TEXT NOT NULL,
 PRIMARY KEY(job_id,attempt,seq), FOREIGN KEY(job_id,attempt) REFERENCES chat_generation_attempts(job_id,attempt)
) STRICT;
` }] as const;
export function migrateSyntheticOps(db: DatabaseSync) {
    assertData01Database(db);
    // Preserve DATA-01 checks (including unresolved legacy turn refusal) before extending a new fixture.
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version < 5)
        migrateSyntheticChatData(db);
    migrate(db, opsMigrations);
}
