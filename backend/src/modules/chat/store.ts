import {batchReady,batchHash,validateSegments,insertSegments,segmentSnapshot,projectSegments} from './live-batch.js';
import {conversationDeleted,uiReady} from '../app-ui/schema.js';
import { hasLiveChat } from './live-schema.js';
import { conversationProfile } from './participants.js';
import type { ChatConversationProfile } from '@sakie/contracts';
import { appendEvent } from '../sync/events.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientMessage, CloudMessageStore, DurableMessageReceipt, ChatTurn, ChatMessage, ChatConversation } from '@sakie/contracts';
export class ChatError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export const hashContent = (s: string) => createHash('sha256').update(s).digest('hex');
export class ChatStore implements CloudMessageStore {
  readonly liveReady:boolean;
  constructor(readonly db: DatabaseSync) {this.liveReady=hasLiveChat(db);}
  private profile(id:string):ChatConversationProfile|null {
    if(!this.liveReady)return null;
    const p=this.db.prepare('SELECT kind FROM chat_live_profiles WHERE conversation_id=?').get(id);
    return p?{kind:p.kind as ChatConversationProfile['kind'],members:(this.db.prepare('SELECT member_id FROM chat_live_members WHERE conversation_id=? ORDER BY position').all(id)).map(r=>String(r.member_id))}:null;
  }
  setProfile(id:string,title:string,input:ChatConversationProfile):ChatConversation {
    if(!this.liveReady)throw new ChatError(503,'CHAT_LIVE_UPGRADE_REQUIRED');
    const profile=conversationProfile(input);
    return this.transaction(()=>{
      if(!this.conversation(id))throw new ChatError(404,'CONVERSATION_NOT_FOUND');
      if(this.unresolved(id))throw new ChatError(409,'TURN_UNRESOLVED');
      const prior=this.profile(id);
      if(prior){if(JSON.stringify(prior)!==JSON.stringify(profile))throw new ChatError(409,'MEMBERSHIP_CHANGE_NOT_ENABLED');}
      else{
        this.db.prepare('INSERT INTO chat_live_profiles VALUES (?,?)').run(id,profile.kind);
        profile.members.forEach((member,index)=>this.db.prepare('INSERT INTO chat_live_members VALUES (?,?,?)').run(id,member,index));
      }
      this.db.prepare('UPDATE chat_conversations SET title=? WHERE id=?').run(title,id);
      return this.conversation(id)!;
    });
  }
  replyMember(message:ClientMessage):string|null {
    const profile=this.profile(message.conversationId);
    if(!profile){if(message.replyToMemberId)throw new ChatError(409,'CONVERSATION_PROFILE_REQUIRED');return null;}
    const member=message.replyToMemberId??(profile.kind==='private'?profile.members[0]:null);
    if(!member||!profile.members.includes(member))throw new ChatError(403,'REPLY_MEMBER_NOT_ALLOWED');
    return member;
  }
  private speaker(turnId:string):string|null{return this.liveReady?String(this.db.prepare('SELECT member_id FROM chat_live_turn_speakers WHERE turn_id=?').get(turnId)?.member_id??'')||null:null;}
  private get speakerJoin(){return this.liveReady?' LEFT JOIN chat_live_turn_speakers sp ON sp.turn_id=m.turn_id ':'';}
  private get speakerColumn(){return this.liveReady?",CASE WHEN m.role='assistant' THEN sp.member_id ELSE NULL END AS speakerId":'';}
  private withUsage(rows:ChatMessage[]):ChatMessage[]{if(!rows.length)return rows;const ids=[...new Set(rows.map(m=>m.turnId))];const calls=this.db.prepare("SELECT turn_id,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM chat_attempts WHERE status='succeeded' AND turn_id IN ("+ids.map(()=>'?').join(',')+") ORDER BY rowid").all(...ids);const byTurn=new Map(calls.map(a=>[String(a.turn_id),{cacheRateApplicable:a.provider==='deepseek',inputTokens:a.input_tokens as number|null,outputTokens:a.output_tokens as number|null,cacheReadTokens:a.cache_read_tokens as number|null,cacheWriteTokens:a.cache_write_tokens as number|null}]));return rows.map(m=>m.role==='assistant'?{...m,usage:(m.revision??1)===1?byTurn.get(m.turnId):undefined}:m);}
  turnMessages(turnId:string):ChatMessage[]{
    return projectSegments(this.db,this.withUsage(this.db.prepare('SELECT m.id,m.turn_id AS turnId,m.message_seq AS messageSeq,m.role,COALESCE(s.content,m.content) AS content,m.created_at AS createdAt,COALESCE(s.revision,1) AS revision'+this.speakerColumn+' FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id'+this.speakerJoin+' WHERE m.turn_id=? AND s.deleted_at IS NULL ORDER BY m.message_seq').all(turnId) as unknown as ChatMessage[]));
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createConversation(id:string,title:string,input?:ChatConversationProfile):ChatConversation {
    const profile=input?conversationProfile(input):null;
    if(profile&&!this.liveReady)throw new ChatError(503,'CHAT_LIVE_UPGRADE_REQUIRED');
    return this.transaction(()=>{
      if(conversationDeleted(this.db,id))throw new ChatError(409,'CONVERSATION_DELETED');
      const existing=this.conversation(id);
      if(existing){if(existing.title!==title||profile&&JSON.stringify(existing.profile)!==JSON.stringify(profile))throw new ChatError(409,'CONVERSATION_ID_CONFLICT');return existing;}
      this.db.prepare('INSERT INTO chat_conversations(id,title,created_at) VALUES (?,?,?)').run(id,title,new Date().toISOString());
      if(profile){this.db.prepare('INSERT INTO chat_live_profiles VALUES (?,?)').run(id,profile.kind);profile.members.forEach((member,index)=>this.db.prepare('INSERT INTO chat_live_members VALUES (?,?,?)').run(id,member,index));}
      return this.conversation(id)!;
    });
  }
  conversation(id:string):ChatConversation|undefined {
    if(conversationDeleted(this.db,id))return undefined;
    const row=this.db.prepare('SELECT id,title,created_at AS createdAt FROM chat_conversations WHERE id=?').get(id) as unknown as ChatConversation|undefined;
    return row?{...row,profile:this.profile(id)}:undefined;
  }
  conversations(before:number,limit:number,query=''){
    const ready=uiReady(this.db),cursor=ready?'c.rowid+CASE WHEN u.pinned=1 THEN 281474976710656 ELSE 0 END':'c.rowid';
    const join=ready?' LEFT JOIN app_ui_conversations u ON u.conversation_id=c.id ':'';
    const visible=ready?' AND u.deleted_at IS NULL':'';
    const rows=this.db.prepare('SELECT c.id,c.title,c.created_at AS createdAt,'+cursor+' AS cursor'+(ready?',COALESCE(u.pinned,0) AS pinned':'')+' FROM chat_conversations c'+join+' WHERE '+cursor+'<?'+visible+" AND (?='' OR instr(lower(c.title),lower(?))>0 OR EXISTS(SELECT 1 FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.conversation_id=c.id AND s.deleted_at IS NULL AND instr(lower(COALESCE(s.content,m.content)),lower(?))>0)) ORDER BY cursor DESC LIMIT ?").all(before,query,query,query,limit) as unknown as (ChatConversation&{cursor:number})[];
    if(!rows.length)return [];
    if(!this.liveReady)return rows.map(row=>({...row,profile:null}));
    // One bounded metadata query for the page, not one network request per room.
    const profiles=this.db.prepare('SELECT p.conversation_id,p.kind,m.member_id FROM chat_live_profiles p JOIN chat_live_members m ON m.conversation_id=p.conversation_id WHERE p.conversation_id IN ('+rows.map(()=>'?').join(',')+') ORDER BY m.position').all(...rows.map(r=>r.id));
    const byId=new Map<string,ChatConversationProfile>();for(const p of profiles){const id=String(p.conversation_id),profile=byId.get(id)??{kind:p.kind as ChatConversationProfile['kind'],members:[]};profile.members.push(String(p.member_id));byId.set(id,profile);}
    return rows.map(row=>({...row,...(ready?{pinned:!!row.pinned}:{}),profile:byId.get(row.id)??null}));
  }
  turn(id: string): ChatTurn {
    const row = this.db.prepare('SELECT id,conversation_id AS conversationId,client_message_id AS clientMessageId,turn_seq AS turnSeq,status,error_code AS errorCode,created_at AS createdAt FROM chat_turns WHERE id=?').get(id);
    if(!row||conversationDeleted(this.db,String(row.conversationId))) throw new ChatError(404,'TURN_NOT_FOUND'); return {...row,replyToMemberId:this.speaker(id)} as unknown as ChatTurn;
  }
  messages(conversationId: string, before: number, limit: number,raw=false): ChatMessage[] {
    if(!this.conversation(conversationId)) throw new ChatError(404,'CONVERSATION_NOT_FOUND');
    const rows=this.withUsage((this.db.prepare('SELECT m.id,m.turn_id AS turnId,m.message_seq AS messageSeq,m.role,COALESCE(s.content,m.content) AS content,m.created_at AS createdAt,COALESCE(s.revision,1) AS revision'+this.speakerColumn+' FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id'+this.speakerJoin+' WHERE m.conversation_id=? AND m.message_seq<? AND s.deleted_at IS NULL ORDER BY m.message_seq DESC LIMIT ?').all(conversationId,before,limit) as unknown as ChatMessage[]).reverse());
    return raw?rows:projectSegments(this.db,rows);
  }
  unresolved(conversationId: string): ChatTurn | null {
    const row = this.db.prepare("SELECT id FROM chat_turns WHERE conversation_id=? AND status!='succeeded'").get(conversationId);
    return row ? this.turn(String(row.id)) : null;
  }
  findOriginal(message: ClientMessage): ChatTurn | null {
    const row = this.db.prepare('SELECT id,content_hash FROM chat_turns WHERE conversation_id=? AND client_message_id=?').get(message.conversationId,message.clientMessageId);
    if(!row) return null;
    if(batchReady(this.db)){const batch=this.db.prepare('SELECT request_hash FROM chat_live_submissions WHERE turn_id=?').get(row.id);if(batch&&(!message.segments||batch.request_hash!==batchHash([message.segments,message.replyToMemberId??null])))throw new ChatError(409,'BATCH_ID_CONFLICT');if(message.segments&&!batch)throw new ChatError(409,'MESSAGE_ID_CONFLICT');}
    if(row.content_hash !== hashContent(message.content)||this.speaker(String(row.id))!==this.replyMember(message)) throw new ChatError(409,'MESSAGE_ID_CONFLICT');
    return this.turn(String(row.id));
  }
  async accept(message: ClientMessage): Promise<DurableMessageReceipt> {
    return this.transaction(() => {
      const existing = this.findOriginal(message);
      if(message.segments&&!existing)validateSegments(this.db,message.segments,message.conversationId);
      if(existing) return this.receipt(existing);
      if(!this.conversation(message.conversationId)) throw new ChatError(404,'CONVERSATION_NOT_FOUND');
      if(this.unresolved(message.conversationId)) throw new ChatError(409,'TURN_UNRESOLVED');
      const seq = Number(this.db.prepare('SELECT next_turn_seq FROM chat_conversations WHERE id=?').get(message.conversationId)!.next_turn_seq);
      if(!Number.isSafeInteger(seq) || seq > Math.floor((Number.MAX_SAFE_INTEGER-2)/2)) throw new ChatError(503,'SEQUENCE_EXHAUSTED');
      const member=this.replyMember(message);
      const now = new Date().toISOString(), turnId = randomUUID(), messageId = randomUUID();
      this.db.prepare("INSERT INTO chat_turns(id,conversation_id,client_message_id,content_hash,turn_seq,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)").run(turnId,message.conversationId,message.clientMessageId,hashContent(message.content),seq,now,now);
      if(member)this.db.prepare('INSERT INTO chat_live_turn_speakers VALUES (?,?,?)').run(turnId,message.conversationId,member);
      this.db.prepare('UPDATE chat_conversations SET next_turn_seq=next_turn_seq+1 WHERE id=?').run(message.conversationId);
      insertSegments(this.db,message,turnId,messageId);
      this.appendMessage({id:messageId,conversationId:message.conversationId,turnId,messageSeq:seq*2-1,role:'user',content:message.content,createdAt:now});
      return {messageId,turnId,turnSeq:seq,durable:true};
    });
  }
  message(id: string): ChatMessage | null {
    return this.db.prepare('SELECT m.id,m.turn_id AS turnId,m.message_seq AS messageSeq,m.role,COALESCE(s.content,m.content) AS content,m.created_at AS createdAt,COALESCE(s.revision,1) AS revision'+this.speakerColumn+' FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id'+this.speakerJoin+' WHERE m.id=? AND s.deleted_at IS NULL').get(id) as unknown as ChatMessage | undefined ?? null;
  }
  receipt(turn: ChatTurn): DurableMessageReceipt {
    const message = this.db.prepare("SELECT id FROM chat_messages WHERE turn_id=? AND role='user'").get(turn.id)!;
    return {messageId:String(message.id),turnId:turn.id,turnSeq:turn.turnSeq,durable:true};
  }
  appendMessage(message: ChatMessage & {conversationId:string}) {
    const digest = hashContent(message.content);
    this.db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?,?)').run(message.id,message.conversationId,message.turnId,message.messageSeq,message.role,message.content,digest,message.createdAt);
    appendEvent(this.db,'chat.message.created',{...message,...(isBatchParentPayload(this.db,message.id)),...(message.role==='assistant'&&this.speaker(message.turnId)?{speakerId:this.speaker(message.turnId)}:{}),...(this.profile(message.conversationId)?{conversation:{title:this.conversation(message.conversationId)!.title,...this.profile(message.conversationId)}}:{}),contentHash:digest});
  }
}

function isBatchParentPayload(db:DatabaseSync,id:string){const parts=segmentSnapshot(db,id);return parts.length?{segments:parts}:{};}
