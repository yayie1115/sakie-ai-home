/** Trusted authorization wrapper around the read-only v4 Chat projection.
 * The old reader's actorIds parameter is NOT an authorization mechanism.
 */
import type {DatabaseSync} from 'node:sqlite';
import {readChatV4Sources, type ChatV4Result} from './chat-v4-reader.js';

export interface ParticipantGrant {
  conversationId: string;
  actorId: string;
  status: 'allowed' | 'denied' | 'unknown';
  grantRevision: string;
}
export interface ParticipantGrantResolver {
  resolve(conversationId:string, actorId:string): ParticipantGrant;
}
export function readAuthorizedChatV4Sources(db:DatabaseSync, input:{
  conversationId:string; actorId:string; beforeSeq:number; limit:number;
}, grants:ParticipantGrantResolver):ChatV4Result {
  if(!input.actorId?.trim()||!input.conversationId?.trim())return {status:'invalid_scope',sources:[],nextBeforeSeq:null};
  // In contrast to the raw reader, only a trusted resolver may grant access.
  const decision=grants.resolve(input.conversationId,input.actorId);
  if(decision.conversationId!==input.conversationId||decision.actorId!==input.actorId||decision.status!=='allowed'||!decision.grantRevision?.trim()) {
    return {status:'invalid_scope',sources:[],nextBeforeSeq:null};
  }
  return readChatV4Sources(db,{conversationId:input.conversationId,actorIds:[input.actorId],beforeSeq:input.beforeSeq,limit:input.limit});
}
