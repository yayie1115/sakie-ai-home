import type { ChatConversationProfile, ChatParticipant } from '@sakie/contracts';
import { ValidationError } from '../../shared/validation.js';
/** Identity/display metadata only. No persona, prompt, model routing or autonomous policy. */
export const chatParticipants: readonly ChatParticipant[] = Object.freeze([
  {id:'yan',name:'谢亦言'},{id:'mu',name:'慕遥'},{id:'xing',name:'迟星'},{id:'lan',name:'岚序'},
]);
export function conversationProfile(value: unknown): ChatConversationProfile {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Conversation profile required');
  const p=value as Record<string,unknown>;
  if(!['private','group'].includes(String(p.kind))||!Array.isArray(p.members)||!p.members.length||p.members.length>chatParticipants.length||p.members.some(id=>typeof id!=='string'||!chatParticipants.some(a=>a.id===id))||new Set(p.members).size!==p.members.length||p.kind==='private'&&p.members.length!==1)throw new ValidationError('Invalid conversation kind or members');
  return {kind:p.kind as ChatConversationProfile['kind'],members:[...p.members] as string[]};
}
