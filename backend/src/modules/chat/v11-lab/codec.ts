/** Synthetic-only codec: one legacy message is an atomic, lossless multi-bubble envelope. */
import type { V11Submission, V11PendingBubble } from '@sakie/contracts';
import { ChatError } from '../store.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function record(v:unknown):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ChatError(400,'INVALID_BATCH');}
function exact(v:Record<string,unknown>,required:string[],optional:string[]=[]){if(required.some(k=>!(k in v))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw new ChatError(400,'INVALID_BATCH');}
function id(v:unknown):asserts v is string{if(typeof v!=='string'||!uuid.test(v))throw new ChatError(400,'INVALID_BATCH_ID');}
export function validateSubmission(value:unknown,maxChars:number):V11Submission {
 record(value);exact(value,['schemaVersion','submissionId','conversationId','bubbles']);
 id(value.submissionId);id(value.conversationId);
 if(value.schemaVersion!==1||!Array.isArray(value.bubbles)||value.bubbles.length<1||value.bubbles.length>8)throw new ChatError(400,'INVALID_BATCH');
 const seen=new Set<string>();
 const bubbles:V11PendingBubble[]=value.bubbles.map(raw=>{
  record(raw);exact(raw,['id','revision','content'],['quote']);id(raw.id);
  if(seen.has(raw.id))throw new ChatError(400,'DUPLICATE_BUBBLE_ID');seen.add(raw.id);
  if(!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1||typeof raw.content!=='string'||!raw.content.trim()||raw.content.length>maxChars)throw new ChatError(400,'INVALID_BATCH');
  const bubble:V11PendingBubble={id:raw.id,revision:Number(raw.revision),content:raw.content};
  if(raw.quote!==undefined){const q=raw.quote;record(q);exact(q,['conversationId','messageId','revision','selectedText'],['bubbleId']);id(q.conversationId);id(q.messageId);if(q.bubbleId!==undefined)id(q.bubbleId);
   if(!Number.isSafeInteger(q.revision)||Number(q.revision)<1||typeof q.selectedText!=='string'||!q.selectedText.trim()||q.selectedText.length>maxChars)throw new ChatError(400,'INVALID_QUOTE');
   bubble.quote={conversationId:q.conversationId,messageId:q.messageId,revision:Number(q.revision),selectedText:q.selectedText,...(q.bubbleId?{bubbleId:q.bubbleId as string}:{})};
  }return bubble;
 });
 const result:V11Submission={schemaVersion:1,submissionId:value.submissionId,conversationId:value.conversationId,bubbles};
 if(encodeSubmission(result).length>maxChars)throw new ChatError(400,'BATCH_TOO_LARGE');return result;
}
export const envelopeFormat='sakie.text-bubbles.lab.v1';
export function encodeSubmission(s:V11Submission):string{return JSON.stringify({format:envelopeFormat,submission:s});}
export function decodeSubmission(content:string):V11Submission|null {
 try{const v:unknown=JSON.parse(content);record(v);exact(v,['format','submission']);if(v.format!==envelopeFormat)return null;const result=validateSubmission(v.submission,100_000);return encodeSubmission(result)===content?result:null;}catch{return null;}
}
