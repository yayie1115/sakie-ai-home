import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
const quote = (value: string) => '"' + value.replaceAll('"','""') + '"';
/** Ordered, streaming fingerprint of all user tables. Excludes indexes, not user data. */
export function databaseFingerprint(db: DatabaseSync): string {
  const hash = createHash('sha256');
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  for (const table of tables) {
    hash.update(JSON.stringify(table));
    const columns = db.prepare('PRAGMA table_info(' + quote(table.name) + ')').all() as { name: string; pk: number }[];
    const primary = columns.filter(c => c.pk).sort((a,b) => a.pk - b.pk);
    const order = (primary.length ? primary : columns).map(c => quote(c.name)).join(',');
    for (const row of db.prepare('SELECT * FROM ' + quote(table.name) + ' ORDER BY ' + order).iterate()) hash.update(JSON.stringify(row,(_k,v) => typeof v === 'bigint' ? { bigint: String(v) } : v));
  }
  return hash.digest('hex');
}
export function businessFingerprint(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const table of ['memories','diaries','dreams','activities']) {
    hash.update(table);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    for (const row of db.prepare('SELECT * FROM ' + table + ' ORDER BY id').iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
