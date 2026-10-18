/** Final-submit transport: persist immutable request BEFORE HTTP; retain on unknown outcome. */
import type { V11PendingBubble, V11Submission, V11SubmissionReceipt } from '@sakie/contracts';
export interface SubmissionPersistence { read():V11Submission|null; write(request:V11Submission):void; clear():void; }
export class DefinitiveSubmissionRejection extends Error {}
export class V11SubmissionClient {
 private inFlight:Promise<V11SubmissionReceipt>|null=null;
 constructor(private readonly send:(request:V11Submission)=>Promise<V11SubmissionReceipt>,private readonly storage:SubmissionPersistence){}
 pending(){return this.storage.read();}
 /** Call only AFTER the composer without acknowledged bubbles is durably saved. */
 confirm(receipt:V11SubmissionReceipt){const request=this.storage.read();if(!request||request.submissionId!==receipt.submissionId||request.conversationId!==receipt.conversationId)throw Error('确认对象不匹配');this.storage.clear();}
 submit(conversationId:string,bubbles:V11PendingBubble[]):Promise<V11SubmissionReceipt>{
  const previous=this.storage.read();
  if(previous&&(previous.conversationId!==conversationId||JSON.stringify(previous.bubbles)!==JSON.stringify(bubbles)))return Promise.reject(Error('待确认提交必须使用原快照重试'));
  if(this.inFlight)return this.inFlight;
  const request:V11Submission=previous??{schemaVersion:1,submissionId:crypto.randomUUID(),conversationId,bubbles:structuredClone(bubbles)};
  try{this.storage.write(request);}catch{return Promise.reject(Error('无法持久保存提交编号，已停止发送'));}
  const run=Promise.resolve().then(()=>this.send(structuredClone(request))).then(receipt=>{
   if(receipt.durable!==true||receipt.conversationId!==request.conversationId||receipt.submissionId!==request.submissionId
    ||JSON.stringify(receipt.bubbleIds)!==JSON.stringify(request.bubbles.map(b=>b.id))||!receipt.messageId||!receipt.turnId||!Number.isSafeInteger(receipt.turnSeq)||receipt.turnSeq<1
    ||receipt.turn?.id!==receipt.turnId||receipt.turn.conversationId!==request.conversationId||receipt.turn.clientMessageId!==request.submissionId
    ||!['queued','running','succeeded','failed','unknown'].includes(receipt.turn.status))throw Error('服务端持久回执不匹配，保留原提交快照');
   return receipt;
  }).catch(error=>{if(error instanceof DefinitiveSubmissionRejection)this.storage.clear();throw error;}).finally(()=>{this.inFlight=null;});this.inFlight=run;return run;
 }
}
