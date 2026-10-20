import { appendEvent } from '../sync/events.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientMessage, CloudMessageStore, DurableMessageReceipt, ChatTurn, ChatMessage, ChatConversation } from '@sakie/contracts';
export class ChatError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export const hashContent = (s: string) => createHash('sha256').update(s).digest('hex');
export class ChatStore implements CloudMessageStore {
  constructor(readonly db: DatabaseSync) {}
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createConversation(id: string, title: string): ChatConversation {
    const existing = this.conversation(id);
    if(existing) { if(existing.title !== title) throw new ChatError(409,'CONVERSATION_ID_CONFLICT'); return existing; }
    this.db.prepare('INSERT INTO chat_conversations(id,title,created_at) VALUES (?,?,?)').run(id,title,new Date().toISOString());
    return this.conversation(id)!;
  }
  conversation(id: string): ChatConversation | undefined {
    return this.db.prepare('SELECT id,title,created_at AS createdAt FROM chat_conversations WHERE id=?').get(id) as unknown as ChatConversation | undefined;
  }
  conversations(before: number, limit: number) {
    return this.db.prepare('SELECT id,title,created_at AS createdAt,rowid AS cursor FROM chat_conversations WHERE rowid<? ORDER BY rowid DESC LIMIT ?').all(before,limit) as unknown as (ChatConversation & {cursor:number})[];
  }
  turn(id: string): ChatTurn {
    const row = this.db.prepare('SELECT id,conversation_id AS conversationId,client_message_id AS clientMessageId,turn_seq AS turnSeq,status,error_code AS errorCode,created_at AS createdAt FROM chat_turns WHERE id=?').get(id);
    if(!row) throw new ChatError(404,'TURN_NOT_FOUND'); return row as unknown as ChatTurn;
  }
  messages(conversationId: string, before: number, limit: number): ChatMessage[] {
    if(!this.conversation(conversationId)) throw new ChatError(404,'CONVERSATION_NOT_FOUND');
    return (this.db.prepare('SELECT m.id,m.turn_id AS turnId,m.message_seq AS messageSeq,m.role,COALESCE(s.content,m.content) AS content,m.created_at AS createdAt,COALESCE(s.revision,1) AS revision FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.conversation_id=? AND m.message_seq<? AND s.deleted_at IS NULL ORDER BY m.message_seq DESC LIMIT ?').all(conversationId,before,limit) as unknown as ChatMessage[]).reverse();
  }
  unresolved(conversationId: string): ChatTurn | null {
    const row = this.db.prepare("SELECT id FROM chat_turns WHERE conversation_id=? AND status!='succeeded'").get(conversationId);
    return row ? this.turn(String(row.id)) : null;
  }
  findOriginal(message: ClientMessage): ChatTurn | null {
    const row = this.db.prepare('SELECT id,content_hash FROM chat_turns WHERE conversation_id=? AND client_message_id=?').get(message.conversationId,message.clientMessageId);
    if(!row) return null;
    if(row.content_hash !== hashContent(message.content)) throw new ChatError(409,'MESSAGE_ID_CONFLICT');
    return this.turn(String(row.id));
  }
  async accept(message: ClientMessage): Promise<DurableMessageReceipt> {
    return this.transaction(() => {
      const existing = this.findOriginal(message);
      if(existing) return this.receipt(existing);
      if(!this.conversation(message.conversationId)) throw new ChatError(404,'CONVERSATION_NOT_FOUND');
      if(this.unresolved(message.conversationId)) throw new ChatError(409,'TURN_UNRESOLVED');
      const seq = Number(this.db.prepare('SELECT next_turn_seq FROM chat_conversations WHERE id=?').get(message.conversationId)!.next_turn_seq);
      if(!Number.isSafeInteger(seq) || seq > Math.floor((Number.MAX_SAFE_INTEGER-2)/2)) throw new ChatError(503,'SEQUENCE_EXHAUSTED');
      const now = new Date().toISOString(), turnId = randomUUID(), messageId = randomUUID();
      this.db.prepare("INSERT INTO chat_turns(id,conversation_id,client_message_id,content_hash,turn_seq,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)").run(turnId,message.conversationId,message.clientMessageId,hashContent(message.content),seq,now,now);
      this.db.prepare('UPDATE chat_conversations SET next_turn_seq=next_turn_seq+1 WHERE id=?').run(message.conversationId);
      this.appendMessage({id:messageId,conversationId:message.conversationId,turnId,messageSeq:seq*2-1,role:'user',content:message.content,createdAt:now});
      return {messageId,turnId,turnSeq:seq,durable:true};
    });
  }
  message(id: string): ChatMessage | null {
    return this.db.prepare('SELECT m.id,m.turn_id AS turnId,m.message_seq AS messageSeq,m.role,COALESCE(s.content,m.content) AS content,m.created_at AS createdAt,COALESCE(s.revision,1) AS revision FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.id=? AND s.deleted_at IS NULL').get(id) as unknown as ChatMessage | undefined ?? null;
  }
  receipt(turn: ChatTurn): DurableMessageReceipt {
    const message = this.db.prepare("SELECT id FROM chat_messages WHERE turn_id=? AND role='user'").get(turn.id)!;
    return {messageId:String(message.id),turnId:turn.id,turnSeq:turn.turnSeq,durable:true};
  }
  appendMessage(message: ChatMessage & {conversationId:string}) {
    const digest = hashContent(message.content);
    this.db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?,?)').run(message.id,message.conversationId,message.turnId,message.messageSeq,message.role,message.content,digest,message.createdAt);
    appendEvent(this.db,'chat.message.created',{...message,contentHash:digest});
  }
}
