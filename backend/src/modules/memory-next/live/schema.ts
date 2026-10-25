import {hasLiveChat} from '../../chat/live-schema.js';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {createBackup,restoreBackup} from '../../../database/backup.js';
import {assertMigrationHistory,schemaVersion} from '../../../database/migrations.js';
import {preservedTables,assertPreservedTables,databaseFingerprint} from '../../../database/fingerprint.js';
export const memorySchema=`
CREATE TABLE memory_live_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;
CREATE TABLE memory_live_scopes(conversation_id TEXT PRIMARY KEY,realm TEXT NOT NULL CHECK(realm IN ('real','game','simulation')),revision INTEGER NOT NULL) STRICT;
CREATE TABLE memory_live_grants(conversation_id TEXT NOT NULL,actor TEXT NOT NULL,allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),revision INTEGER NOT NULL,PRIMARY KEY(conversation_id,actor)) STRICT;
CREATE TABLE memory_live_entries(id TEXT PRIMARY KEY,actor TEXT NOT NULL,conversation_id TEXT NOT NULL,source_id TEXT NOT NULL,source_revision TEXT NOT NULL,source_hash TEXT NOT NULL,grant_revision TEXT NOT NULL,realm TEXT NOT NULL,layer TEXT NOT NULL CHECK(layer IN ('cognition','autobiography','impression')),kind TEXT NOT NULL,statement TEXT NOT NULL,evidence TEXT NOT NULL,confidence REAL NOT NULL,salience REAL NOT NULL,perspective TEXT,parent_id TEXT,channel TEXT NOT NULL,created_at TEXT NOT NULL,withdrawn_at TEXT) STRICT;
CREATE INDEX memory_live_actor ON memory_live_entries(actor,realm,conversation_id);
CREATE INDEX memory_live_source ON memory_live_entries(source_id,source_revision);
CREATE TABLE memory_live_corrections(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES memory_live_entries(id),text TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL) STRICT;
CREATE TABLE memory_live_jobs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,actor TEXT NOT NULL,turn_id TEXT NOT NULL,grant_revision TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('automatic','autonomous')),status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown','cancelled')),payload TEXT,created_at TEXT NOT NULL,error_code TEXT) STRICT;
CREATE INDEX memory_live_queue ON memory_live_jobs(status,created_at);
CREATE TABLE memory_live_calls(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,status TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,created_at TEXT NOT NULL) STRICT;
CREATE TABLE memory_live_events(id TEXT PRIMARY KEY,actor TEXT NOT NULL,realm TEXT NOT NULL,title TEXT NOT NULL,root_entry_id TEXT NOT NULL REFERENCES memory_live_entries(id),created_at TEXT NOT NULL) STRICT;
CREATE TABLE memory_live_event_revisions(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES memory_live_events(id),parent_id TEXT,payload TEXT NOT NULL,entry_ids TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','pending','rejected')),channel TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
`;
const checksum=createHash('sha256').update(memorySchema).digest('hex');
export function hasMemorySchema(db:DatabaseSync){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_live_schema' AND type='table'").get())return false;
 if(db.prepare('SELECT checksum FROM memory_live_schema WHERE version=1').get()?.checksum!==checksum)throw Error('MEMORY_SCHEMA_MISMATCH');
 for(const name of ['scopes','grants','entries','corrections','jobs','calls','events','event_revisions'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get('memory_live_'+name))throw Error('MEMORY_SCHEMA_INCOMPLETE');
 return true;
}
/** Explicit additive extension only. Startup never creates or migrates production tables. */
export function migrateMemory(db:DatabaseSync,verify:()=>void=()=>{},before:()=>void=()=>{}){
 if(hasMemorySchema(db))return;
 if(!hasLiveChat(db))throw Error('MEMORY_CHAT_EXTENSION_REQUIRED');
 if(schemaVersion(db)!==4)throw Error('MEMORY_REQUIRES_V4');assertMigrationHistory(db);
 db.exec('BEGIN IMMEDIATE');try{before();db.exec(memorySchema);db.prepare('INSERT INTO memory_live_schema VALUES(1,?,?)').run(checksum,new Date().toISOString());verify();if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('MEMORY_FOREIGN_KEY_FAILURE');db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
export async function upgradeMemory(filename:string,backupRoot:string){
 const source=new DatabaseSync(filename,{readOnly:true});let tables:ReturnType<typeof preservedTables>,fingerprint:string;
 try{if(hasMemorySchema(source))return {changed:false};assertMigrationHistory(source);if(schemaVersion(source)!==4)throw Error('MEMORY_REQUIRES_V4');if(source.prepare("SELECT 1 FROM chat_turns WHERE status IN ('queued','running') LIMIT 1").get())throw Error('MEMORY_DRAIN_REQUIRED');tables=preservedTables(source);fingerprint=databaseFingerprint(source);}finally{source.close();}
 const backupDirectory=await createBackup(filename,backupRoot),parent=mkdtempSync(join(backupRoot,'memory-rehearsal-'));
 const candidate=await restoreBackup(backupDirectory,join(parent,'candidate'));const copy=new DatabaseSync(candidate);
 try{migrateMemory(copy);assertPreservedTables(copy,tables!);if(copy.prepare('PRAGMA foreign_key_check').all().length)throw Error('MEMORY_FOREIGN_KEY_FAILURE');}finally{copy.close();}
 const db=new DatabaseSync(filename);try{db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');if(databaseFingerprint(db)!==fingerprint!)throw Error('MEMORY_SOURCE_CHANGED');migrateMemory(db,()=>assertPreservedTables(db,tables!),()=>{if(databaseFingerprint(db)!==fingerprint!)throw Error('MEMORY_SOURCE_CHANGED');if(db.prepare("SELECT 1 FROM chat_turns WHERE status IN ('queued','running') LIMIT 1").get())throw Error('MEMORY_DRAIN_REQUIRED');});}finally{db.close();}
 return {changed:true,backupDirectory,rehearsalDatabase:candidate};
}
