import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WireSyncEvent, ArchiveRecordPayload } from '@sakie/contracts';
export const digest = (s:string) => createHash('sha256').update(s).digest('hex');
/** Call only inside the business transaction. Original outbox schema and IDs are reused. */
export function appendEvent(db:DatabaseSync,kind:string,payload:unknown):string {
 db.prepare('INSERT OR IGNORE INTO chat_archive_identity VALUES (1,?)').run(randomUUID());
 const producer=String(db.prepare('SELECT producer_id FROM chat_archive_identity WHERE singleton=1').get()!.producer_id);
 const seq=Number(db.prepare('SELECT COALESCE(MAX(producer_seq),0)+1 AS n FROM chat_outbox WHERE producer_id=?').get(producer)!.n);
 const id=randomUUID(),json=JSON.stringify(payload);
 db.prepare('INSERT INTO chat_outbox(event_id,producer_id,producer_seq,schema_version,kind,payload,payload_hash,created_at) VALUES (?,?,?,1,?,?,?,?)').run(id,producer,seq,kind,json,digest(json),new Date().toISOString());return id;
}
export function streamId(db:DatabaseSync):string {
 db.prepare('INSERT OR IGNORE INTO chat_archive_identity VALUES (1,?)').run(randomUUID());
 return 'chat:'+String(db.prepare('SELECT producer_id FROM chat_archive_identity WHERE singleton=1').get()!.producer_id);
}
export function wireEvent(row:Record<string,unknown>):WireSyncEvent {
 const json=String(row.payload);return {schemaVersion:1,eventId:String(row.event_id),producerId:String(row.producer_id),producerSeq:Number(row.producer_seq),streamSeq:Number(row.stream_seq),payloadHash:String(row.payload_hash),kind:String(row.kind),payload:JSON.parse(json),payloadJson:json};
}
export function appendRecordVersion(db:DatabaseSync,payload:ArchiveRecordPayload) {
 if(db.prepare('SELECT 1 FROM sync_record_events WHERE resource=? AND record_id=? AND revision=?').get(payload.resource,payload.id,payload.revision))return;
 const baseline=!db.prepare('SELECT 1 FROM sync_record_events WHERE resource=? AND record_id=?').get(payload.resource,payload.id);
 const id=appendEvent(db,payload.deletedAt?'record.deleted':payload.revision===1?'record.created':'record.updated',{...payload,baseline});
 db.prepare('INSERT INTO sync_record_events VALUES (?,?,?,?)').run(payload.resource,payload.id,payload.revision,id);
}
/** Explicit bootstrap, before pairing: old rows get snapshot events; no fabricated historical versions. */
export function bootstrapRecords(db:DatabaseSync) {
 db.exec('BEGIN IMMEDIATE');try{
  for(const resource of ['memories','diaries','dreams','activities'] as const){
   for(const row of db.prepare('SELECT r.*,m.revision AS _revision,m.deleted_at AS _deleted FROM '+resource+' r JOIN record_metadata m ON m.record_id=r.id AND m.resource=? ORDER BY r.id').iterate(resource)){
    const {_revision,_deleted,...record}=row;appendRecordVersion(db,{resource,id:String(record.id),revision:Number(_revision),record,deletedAt:_deleted===null?null:String(_deleted)});
   }
  }db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
