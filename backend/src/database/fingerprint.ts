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

export interface PreservedTable { name:string;columns:string[];order:string[];hash:string; }
/** Stream every PRE-EXISTING table, including chat/outbox/auth, without logging its contents. */
export function preservedTables(db:DatabaseSync):PreservedTable[]{
 return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all() as {name:string}[]).map(({name})=>{
  const info=db.prepare('PRAGMA table_info('+quote(name)+')').all() as {name:string;pk:number}[];
  const columns=info.map(c=>c.name),primary=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name),order=primary.length?primary:columns;
  const table={name,columns,order,hash:''};table.hash=preservedHash(db,table);return table;
 });
}
function preservedHash(db:DatabaseSync,table:PreservedTable){const hash=createHash('sha256');for(const row of db.prepare('SELECT '+table.columns.map(quote).join(',')+' FROM '+quote(table.name)+' ORDER BY '+table.order.map(quote).join(',')).iterate())hash.update(JSON.stringify(row,(_k,v)=>typeof v==='bigint'?{bigint:String(v)}:v));return hash.digest('hex');}
export function assertPreservedTables(db:DatabaseSync,tables:readonly PreservedTable[]){for(const table of tables)if(preservedHash(db,table)!==table.hash)throw new Error('Migration changed pre-existing table: '+table.name);}
