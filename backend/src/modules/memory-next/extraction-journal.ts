/** Synthetic checkpoint journal. Separate schema v1, explicitly NOT the production v5 migration. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import type { ExtractionState, ExtractionStateStore } from './extraction-state.js';
export const extractionLabMarker = 'sakie-mem04-synthetic-journal-v1';
const checksum = (s:string) => createHash('sha256').update(s).digest('hex');
export class SqliteExtractionLab implements ExtractionStateStore {
 private constructor(private readonly db:DatabaseSync){}
 static open(filename:string):SqliteExtractionLab {
  const path=resolve(filename),parent=dirname(path);
  if(basename(path)!=='extractor.sqlite'||!basename(parent).startsWith('mem04-synthetic-')||realpathSync(parent)!==parent
   ||lstatSync(parent).isSymbolicLink()||readFileSync(join(parent,'synthetic-marker.txt'),'utf8')!==extractionLabMarker)throw Error('extraction_synthetic_path_only');
  for(const suffix of ['', '-wal', '-shm'])if(existsSync(path+suffix)&&lstatSync(path+suffix).isSymbolicLink())throw Error('extraction_linked_journal');
  const db=new DatabaseSync(path);
  try{
   const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
   if(tables.some(r=>r.name!=='mem04_state'))throw Error('extraction_foreign_database');
   db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
   db.exec('CREATE TABLE IF NOT EXISTS mem04_state (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL) STRICT');
   return new SqliteExtractionLab(db);
  }catch(error){db.close();throw error;}
 }
 read(){
  const row=this.db.prepare('SELECT revision,payload,digest FROM mem04_state WHERE id=1').get();
  if(!row)return {revision:0,state:null};
  if(!Number.isSafeInteger(row.revision)||Number(row.revision)<1||String(row.payload).length>64*1024*1024||checksum(String(row.payload))!==row.digest)throw Error('extraction_journal_corrupt');
  return {revision:Number(row.revision),state:JSON.parse(String(row.payload)) as ExtractionState};
 }
 write(expectedRevision:number,state:ExtractionState,verify:()=>void):number {
  this.db.exec('BEGIN IMMEDIATE');try{
   const current=this.read();if(current.revision!==expectedRevision)throw Error('extraction_checkpoint_conflict');
   verify();const payload=JSON.stringify(state),revision=current.revision+1;
   this.db.prepare('INSERT INTO mem04_state VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,digest=excluded.digest').run(revision,payload,checksum(payload));
   this.db.exec('COMMIT');return revision;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 integrity(){return this.db.prepare('PRAGMA integrity_check').get()!.integrity_check;}
 close(){this.db.close();}
}
