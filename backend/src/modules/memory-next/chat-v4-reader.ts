/** Read-only v3/v4 chat projection. Not an outbox replay or production integration.
 * A caller must provide explicit AI access scopes; current chat schema contains no AI membership.
 */
import type {DatabaseSync} from 'node:sqlite';
import type {SourceEvent} from './pipeline.js';
export interface ChatV4Cursor {conversationId:string; beforeSeq:number; limit:number; actorIds:string[]}
export interface ChatV4Result {status:'ok'|'unsupported_schema'|'invalid_scope'; sources:SourceEvent[];nextBeforeSeq:number|null}
function tableHas(db:DatabaseSync,t:string,cols:string[]):boolean {
 const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
 if(!exists)return false;
 const fields=new Set((db.prepare(`PRAGMA table_info(${t})`).all() as {name:string}[]).map(x=>x.name));
 return cols.every(x=>fields.has(x));
}
export function readChatV4Sources(db:DatabaseSync,input:ChatV4Cursor):ChatV4Result {
 if(!input.actorIds?.length||input.actorIds.some(s=>!s.trim())||!input.conversationId?.trim()||!Number.isSafeInteger(input.beforeSeq)||input.beforeSeq<=0||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)return{status:'invalid_scope',sources:[],nextBeforeSeq:null};
 if(!tableHas(db,'chat_messages',['id','conversation_id','message_seq','role','content','created_at'])||!tableHas(db,'chat_message_state',['message_id','revision','content','deleted_at']))return{status:'unsupported_schema',sources:[],nextBeforeSeq:null};
 // Bind all external values. Never project raw historical content of edited/deleted messages.
 const rows=db.prepare(`SELECT m.id,m.message_seq,m.role,m.created_at,
 COALESCE(s.revision,1) AS revision, COALESCE(s.content,m.content) AS active_content,
 s.deleted_at FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id
 WHERE m.conversation_id=? AND m.message_seq<? ORDER BY m.message_seq DESC LIMIT ?`).all(input.conversationId,input.beforeSeq,input.limit) as {id:string;message_seq:number;role:string;created_at:string;revision:number;active_content:string;deleted_at:string|null}[];
 const sources:SourceEvent[]=rows.filter(r=>r.deleted_at===null&&!!r.active_content.trim()).map(r=>({
   eventId:`chat:${r.id}:v${r.revision}`,
   source:{id:r.id,version:String(r.revision),context:'real',scope:{type:'private',actors:[...input.actorIds]},active:true,deleted:false,occurredAt:r.created_at},
   text:r.active_content
 }));
 return {status:'ok',sources,nextBeforeSeq:rows.length===input.limit?rows[rows.length-1].message_seq:null};
}
