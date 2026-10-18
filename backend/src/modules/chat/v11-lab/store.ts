/** Thin admission guard: reuse ChatStore's transaction and writes, never duplicate its queue logic. */
import type { ClientMessage } from '@sakie/contracts';
import { ChatStore, ChatError } from '../store.js';
import { decodeSubmission } from './codec.js';
export class V11LabStore extends ChatStore {
 override findOriginal(message:ClientMessage){
  const previous=super.findOriginal(message);
  // The inherited accept() calls this again inside BEGIN IMMEDIATE. Validate only there.
  if(previous||!this.db.isTransaction)return previous;
  const s=decodeSubmission(message.content);if(!s)return previous;
  if(s.conversationId!==message.conversationId||s.submissionId!==message.clientMessageId)throw new ChatError(409,'BATCH_BINDING_CONFLICT');
  for(const b of s.bubbles)if(b.quote){const q=b.quote;if(q.conversationId!==s.conversationId)throw new ChatError(403,'QUOTE_SCOPE_DENIED');
   const row=this.db.prepare(`SELECT COALESCE(st.content,m.content) AS current_content,COALESCE(st.revision,1) AS revision,st.deleted_at,t.status
    FROM chat_messages m JOIN chat_turns t ON t.id=m.turn_id LEFT JOIN chat_message_state st ON st.message_id=m.id WHERE m.id=? AND m.conversation_id=?`).get(q.messageId,s.conversationId);
   if(!row||row.deleted_at!==null||row.status!=='succeeded'||row.revision!==q.revision)throw new ChatError(409,'QUOTE_NOT_CURRENT');
   const envelope=decodeSubmission(String(row.current_content));
   const texts=envelope?envelope.bubbles.filter(x=>!q.bubbleId||x.id===q.bubbleId).map(x=>x.content):q.bubbleId&&q.bubbleId!==q.messageId?[]:[String(row.current_content)];
   if(!texts.some(text=>text.includes(q.selectedText)))throw new ChatError(409,'QUOTE_EVIDENCE_MISMATCH');
  }
  for(const row of this.db.prepare("SELECT id,role,content FROM chat_messages").all()){
   if(s.bubbles.some(b=>b.id===row.id))throw new ChatError(409,'BUBBLE_ID_CONFLICT');
   const prior=row.role==='user'?decodeSubmission(String(row.content)):null;if(prior?.bubbles.some(old=>s.bubbles.some(b=>b.id===old.id)))throw new ChatError(409,'BUBBLE_ID_CONFLICT');
  }
  return previous;
 }
}
