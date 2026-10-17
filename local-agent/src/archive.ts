import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {ArchiveIdentity,LocalArchivePort,SyncProofCursor,WireSyncEvent} from '@sakie/contracts';
import {archiveSchema} from './schema.js';
export const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export class ArchiveError extends Error {constructor(readonly code:string){super(code);}}
const fail=(code:string):never=>{throw new ArchiveError(code);};
const text=(v:unknown,max=200):string=>typeof v==='string'&&v.length>0&&v.length<=max?v:fail('INVALID_EVENT_TEXT');
const integer=(v:unknown,min=1):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min?v:fail('INVALID_EVENT_SEQUENCE');
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail('INVALID_EVENT_PAYLOAD');
export class LocalArchive implements LocalArchivePort {
 readonly db:DatabaseSync;
 private closed=false;
 constructor(readonly filename:string){
  if(filename!==':memory:'){if(existsSync(filename)&&lstatSync(filename).isSymbolicLink())fail('ARCHIVE_SYMLINK');mkdirSync(dirname(filename),{recursive:true});}
  this.db=new DatabaseSync(filename);
  try{
   this.db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');
   const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
   const count=Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n);
   if(version===0&&count===0){this.transaction(()=>{this.db.exec(archiveSchema);this.db.prepare('INSERT INTO archive_migrations VALUES (1,?)').run(digest(archiveSchema));this.db.prepare('INSERT INTO archive_identity(singleton,archive_id,restore_generation) VALUES (1,?,?)').run(randomUUID(),randomUUID());this.db.exec('PRAGMA user_version=1');});}
   else if(version!==1||this.db.prepare('SELECT checksum FROM archive_migrations WHERE version=1').get()?.checksum!==digest(archiveSchema))fail('ARCHIVE_SCHEMA_MISMATCH');
   this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
   if(this.db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok'||this.db.prepare('PRAGMA foreign_key_check').all().length)fail('ARCHIVE_INTEGRITY_FAILED');
   this.observeRestoreMarker();this.validateCursor();
  }catch(error){this.db.close();throw error;}
 }
 transaction<T>(f:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=f();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private observeRestoreMarker(){
  if(this.filename===':memory:')return;const marker=join(dirname(this.filename),'restore-info.json');if(!existsSync(marker))return;
  const m=JSON.parse(readFileSync(marker,'utf8'));if(typeof m.restoreGeneration!=='string'||!/^[a-f0-9-]{36}$/i.test(m.restoreGeneration))fail('INVALID_RESTORE_MARKER');
  const old=this.db.prepare('SELECT restore_marker FROM archive_identity WHERE singleton=1').get()!;
  if(old.restore_marker!==m.restoreGeneration)this.db.prepare('UPDATE archive_identity SET restore_generation=?,restore_marker=? WHERE singleton=1').run(m.restoreGeneration,m.restoreGeneration);
  // Keep the marker. Cloud still must reject the obsolete device binding; explicit re-pairing is required.
 }
 private validateCursor(){const cursor=this.db.prepare('SELECT * FROM archive_cursor WHERE singleton=1').get()!;const state=this.db.prepare('SELECT COALESCE(MAX(stream_seq),0) AS top,count(*) AS n FROM archive_events').get()!;if(cursor.seq!==state.top||state.top!==state.n)fail('ARCHIVE_CURSOR_INTEGRITY');if(Number(cursor.seq)>0){const e=this.db.prepare('SELECT event_id,payload_hash FROM archive_events WHERE stream_seq=?').get(cursor.seq as number)!;if(e.event_id!==cursor.event_id||e.payload_hash!==cursor.payload_hash)fail('ARCHIVE_CURSOR_INTEGRITY');}}
 async inspectIdentity():Promise<ArchiveIdentity>{const row=this.db.prepare('SELECT archive_id,restore_generation FROM archive_identity WHERE singleton=1').get()!;return{archiveId:String(row.archive_id),restoreGeneration:String(row.restore_generation)};}
 bindStream(stream:string){text(stream,100);const current=this.db.prepare('SELECT stream_id FROM archive_identity WHERE singleton=1').get()!.stream_id;if(current!==null&&current!==stream)fail('STREAM_CHANGED');this.db.prepare('UPDATE archive_identity SET stream_id=? WHERE singleton=1').run(stream);}
 async cursor():Promise<SyncProofCursor|null>{const stream=this.db.prepare('SELECT stream_id FROM archive_identity WHERE singleton=1').get()!.stream_id;if(!stream)return null;const row=this.db.prepare('SELECT seq FROM archive_cursor WHERE singleton=1').get()!;return this.receiptAt(Number(row.seq));}
 async receiptAt(seq:number):Promise<SyncProofCursor>{integer(seq,0);const latest=Number(this.db.prepare('SELECT seq FROM archive_cursor WHERE singleton=1').get()!.seq);if(seq>latest)fail('CURSOR_NOT_COMMITTED');const stream=this.db.prepare('SELECT stream_id FROM archive_identity WHERE singleton=1').get()!.stream_id;if(!stream)fail('STREAM_NOT_BOUND');const row=seq===0?null:this.db.prepare('SELECT event_id,payload_hash FROM archive_events WHERE stream_seq=?').get(seq);if(seq>0&&!row)fail('CURSOR_NOT_COMMITTED');return{streamId:String(stream),contiguousSeq:seq,archive:await this.inspectIdentity(),durability:'committed',lastEventId:row?String(row.event_id):null,lastPayloadHash:row?String(row.payload_hash):null};}
 async commitBatch(events:readonly WireSyncEvent[],options:{beforeCommit?:()=>void}={}):Promise<SyncProofCursor>{
  try{this.transaction(()=>{
   let seq=Number(this.db.prepare('SELECT seq FROM archive_cursor WHERE singleton=1').get()!.seq);
   let previous=0;
   for(const event of events){
    const e=object(event);if(e.schemaVersion!==1)fail('EVENT_SCHEMA_UNSUPPORTED');integer(e.streamSeq);integer(e.producerSeq);text(e.eventId);text(e.producerId);text(e.kind);if(event.streamSeq<=previous)fail('EVENT_ORDER_INVALID');previous=event.streamSeq;
    const raw=text(e.payloadJson,1024*1024);let parsed:unknown;try{parsed=JSON.parse(raw);}catch{fail('INVALID_EVENT_PAYLOAD');}if(digest(raw)!==event.payloadHash||JSON.stringify(parsed)!==JSON.stringify(event.payload))fail('EVENT_HASH_MISMATCH');
    const envelope=digest(JSON.stringify([event.schemaVersion,event.eventId,event.producerId,event.producerSeq,event.streamSeq,event.kind,event.payloadHash,raw]));
    const duplicate=this.db.prepare('SELECT envelope_hash FROM archive_events WHERE event_id=? OR stream_seq=? OR (producer_id=? AND producer_seq=?)').all(event.eventId,event.streamSeq,event.producerId,event.producerSeq);
    if(duplicate.length){if(duplicate.length!==1||duplicate[0].envelope_hash!==envelope)fail('EVENT_ID_CONFLICT');continue;}
    if(event.streamSeq!==seq+1)fail('EVENT_GAP');
    const stream=this.db.prepare('SELECT stream_id FROM archive_identity WHERE singleton=1').get()!.stream_id;if(stream!=='chat:'+event.producerId)fail('EVENT_PRODUCER_MISMATCH');
    this.apply(event);
    this.db.prepare('INSERT INTO archive_events VALUES (?,?,?,?,?,?,?,?)').run(event.streamSeq,event.eventId,event.producerId,event.producerSeq,event.kind,raw,event.payloadHash,envelope);
    this.db.prepare('UPDATE archive_cursor SET seq=?,event_id=?,payload_hash=? WHERE singleton=1').run(event.streamSeq,event.eventId,event.payloadHash);seq=event.streamSeq;
   }
   options.beforeCommit?.();
  });}catch(error){
   const code=error instanceof ArchiveError?error.code:'ARCHIVE_TRANSACTION_FAILED';const evidence=JSON.stringify(events).slice(0,1024*1024);
   try{this.db.prepare('INSERT OR IGNORE INTO archive_conflicts VALUES (?,?,?,?)').run(digest(code+evidence),code,evidence,new Date().toISOString());}catch{}
   throw error;
  }
  return (await this.cursor())??fail('STREAM_NOT_BOUND');
 }
 private apply(event:WireSyncEvent){
  const p=object(event.payload);
  if(event.kind==='chat.message.created'){
   const id=text(p.id),conversation=text(p.conversationId),seq=integer(p.messageSeq);if(!['user','assistant'].includes(String(p.role)))fail('INVALID_MESSAGE_ROLE');const content=text(p.content,100000);if(digest(content)!==p.contentHash)fail('MESSAGE_HASH_MISMATCH');
   const expected=Number(this.db.prepare('SELECT COALESCE(MAX(message_seq),0)+1 AS n FROM archive_messages WHERE conversation_id=?').get(conversation)!.n);if(seq!==expected)fail('MESSAGE_ORDER_GAP');
   if((seq%2===1&&p.role!=='user')||(seq%2===0&&p.role!=='assistant'))fail('INVALID_MESSAGE_ORDER');
   this.db.prepare('INSERT INTO archive_messages VALUES (?,?,?,?,?,?,?,?)').run(id,conversation,text(p.turnId),seq,String(p.role),content,String(p.contentHash),text(p.createdAt));
  }else if(event.kind==='chat.message.updated'||event.kind==='chat.message.deleted'){
   const id=text(p.id),revision=integer(p.revision,2);const row=this.db.prepare('SELECT m.conversation_id,s.revision,s.deleted_at FROM archive_messages m LEFT JOIN archive_message_state s ON s.message_id=m.id WHERE m.id=?').get(id);
   if(!row||row.conversation_id!==p.conversationId||Number(row.revision??1)+1!==revision||row.deleted_at)fail('MESSAGE_REVISION_CONFLICT');
   const deleted=event.kind.endsWith('deleted');if(deleted?(typeof p.deletedAt!=='string'):p.deletedAt!==null)fail('INVALID_DELETION_EVENT');
   this.db.prepare('INSERT INTO archive_message_state VALUES (?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,content=excluded.content,deleted_at=excluded.deleted_at').run(id,revision,text(p.content,100000),deleted?String(p.deletedAt):null);
  }else if(['record.created','record.updated','record.deleted'].includes(event.kind)){
   const resource=text(p.resource),id=text(p.id),revision=integer(p.revision);if(!['memories','diaries','dreams','activities'].includes(resource)||object(p.record).id!==id)fail('INVALID_RECORD_EVENT');
   const old=this.db.prepare('SELECT revision,deleted_at FROM archive_records WHERE resource=? AND id=?').get(resource,id);
   if(old?(Number(old.revision)+1!==revision||!!old.deleted_at):revision!==1&&p.baseline!==true)fail('RECORD_REVISION_CONFLICT');
   if(event.kind==='record.deleted'?(typeof p.deletedAt!=='string'||!p.deletedAt):p.deletedAt!==null)fail('INVALID_DELETION_EVENT');
   this.db.prepare('INSERT INTO archive_record_versions VALUES (?,?,?,?)').run(resource,id,revision,event.payloadJson);
   this.db.prepare('INSERT INTO archive_records VALUES (?,?,?,?,?) ON CONFLICT(resource,id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,deleted_at=excluded.deleted_at').run(resource,id,revision,JSON.stringify(p.record),p.deletedAt as string|null);
  }else fail('EVENT_KIND_UNSUPPORTED');
 }
 retryState(){return this.db.prepare('SELECT failures,next_retry_at AS nextRetryAt,phase,last_error AS lastError FROM archive_retry WHERE singleton=1').get() as unknown as {failures:number;nextRetryAt:number;phase:string;lastError:string|null};}
 setRetry(failures:number,nextRetryAt:number,phase:string,error:string|null){this.db.prepare('UPDATE archive_retry SET failures=?,next_retry_at=?,phase=?,last_error=? WHERE singleton=1').run(failures,nextRetryAt,phase,error);}
 close(){if(!this.closed){this.closed=true;this.db.close();}}
}
