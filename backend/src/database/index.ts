import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { latestVersion, migrate, schemaVersion } from './migrations.js';
export interface DatabaseAdapter { connect(): Promise<void>; disconnect(): Promise<void>; }
export function openDatabase(filename: string) {
  const existing = filename !== ':memory:' && existsSync(filename);
  if (filename !== ':memory:') mkdirSync(dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (existing && schemaVersion(db)<latestVersion) throw new Error('Database upgrade required: run npm run db:migrate -w backend after backup; automatic in-place upgrades are disabled');
    migrate(db);
    return db;
  } catch(error) {db.close();throw error;}
}
