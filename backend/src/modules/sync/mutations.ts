import type {DatabaseSync} from 'node:sqlite';
import type {ChatRevisionPayload} from '@sakie/contracts';
import {appendEvent,digest} from './events.js';
import {SyncError} from './service.js';
/** Must be called inside the same transaction as the state change. */
export function previousMutation<T>(db:DatabaseSync,id:string,request:unknown):T|undefined {
 const row=db.prepare('SELECT request_hash,result_json FROM sync_mutations WHERE id=?').get(id);if(!row)return;
 if(row.request_hash!==digest(JSON.stringify(request)))throw new SyncError(409,'MUTATION_ID_CONFLICT');return JSON.parse(String(row.result_json));
}
export function saveMutation(db:DatabaseSync,id:string,request:unknown,result:unknown){db.prepare('INSERT INTO sync_mutations VALUES (?,?,?)').run(id,digest(JSON.stringify(request)),JSON.stringify(result));}
export function reviseMessage(db:DatabaseSync,id:string,baseRevision:number,requestId:string,content:string|null,ownTransaction=true){
 if(ownTransaction)db.exec('BEGIN IMMEDIATE');try{
  const request={resource:'chat',id,baseRevision,content};const previous=previousMutation<ChatRevisionPayload>(db,requestId,request);if(previous){if(ownTransaction)db.exec('COMMIT');return previous;}
  const row=db.prepare(`SELECT m.*,t.status,s.revision,s.content AS edited_content,s.deleted_at FROM chat_messages m JOIN chat_turns t ON t.id=m.turn_id LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.id=?`).get(id);
  if(!row)throw new SyncError(404,'MESSAGE_NOT_FOUND');if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_live_submissions'").get()&&db.prepare('SELECT 1 FROM chat_live_submissions WHERE parent_id=?').get(id))throw new SyncError(409,'BATCH_PART_REQUIRED');if(row.status!=='succeeded')throw new SyncError(409,'TURN_UNRESOLVED');
  if(Number(row.revision??1)!==baseRevision||row.deleted_at)throw new SyncError(409,'REVISION_CONFLICT');
  const revision=baseRevision+1;const payload:ChatRevisionPayload={id,conversationId:String(row.conversation_id),revision,content:content??String(row.edited_content??row.content),deletedAt:content===null?new Date().toISOString():null};
  db.prepare('INSERT INTO chat_message_state(message_id,revision,content,deleted_at) VALUES (?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,content=excluded.content,deleted_at=excluded.deleted_at').run(id,revision,payload.content,payload.deletedAt);
  appendEvent(db,content===null?'chat.message.deleted':'chat.message.updated',payload);saveMutation(db,requestId,request,payload);if(ownTransaction)db.exec('COMMIT');return payload;
 }catch(error){if(ownTransaction)db.exec('ROLLBACK');throw error;}
}
