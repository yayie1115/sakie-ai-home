import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {mkdtempSync} from 'node:fs';
import {createBackup,restoreBackup} from '../../database/backup.js';
import {databaseFingerprint,preservedTables,assertPreservedTables} from '../../database/fingerprint.js';
import {assertMigrationHistory,schemaVersion} from '../../database/migrations.js';
/** Named additive extension; does not claim the synthetic DATA-01/OPS-02 v5/v6 numbers. */
export const liveChatSchema=`
CREATE TABLE chat_live_profiles (
 conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id),
 kind TEXT NOT NULL CHECK(kind IN ('private','group'))
) STRICT;
CREATE TABLE chat_live_members (
 conversation_id TEXT NOT NULL REFERENCES chat_live_profiles(conversation_id), member_id TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(conversation_id,member_id), UNIQUE(conversation_id,position)
) STRICT;
CREATE TABLE chat_live_turn_speakers (
 turn_id TEXT PRIMARY KEY REFERENCES chat_turns(id), conversation_id TEXT NOT NULL, member_id TEXT NOT NULL,
 FOREIGN KEY(conversation_id,member_id) REFERENCES chat_live_members(conversation_id,member_id)
) STRICT;
CREATE TABLE chat_live_migrations (version INTEGER PRIMARY KEY CHECK(version=1), checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
`;
const checksum=createHash('sha256').update(liveChatSchema).digest('hex');
export function hasLiveChat(db:DatabaseSync){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_live_migrations'").get())return false;
 const row=db.prepare('SELECT checksum FROM chat_live_migrations WHERE version=1').get();
 if(row?.checksum!==checksum||['chat_live_profiles','chat_live_members','chat_live_turn_speakers'].some(name=>!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)))throw Error('CHAT_LIVE_SCHEMA_MISMATCH');
 return true;
}
/** Never called by startup or HTTP. Existing tables/rows and PRAGMA user_version remain unchanged. */
export function migrateLiveChat(db:DatabaseSync,before?:()=>void,validate?:()=>void){
 if(hasLiveChat(db))return;
 if(schemaVersion(db)!==4)throw Error('CHAT_LIVE_REQUIRES_OFFICIAL_V4');
 assertMigrationHistory(db);
 db.exec('BEGIN IMMEDIATE');
 try{before?.();db.exec(liveChatSchema);db.prepare('INSERT INTO chat_live_migrations VALUES (1,?,?)').run(checksum,new Date().toISOString());if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('CHAT_LIVE_FOREIGN_KEY_FAILURE');validate?.();db.exec('COMMIT');}
 catch(e){db.exec('ROLLBACK');throw e;}
}
/** Explicit maintenance only: back up and rehearse before changing the selected database. */
export async function upgradeLiveChat(filename:string,backupRoot:string){
 const source=new DatabaseSync(filename,{readOnly:true});let fingerprint:string,tables:ReturnType<typeof preservedTables>;
 try{if(hasLiveChat(source))return {changed:false};if(schemaVersion(source)!==4)throw Error('CHAT_LIVE_REQUIRES_OFFICIAL_V4');assertMigrationHistory(source);if(source.prepare("SELECT 1 FROM chat_turns WHERE status IN ('queued','running') LIMIT 1").get())throw Error('CHAT_LIVE_DRAIN_REQUIRED');fingerprint=databaseFingerprint(source);tables=preservedTables(source);}finally{source.close();}
 const backupDirectory=await createBackup(filename,backupRoot);
 const parent=mkdtempSync(join(backupRoot,'chat-live-rehearsal-'));
 const candidate=await restoreBackup(backupDirectory,join(parent,'candidate'));
 const copy=new DatabaseSync(candidate);
 try{if(databaseFingerprint(copy)!==fingerprint)throw Error('CHAT_LIVE_SOURCE_CHANGED');migrateLiveChat(copy);assertPreservedTables(copy,tables);}finally{copy.close();}
 const db=new DatabaseSync(filename);
 try{db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');migrateLiveChat(db,()=>{if(db.prepare("SELECT 1 FROM chat_turns WHERE status IN ('queued','running') LIMIT 1").get())throw Error('CHAT_LIVE_DRAIN_REQUIRED');if(databaseFingerprint(db)!==fingerprint)throw Error('CHAT_LIVE_SOURCE_CHANGED');},()=>assertPreservedTables(db,tables));}finally{db.close();}
 return {changed:true,backupDirectory,rehearsalDatabase:candidate};
}
