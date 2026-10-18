/** Not mounted by app.ts. Never accepts a production database or model provider. */
import { basename, dirname, join } from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import { Router, type ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { V11History, V11SubmissionReceipt } from '@sakie/contracts';
import type { AuthService } from '../../auth/service.js';
import type { ChatService } from '../service.js';
import { ChatError } from '../store.js';
import { V11LabStore } from './store.js';
import { decodeSubmission, encodeSubmission, validateSubmission } from './codec.js';
export const labMarker='sakie-chat-v11-synthetic-only-v1';
export function assertSyntheticDatabase(db:DatabaseSync):void {
 const file=String(db.prepare('PRAGMA database_list').get()!.file);
 if(!file)return; // New :memory: fixtures only.
 if(basename(file)!=='chat-v11-synthetic.db'||!basename(dirname(file)).startsWith('chat-v11-lab-')
  ||lstatSync(file).isSymbolicLink()||lstatSync(dirname(file)).isSymbolicLink()
  ||readFileSync(join(dirname(file),'synthetic-marker.txt'),'utf8')!==labMarker)throw Error('SYNTHETIC_DATABASE_REQUIRED');
}
export function createV11LabRouter(chat:ChatService,auth:AuthService,conversationId:string) {
 assertSyntheticDatabase(chat.store.db);
 if(!(chat.store instanceof V11LabStore))throw Error('SYNTHETIC_ADMISSION_GUARD_REQUIRED');
 if(chat.config.apiKey||chat.config.model||!chat.configured)throw Error('SYNTHETIC_PROVIDER_REQUIRED');
 const router=Router(),store=chat.store;
 router.use((req,_res,next)=>{try{auth.require(req);next();}catch(e){next(e);}});
 router.get('/capabilities',(_req,res)=>res.json({synthetic:true,schemaVersion:1,conversationId,capabilities:['text-batch-compat']}));
 router.post('/conversations/:id/submit',async(req,res)=>{
  const s=validateSubmission(req.body,chat.config.maxMessageChars);
  if(req.params.id!==conversationId||s.conversationId!==conversationId)throw new ChatError(403,'LAB_CONVERSATION_DENIED');
  const message={conversationId,clientMessageId:s.submissionId,content:encodeSubmission(s)};
  // Quote revisions and bubble UUID uniqueness are checked inside inherited accept()'s transaction.
  const result=await chat.send(message);
  const receipt:V11SubmissionReceipt={...result,submissionId:s.submissionId,conversationId,bubbleIds:s.bubbles.map(b=>b.id)};
  res.status(202).json(receipt);
 });
 router.get('/history',(_req,res)=>{
  const messages=store.messages(conversationId,Number.MAX_SAFE_INTEGER,100);
  const bubbles:V11History['bubbles']=messages.flatMap(m=>{
   const envelope=m.role==='user'?decodeSubmission(m.content):null;
   const body={turnId:m.turnId,sourceMessageId:m.id,sourceRevision:m.revision??1,createdAt:m.createdAt};
   return envelope?envelope.bubbles.map((b,position)=>({...body,id:b.id,role:m.role,content:b.content,position,...(b.quote?{quote:b.quote}:{})})):[{...body,id:m.id,role:m.role,content:m.content,position:0}];
  });res.json({conversationId,bubbles,unresolvedTurn:store.unresolved(conversationId)} satisfies V11History);
 });
 const errors:ErrorRequestHandler=(e,_req,res,next)=>e instanceof ChatError?res.status(e.status).json({error:e.code}):next(e);router.use(errors);
 return router;
}
