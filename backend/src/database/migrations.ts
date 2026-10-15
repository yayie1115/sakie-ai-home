import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { legacySchema } from './legacy-schema.js';
export interface Migration { version: number; name: string; sql: string; }
export const migrations: readonly Migration[] = [
  { version: 1, name: 'original-business-tables', sql: legacySchema },
  { version: 2, name: 'phase1-auth-and-record-boundaries', sql: [
    'CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, credential_version TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;',
    'CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);',
    "CREATE TABLE record_metadata (resource TEXT NOT NULL CHECK(resource IN ('memories','diaries','dreams','activities')), record_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), provenance_status TEXT NOT NULL CHECK(provenance_status IN ('legacy_unverified','user_recorded')), deleted_at TEXT, PRIMARY KEY(resource, record_id)) STRICT;",
    ...['memories','diaries','dreams','activities'].map(table => "INSERT INTO record_metadata(resource,record_id,revision,provenance_status) SELECT '" + table + "',id,1,'legacy_unverified' FROM " + table + ';'),
  ].join('\n') },
];
export const latestVersion = 2;
export const schemaVersion = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const checksum = (m: Migration) => createHash('sha256').update(m.sql).digest('hex');
export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations, options: { afterStep?: (version: number) => void; beforeApply?: () => void } = {}) {
  for (let i = 0; i < steps.length; i++) if (steps[i].version !== i + 1) throw new Error('Migration versions must be contiguous');
  if (schemaVersion(db) > steps.length) throw new Error('Database schema is newer than this application');
  db.exec('BEGIN IMMEDIATE');
  try {
    options.beforeApply?.();
    const current = schemaVersion(db);
    const ledgerExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations' AND type='table'").get();
    if (!ledgerExists && current > 1) throw new Error('Migration ledger is missing');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const entries = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all() as { version: number; name: string; checksum: string }[];
    if (ledgerExists && (entries.length !== current || entries.some((entry, index) => entry.version !== index + 1))) throw new Error('Migration ledger does not match schema version');
    for (const entry of entries) {
      const expected = steps[entry.version - 1];
      if (!expected || entry.name !== expected.name || entry.checksum !== checksum(expected)) throw new Error('Migration checksum mismatch');
    }
    // The original v1 application has no ledger; register its historical baseline without rewriting its tables.
    if (!ledgerExists && current === 1) {
      for (const table of ['memories','diaries','dreams','activities']) db.prepare('SELECT id,content FROM ' + table + ' LIMIT 0').all();
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(1,steps[0].name,checksum(steps[0]),new Date().toISOString());
    }
    for (const step of steps.filter(step => step.version > current)) {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(step.version,step.name,checksum(step),new Date().toISOString());
      db.exec('PRAGMA user_version = ' + step.version);
      options.afterStep?.(step.version);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}


export function assertMigrationHistory(db: DatabaseSync) {
  const version=schemaVersion(db);
  if(version>latestVersion)throw new Error('Database schema is newer than application');
  const entries=db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all() as {version:number;name:string;checksum:string}[];
  if(entries.length!==version)throw new Error('Migration ledger does not match schema version');
  for(const [index,entry]of entries.entries()){const expected=migrations[index];if(!expected||entry.version!==index+1||entry.name!==expected.name||entry.checksum!==checksum(expected))throw new Error('Migration checksum mismatch');}
}
