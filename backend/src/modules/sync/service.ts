import {randomBytes,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ArchiveIdentity,SyncProofCursor,SyncResumeRequest,SyncResumeResponse,SyncBatch,DevicePrincipal,PairingRequest,DeviceAuthPort} from '@sakie/contracts';
import {digest,streamId,wireEvent,bootstrapRecords} from './events.js';
export class SyncError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
export interface Device { id:string; archive_id:string; restore_generation:string; ack_seq:number; delivered_seq:number; }
export class SyncService implements DeviceAuthPort {
 constructor(readonly db:DatabaseSync){}
 private transaction<T>(f:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const result=f();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 async createPairing():Promise<PairingRequest>{
  const code=randomBytes(32).toString('base64url'),expiry=Date.now()+600000;
  this.db.prepare('INSERT INTO sync_pairings(code_hash,expires_at) VALUES (?,?)').run(digest(code),expiry);
  return{pairingId:code,expiresAt:new Date(expiry).toISOString()};
 }
 pair(code:string,archive:ArchiveIdentity){
  // Initial snapshots precede device activation; bootstrap never rewrites a business row.
  const valid=this.db.prepare('SELECT 1 FROM sync_pairings WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?').get(digest(code),Date.now());
  if(!valid)throw new SyncError(401,'INVALID_PAIRING');
  bootstrapRecords(this.db);
  return this.transaction(()=>{
   const changed=this.db.prepare('UPDATE sync_pairings SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?').run(Date.now(),digest(code),Date.now());
   if(!changed.changes)throw new SyncError(401,'INVALID_PAIRING');
   if(this.db.prepare('SELECT 1 FROM sync_devices WHERE archive_id=? AND revoked_at IS NULL').get(archive.archiveId))throw new SyncError(409,'ARCHIVE_ALREADY_PAIRED');
   const id=randomUUID(),token=randomBytes(32).toString('base64url');
   this.db.prepare('INSERT INTO sync_devices(id,token_hash,archive_id,restore_generation,created_at) VALUES (?,?,?,?,?)').run(id,digest(token),archive.archiveId,archive.restoreGeneration,new Date().toISOString());
   return{deviceId:id,token,archive};
  });
 }
 device(token:string):Device|null {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  return this.db.prepare('SELECT id,archive_id,restore_generation,ack_seq,delivered_seq FROM sync_devices WHERE token_hash=? AND revoked_at IS NULL').get(digest(token)) as unknown as Device|null??null;
 }
 async authenticate(token:string):Promise<DevicePrincipal|null>{const d=this.device(token);return d?{deviceId:d.id,scopes:['archive:write']}:null;}
 async revoke(id:string){this.db.prepare('UPDATE sync_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(),id);}
 private current(device:Device){const row=this.db.prepare('SELECT id,archive_id,restore_generation,ack_seq,delivered_seq FROM sync_devices WHERE id=? AND revoked_at IS NULL').get(device.id) as unknown as Device|undefined;if(!row)throw new SyncError(401,'DEVICE_REVOKED');return row;}
 head(){return Number(this.db.prepare('SELECT COALESCE(MAX(stream_seq),0) AS n FROM chat_outbox').get()!.n);}
 private validProof(cursor:SyncProofCursor){
  if(cursor.contiguousSeq===0)return cursor.lastEventId===null&&cursor.lastPayloadHash===null;
  const row=this.db.prepare('SELECT event_id,payload_hash FROM chat_outbox WHERE stream_seq=?').get(cursor.contiguousSeq);
  return !!row&&row.event_id===cursor.lastEventId&&row.payload_hash===cursor.lastPayloadHash;
 }
 resume(device:Device,request:SyncResumeRequest):SyncResumeResponse {
  const d=this.current(device),stream=streamId(this.db),head=this.head();
  const base={streamId:stream,headSeq:head,ackSeq:d.ack_seq};
  const fail=(reason:Extract<SyncResumeResponse,{status:'reconcile-required'}>['reason']):SyncResumeResponse=>({...base,status:'reconcile-required',reason});
  if(request.archive.archiveId!==d.archive_id)return fail('unknown-archive');
  if(request.archive.restoreGeneration!==d.restore_generation)return fail('restore-generation-changed');
  const cursor=request.lastArchived;
  if(cursor){if(cursor.archive.archiveId!==d.archive_id||cursor.archive.restoreGeneration!==d.restore_generation)return fail('restore-generation-changed');if(cursor.streamId!==stream)return fail('stream-changed');if(cursor.contiguousSeq>head)return fail('cursor-ahead');if(!this.validProof(cursor))return fail('proof-mismatch');}
  if((cursor?.contiguousSeq??0)<d.ack_seq)return fail('cursor-behind');
  // Replay from persisted cloud ACK, not a client's unverified high-water assertion.
  return{...base,status:'resume',afterSeq:d.ack_seq};
 }
 pull(device:Device,after:number,limit:number):SyncBatch {
  return this.transaction(()=>{
   const d=this.current(device);if(after!==d.ack_seq)throw new SyncError(409,'RESUME_REQUIRED');
   const rows=this.db.prepare('SELECT * FROM chat_outbox WHERE stream_seq>? ORDER BY stream_seq LIMIT ?').iterate(after,limit);
   const selected:Record<string,unknown>[]=[];let bytes=0;for(const row of rows){const size=Buffer.byteLength(String(row.payload));if(selected.length&&bytes+size>512*1024)break;selected.push(row);bytes+=size;}
   const events=selected.map(wireEvent);let expected=after+1;for(const event of events){if(event.streamSeq!==expected++)throw new SyncError(409,'EVENT_GAP');}
   const delivered=events.at(-1)?.streamSeq??after;
   this.db.prepare('UPDATE sync_devices SET delivered_seq=MAX(delivered_seq,?) WHERE id=?').run(delivered,d.id);
   return{streamId:streamId(this.db),headSeq:this.head(),afterSeq:after,events};
  });
 }
 acknowledge(device:Device,cursor:SyncProofCursor){
  return this.transaction(()=>{
   const d=this.current(device);
   if(cursor.archive.archiveId!==d.archive_id||cursor.archive.restoreGeneration!==d.restore_generation||cursor.streamId!==streamId(this.db))throw new SyncError(409,'ARCHIVE_RECONCILIATION_REQUIRED');
   if(cursor.durability!=='committed'||cursor.contiguousSeq>d.delivered_seq||!this.validProof(cursor))throw new SyncError(409,'ACK_NOT_DELIVERED_OR_INVALID');
   if(cursor.contiguousSeq<d.ack_seq)return{ackSeq:d.ack_seq};
   this.db.prepare('UPDATE sync_devices SET ack_seq=?,ack_event_id=?,ack_payload_hash=? WHERE id=?').run(cursor.contiguousSeq,cursor.lastEventId,cursor.lastPayloadHash,d.id);
   return{ackSeq:cursor.contiguousSeq};
  });
 }
 /** Deliberately fail closed: ACK alone does not prove durable off-disk backup or permit erasure. */
 async canPrune(){return false;}
}
