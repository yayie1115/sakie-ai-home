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
export function chatRouter(service: ChatService) {
  const router = Router(), store = service.store;
  router.get('/config',(_req,res) => res.json({configured:service.configured,model:service.configured?service.config.model:null,maxMessageChars:service.config.maxMessageChars,memoryStatus:'unavailable',participants:chatParticipants,conversationProfilesEnabled:store.liveReady,groupScheduling:'manual-single-reply',personaConfigured:false}));
  router.get('/conversations',(req,res) => {
    const limit = pageNumber(req.query.limit,20,'limit',1,100), before = pageNumber(req.query.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER);
    const rows = store.conversations(before,limit+1); const items = rows.slice(0,limit);
    res.json({items,nextBefore:rows.length>limit?items.at(-1)!.cursor:null});
  });
  router.post('/conversations',(req,res) => {
    const body = objectBody(req.body);
    res.status(201).json(store.createConversation(uuid(body.id,'id'),text(body.title??'新对话','title',100),conversationProfile(body)));
  });
  router.put('/conversations/:id/profile',(req,res)=>{
    const body=objectBody(req.body);
    res.json(store.setProfile(uuid(req.params.id,'conversationId'),text(body.title,'title',100),conversationProfile(body)));
  });
  router.get('/conversations/:id/messages',(req,res) => {
    const id = uuid(req.params.id,'conversationId'), limit = pageNumber(req.query.limit,50,'limit',1,100);
    const before = pageNumber(req.query.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER);
    const rows = store.messages(id,before,limit+1); const hasMore = rows.length>limit; const items = hasMore ? rows.slice(1) : rows;
    res.json({items,nextBefore:hasMore?items[0].messageSeq:null,unresolvedTurn:store.unresolved(id)});
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
    res.json(reviseMessage(store.db,uuid(req.params.id,'messageId'),Number(body.baseRevision),uuid(body.requestId,'requestId'),method==='delete'?null:body.content as string));
  });
  router.get('/turns/:id',(req,res) => {
    const turn = store.turn(uuid(req.params.id,'turnId'));
    const messages = store.turnMessages(turn.id);
    // Additive volatile progress; only committed messages above are archival sources.
    res.json({turn,messages,progress:turn.status==='running'?service.progress(turn.id):null,timings:service.timing(turn.id)});
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
