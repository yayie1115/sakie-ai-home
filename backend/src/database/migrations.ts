import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync) {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > 1) throw new Error('Database schema is newer than this application');
  if (version === 1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 100000),
        type TEXT NOT NULL CHECK(length(trim(type)) BETWEEN 1 AND 100),
        createdAt TEXT NOT NULL, importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5)
      ) STRICT;
      CREATE INDEX memories_created_at ON memories(createdAt DESC, id DESC);
      CREATE TABLE diaries (
        id TEXT PRIMARY KEY, date TEXT NOT NULL,
        content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 100000)
      ) STRICT;
      CREATE INDEX diaries_date ON diaries(date DESC, id DESC);
      CREATE TABLE dreams (
        id TEXT PRIMARY KEY, date TEXT NOT NULL,
        content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 100000),
        source TEXT NOT NULL CHECK(source IN ('ai', 'user'))
      ) STRICT;
      CREATE INDEX dreams_date ON dreams(date DESC, id DESC);
      CREATE TABLE activities (
        id TEXT PRIMARY KEY, time TEXT NOT NULL,
        type TEXT NOT NULL CHECK(length(trim(type)) BETWEEN 1 AND 100),
        content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 100000)
      ) STRICT;
      CREATE INDEX activities_time ON activities(time DESC, id DESC);
      PRAGMA user_version = 1;
    `);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
