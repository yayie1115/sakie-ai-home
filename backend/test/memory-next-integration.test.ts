/** Synthetic-only test using the REAL sakie-ai-home migrations.
 * The lab grant schema is created only in :memory:, never a production migration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrate,assertMigrationHistory,schemaVersion} from '../src/database/migrations.js';
import {SqliteParticipantGrants,PARTICIPANT_GRANTS_LAB_SCHEMA} from '../src/modules/memory-next/participant-grants.js';
import {commitSourceBoundJobAtomic,type SourceBoundJob} from '../src/modules/memory-next/source-atomic.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');migrate(db);assertMigrationHistory(db);
 db.exec(PARTICIPANT_GRANTS_LAB_SCHEMA);
 db.prepare('INSERT INTO chat_conversations(id,title,created_at) VALUES (?,?,?)').run('room','test','2026-10-17T00:00:00Z');
 db.prepare(`INSERT INTO chat_turns(id,conversation_id,client_message_id,content_hash,turn_seq,status,created_at,updated_at) VALUES (?,?,?,?,?,'succeeded',?,?)`).run('turn','room','cli',hash('第一次记录'),1,'2026-10-17T00:00:00Z','2026-10-17T00:00:00Z');
 db.prepare(`INSERT INTO chat_messages(id,conversation_id,turn_id,message_seq,role,content,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`).run('message','room','turn',1,'user','第一次记录',hash('第一次记录'),'2026-10-17T00:00:00Z');
 const grants=new SqliteParticipantGrants(db); const grantRevision=String(grants.set('room','ai','allowed'));
 const job:SourceBoundJob={jobId:'j',actorId:'ai',conversationId:'room',grantRevision,sourceMessageId:'message',sourceRevision:1,sourceContentHash:hash('第一次记录')};
 return {db,grants,job};
}
test('real v1-v4 migration produces an intact baseline',()=>{
 const f=fixture();try{assert.equal(schemaVersion(f.db),4);assertMigrationHistory(f.db);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memories').get()?.n,0)}finally{f.db.close()}
});
test('memory job checks current grant and actual message row atomically',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE mem_test_results (id TEXT PRIMARY KEY) STRICT');
  const run=(j:SourceBoundJob)=>commitSourceBoundJobAtomic(f.db,j,f.grants,null,()=>{f.db.prepare('INSERT INTO mem_test_results VALUES (?)').run(j.jobId)});
  assert.equal(run(f.job),'committed');
  f.db.prepare('INSERT INTO chat_message_state(message_id,revision,content) VALUES (?,?,?)').run('message',2,'更新后的正文');
  assert.equal(run({...f.job,jobId:'stale'}),'denied');
  assert.equal(run({...f.job,jobId:'valid',sourceRevision:2,sourceContentHash:hash('更新后的正文')}),'committed');
  f.grants.set('room','ai','denied');
  assert.equal(run({...f.job,jobId:'revoked',sourceRevision:2,sourceContentHash:hash('更新后的正文')}),'denied');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mem_test_results').get()?.n,2);
 }finally{f.db.close()}
});
test('soft-deleted source cannot be committed',()=>{
 const f=fixture();try{f.db.exec('CREATE TABLE mem_test_results (id TEXT PRIMARY KEY) STRICT');
  f.db.prepare('INSERT INTO chat_message_state(message_id,revision,content,deleted_at) VALUES (?,?,?,?)').run('message',2,'第二版','2026-10-17T00:00:00Z');
  assert.equal(commitSourceBoundJobAtomic(f.db,{...f.job,sourceRevision:2,sourceContentHash:hash('第二版')},f.grants,null,()=>{throw Error('should not run')}),'denied');
 }finally{f.db.close()}
});
