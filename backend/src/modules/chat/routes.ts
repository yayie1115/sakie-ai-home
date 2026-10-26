import {currentMessage,messageVersions,selectMessageVersion} from './live-operations.js';
import {batchReady,projectSegments,reviseSegment,segmentSource} from './live-batch.js';
import {chatParticipants,conversationProfile} from './participants.js';
import { reviseMessage } from '../sync/mutations.js';
import { Router } from 'express';
import { objectBody, pageNumber, text, ValidationError } from '../../shared/validation.js';
import { ChatError } from './store.js';
import type { ChatService } from './service.js';
function uuid(value: unknown, field: string): string {
  if(typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new ValidationError('Invalid ' + field);
  return value.toLowerCase();
}
export function chatRouter(service: ChatService, reauthorize?: (req: import('express').Request) => unknown, messageChanged?:(id:string)=>void,permissionsChanged?:()=>void) {
  const router = Router(), store = service.store;
  router.get('/config',(_req,res) => res.json({configured:service.configured,model:service.configured?service.config.model:null,maxMessageChars:service.config.maxMessageChars,memoryStatus:'unavailable',participants:chatParticipants,conversationProfilesEnabled:store.liveReady,batchEnabled:batchReady(store.db),operationsEnabled:service.operations.ready,versionsEnabled:true,groupScheduling:'manual-single-reply',personaConfigured:false}));
  router.get('/conversations',(req,res) => {
    const limit = pageNumber(req.query.limit,20,'limit',1,100), before = pageNumber(req.query.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER);
    const rows = store.conversations(before,limit+1,req.query.q===undefined||req.query.q===''?'':text(req.query.q,'q',100)); const items = rows.slice(0,limit);
    res.json({items,nextBefore:rows.length>limit?items.at(-1)!.cursor:null});
  });
  router.get('/conversations/:id',(req,res) => {
    const conversation=store.conversation(uuid(req.params.id,'conversationId'));
    if(!conversation)throw new ChatError(404,'CONVERSATION_NOT_FOUND');
    res.json(conversation);
  });
  router.post('/conversations',(req,res) => {
    const body = objectBody(req.body);
    res.status(201).json(store.createConversation(uuid(body.id,'id'),text(body.title??'新对话','title',100),conversationProfile(body)));
  });
  router.put('/conversations/:id/profile',(req,res)=>{
    const body=objectBody(req.body);
    res.json(store.setProfile(uuid(req.params.id,'conversationId'),text(body.title,'title',100),conversationProfile(body)));
  });
  router.put('/conversations/:id/members',(req,res)=>{
    const b=objectBody(req.body);if(!Array.isArray(b.expectedMembers)||!b.expectedMembers.every(x=>typeof x==='string')||!Array.isArray(b.members))throw new ValidationError('Invalid members');
    const result=store.setGroupMembers(uuid(req.params.id,'conversationId'),b.expectedMembers as string[],b.members as string[]);permissionsChanged?.();res.json(result);
  });
  router.get('/conversations/:id/messages',(req,res) => {
    const id = uuid(req.params.id,'conversationId'), limit = pageNumber(req.query.limit,50,'limit',1,100);
    const before = pageNumber(req.query.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER);
    const rows = store.messages(id,before,limit+1,true); const hasMore = rows.length>limit; const items = hasMore ? rows.slice(1) : rows;
    res.json({items:projectSegments(store.db,items),nextBefore:hasMore?items[0].messageSeq:null,unresolvedTurn:store.unresolved(id)});
  });
  router.post('/conversations/:id/batches',async(req,res)=>{
    const b=objectBody(req.body),id=uuid(req.params.id,'conversationId');if(!batchReady(store.db))throw new ChatError(503,'BATCH_UPGRADE_REQUIRED');if(!Array.isArray(b.segments)||b.segments.length<1||b.segments.length>16)throw new ValidationError('Invalid segments');
    const segments=b.segments as import('@sakie/contracts').LiveChatSegment[];for(const p of segments)text(p?.content,'content',service.config.maxMessageChars);if(segments.reduce((n,p)=>n+p.content.length+(p.quote?.selectedText?.length??0)+30,0)>service.config.maxMessageChars)throw new ValidationError('Batch context too long');const content=segments.map(p=>p.content).join('\n\n');text(content,'batch content',service.config.maxMessageChars);
    const submissionId=uuid(b.submissionId,'submissionId');let result;try{result=await service.send({conversationId:id,clientMessageId:submissionId,content,segments,...(b.replyToMemberId!==undefined?{replyToMemberId:text(b.replyToMemberId,'replyToMemberId',100)}:{})});}catch(e){if(e instanceof Error&&'status' in e&&['INVALID_SEGMENTS','INVALID_SEGMENT','SEGMENT_ID_CONFLICT','QUOTE_SCOPE_DENIED','QUOTE_NOT_CURRENT','BATCH_UPGRADE_REQUIRED'].includes(e.message))throw new ChatError(Number(e.status),e.message);throw e;}res.status(202).json({...result,submissionId,conversationId:id,bubbleIds:segments.map(p=>p.id),messages:store.turnMessages(result.turn.id)});
  });
  router.get('/conversations/:id/batch-receipts/:submissionId',(req,res)=>{const id=uuid(req.params.id,'conversationId'),submissionId=uuid(req.params.submissionId,'submissionId');if(!batchReady(store.db))throw new ChatError(503,'BATCH_UPGRADE_REQUIRED');if(!store.conversation(id))throw new ChatError(404,'CONVERSATION_NOT_FOUND');const row=store.db.prepare('SELECT turn_id FROM chat_live_submissions WHERE id=? AND conversation_id=?').get(submissionId,id);if(!row)throw new ChatError(404,'RECEIPT_NOT_FOUND');const turn=store.turn(String(row.turn_id)),messages=store.turnMessages(turn.id);res.json({...store.receipt(turn),turn,submissionId,conversationId:id,bubbleIds:store.db.prepare('SELECT p.id FROM chat_live_segments p JOIN chat_live_submissions s ON s.parent_id=p.parent_id WHERE s.id=? ORDER BY p.position').all(submissionId).map(x=>x.id),messages});});
  // Resolve a lost acknowledgement without replaying a write or starting a model call.
  router.get('/conversations/:id/receipts/:clientMessageId',(req,res) => {
    const id=uuid(req.params.id,'conversationId'), clientId=uuid(req.params.clientMessageId,'clientMessageId');
    if(!store.conversation(id)) throw new ChatError(404,'CONVERSATION_NOT_FOUND');
    const row=store.db.prepare('SELECT id FROM chat_turns WHERE conversation_id=? AND client_message_id=?').get(id,clientId);
    if(!row) throw new ChatError(404,'RECEIPT_NOT_FOUND');
    const turn=store.turn(String(row.id));
    res.json({turn,messages:store.turnMessages(turn.id),...store.receipt(turn)});
  });
  router.post('/conversations/:id/messages',async(req,res) => {
    const body = objectBody(req.body);
    text(body.content,'content',service.config.maxMessageChars);
    const started=performance.now();
    const result = await service.send({conversationId:uuid(req.params.id,'conversationId'),clientMessageId:uuid(body.clientMessageId,'clientMessageId'),content:body.content as string,...(body.replyToMemberId!==undefined?{replyToMemberId:text(body.replyToMemberId,'replyToMemberId',100)}:{})});
    res.setHeader('Server-Timing','accept;dur='+(performance.now()-started).toFixed(1));
    res.status(202).json(result);
  });
  for(const method of ['patch','delete'] as const) router[method]('/messages/:id',(req,res)=>{
    const body=objectBody(req.body);if(!Number.isSafeInteger(body.baseRevision)||Number(body.baseRevision)<1)throw new ValidationError('Invalid baseRevision');
    if(method==='patch')text(body.content,'content',100000);
    const id=uuid(req.params.id,'messageId');const result=reviseSegment(store.db,id,Number(body.baseRevision),uuid(body.requestId,'requestId'),method==='delete'?null:body.content as string)??reviseMessage(store.db,id,Number(body.baseRevision),uuid(body.requestId,'requestId'),method==='delete'?null:body.content as string);messageChanged?.(id);res.json(result);
  });
  router.get('/conversations/:id/messages/:messageId',(req,res)=>{
    const conversationId=uuid(req.params.id,'conversationId'),id=uuid(req.params.messageId,'messageId'),m=currentMessage(store,id);
    if(m.conversationId!==conversationId)throw new ChatError(404,'MESSAGE_NOT_AVAILABLE');
    const item=segmentSource(store.db,id)?projectSegments(store.db,[store.message(m.parentId)!]).find(p=>p.id===id):store.message(id);
    res.json({item});
  });
  router.get('/messages/:id/versions',(req,res)=>res.json(messageVersions(store,uuid(req.params.id,'messageId'))));
  router.post('/messages/:id/versions/select',(req,res)=>{
    const b=objectBody(req.body);for(const k of ['baseRevision','revision'])if(!Number.isSafeInteger(b[k])||Number(b[k])<1)throw new ValidationError('Invalid '+k);
    const id=uuid(req.params.id,'messageId'),result=selectMessageVersion(store,id,Number(b.baseRevision),Number(b.revision),uuid(b.requestId,'requestId'));messageChanged?.(id);res.json(result);
  });
  router.post('/messages/:id/regenerations',(req,res)=>{
    const b=objectBody(req.body);if(!Number.isSafeInteger(b.baseRevision)||Number(b.baseRevision)<1||!['bubble','turn'].includes(String(b.scope)))throw new ValidationError('Invalid generation');
    res.status(202).json(service.regenerate(uuid(b.requestId,'requestId'),uuid(req.params.id,'messageId'),b.scope as 'bubble'|'turn',Number(b.baseRevision)));
  });
  router.get('/conversations/:id/generations',(req,res)=>{
    const id=uuid(req.params.id,'conversationId');if(!store.conversation(id))throw new ChatError(404,'CONVERSATION_NOT_FOUND');if(!service.operations.ready){res.json({items:[]});return;}
    res.json({items:store.db.prepare('SELECT id FROM chat_live_generations WHERE conversation_id=? ORDER BY rowid DESC LIMIT 10').all(id).map(r=>service.operations.view(String(r.id)))});
  });
  router.get('/generations/:id',(req,res)=>{if(!service.operations.ready)throw new ChatError(503,'OPS_UPGRADE_REQUIRED');res.json(service.operations.view(uuid(req.params.id,'generationId')));});
  router.post('/generations/:id/cancel',(req,res)=>{if(!service.operations.ready)throw new ChatError(503,'OPS_UPGRADE_REQUIRED');res.json(service.cancelGeneration(uuid(req.params.id,'generationId')));});
  router.get('/turns/:id',async(req,res) => {
    const id = uuid(req.params.id,'turnId');
    store.turn(id); // Validate before installing a listener.
    const after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || after.length > 200)) throw new ValidationError('Invalid progress cursor');
    if (typeof after === 'string') {
      const controller = new AbortController();
      const close = () => controller.abort(); res.on('close',close);
      try { await service.waitForChange(id,after,controller.signal); }
      finally { res.off('close',close); }
      if (controller.signal.aborted) return;
    }
    reauthorize?.(req);
    const turn = store.turn(id);
    const messages = after && ['queued','running'].includes(turn.status) ? [] : store.turnMessages(turn.id);
    // Additive volatile progress; only committed messages above are archival sources.
    res.json({turn,messages,updateCursor:service.cursor(id),progress:turn.status==='running'?service.progress(turn.id):null,timings:service.timing(turn.id)});
  });
  router.post('/turns/:id/retry',(req,res) => {
    const body = objectBody(req.body);
    res.status(202).json({turn:service.retry(uuid(req.params.id,'turnId'),uuid(body.retryId,'retryId'),body.acknowledgeUnknown===true)});
  });
  router.use((error: unknown,_req: import('express').Request,res: import('express').Response,next: import('express').NextFunction) => {
    if(error instanceof ChatError) res.status(error.status).json({error:error.code}); else next(error);
  });
  return router;
}
