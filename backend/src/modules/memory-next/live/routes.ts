import {Router} from 'express';
import {objectBody,text,ValidationError,pageNumber} from '../../../shared/validation.js';
import {LiveMemoryRuntime,eventPayload,stringIds} from './runtime.js';
import {MemoryError} from './store.js';
export function liveMemoryRouter(memory:LiveMemoryRuntime){
 const router=Router();
 router.get('/status',(req,res)=>{res.json(memory.status());});
 router.use((_req,_res,next)=>{memory.require();next();});
 const context=(q:Record<string,unknown>)=>memory.store.context(text(q.conversationId,'conversationId',100),text(q.actor,'actor',100));
 router.get('/scope',(req,res)=>{
  const id=text(req.query.conversationId,'conversationId',100);const actors=memory.store.actors(id);res.json({actors,realm:memory.db.prepare('SELECT realm FROM memory_live_scopes WHERE conversation_id=?').get(id)?.realm??'real',contexts:actors.map(actor=>memory.store.context(id,actor))});
 });
 router.put('/scope',(req,res)=>{const b=objectBody(req.body);if(typeof b.allowed!=='boolean'||!['real','game','simulation'].includes(String(b.realm)))throw new ValidationError('Invalid scope');memory.store.setScope(text(b.conversationId,'conversationId',100),text(b.actor,'actor',100),b.allowed,b.realm as 'real'|'game'|'simulation');memory.invalidate();res.json({changed:true});});
 router.get('/entries',(req,res)=>{const c=context(req.query);const q=req.query.q===undefined||req.query.q===''?'':text(req.query.q,'q',1000);res.json(memory.store.search(c,q,{browse:!q,experiences:req.query.experiences==='true',limit:20,before:req.query.before?pageNumber(req.query.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER):undefined,beforeExperience:req.query.beforeExperience?pageNumber(req.query.beforeExperience,Number.MAX_SAFE_INTEGER,'beforeExperience',1,Number.MAX_SAFE_INTEGER):undefined}));});
 router.get('/sources/:id',(req,res)=>{
  const c=context(req.query),e=memory.store.evidence(String(req.params.id),c.actor);if(!e||!memory.store.origins(c).some(o=>o.conversationId===e.conversationId))throw new MemoryError(404,'MEMORY_SOURCE_NOT_AVAILABLE');
  res.json({id:e.source.id,revision:e.source.version,content:e.text,role:e.role,occurredAt:e.source.occurredAt});
 });
 router.get('/entries/:id',(req,res)=>{const c=context(req.query),row=memory.store.entry(String(req.params.id)),view=row&&memory.store.view(row,c);if(!view)throw new MemoryError(404,'MEMORY_NOT_AVAILABLE');res.json(view);});
 router.put('/entries/:id',(req,res)=>{const b=objectBody(req.body),c=context(b);const result=memory.store.correct(c,String(req.params.id),text(b.version,'version',100),text(b.text,'text',8000),text(b.requestId,'requestId',100));memory.invalidate();res.json(result);});
 router.delete('/entries/:id',(req,res)=>{const b=objectBody(req.body),c=context(b);memory.store.withdraw(c,String(req.params.id),text(b.version,'version',100));memory.invalidate();res.json({withdrawn:true,rawMessagesPreserved:true});});
 router.get('/events',(req,res)=>res.json({items:memory.store.events(context(req.query))}));
 router.post('/events/:id/revisions',(req,res)=>{const b=objectBody(req.body),c=context(b);const result={id:memory.store.transaction(()=>memory.store.reviseEvent(c,String(req.params.id),b.parentId===null?null:text(b.parentId,'parentId',100),stringIds(b.entryIds),eventPayload(b),'user'))};memory.invalidate();res.json(result);});
 router.post('/events/:id/approve',(req,res)=>{
  const b=objectBody(req.body),c=context(b),event=memory.store.events(c,{id:String(req.params.id)}).find(e=>e.id===req.params.id),revision=event?.revisions.find(r=>r.id===b.revisionId&&r.status==='pending');
  if(!event||!revision)throw new MemoryError(404,'EVENT_PROPOSAL_NOT_AVAILABLE');
  const current=event.revisions.filter(r=>r.status==='active').at(-1);
  if((current?.id??null)!==revision.parentId)throw new MemoryError(409,'EVENT_VERSION_CONFLICT');
  memory.db.prepare("UPDATE memory_live_event_revisions SET status='active' WHERE id=? AND status='pending'").run(revision.id);memory.invalidate();res.json({approved:true});
 });
 router.get('/jobs',(req,res)=>{const c=context(req.query);res.json({items:memory.db.prepare('SELECT id,status,channel,error_code,created_at FROM memory_live_jobs WHERE conversation_id=? AND actor=? ORDER BY rowid DESC LIMIT 50').all(c.conversationId,c.actor)});});
 router.post('/backfill',(req,res)=>{const b=objectBody(req.body),c=context(b);res.json({...memory.backfill(c,b.before===undefined?undefined:pageNumber(b.before,Number.MAX_SAFE_INTEGER,'before',1,Number.MAX_SAFE_INTEGER)),notice:'仅排队获准历史；后台整理受预算约束，调用可能计费。'});});
 router.post('/jobs/retry',(req,res)=>{const b=objectBody(req.body),c=context(b);memory.retry(c,text(b.id,'id',200),b.acknowledgeUnknown===true);res.json({queued:true});});
 router.use((e:unknown,_req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>{if(e instanceof MemoryError)res.status(e.status).json({error:e.code});else next(e);});return router;
}
