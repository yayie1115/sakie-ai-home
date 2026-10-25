import {conversationDeleted} from '../../app-ui/schema.js';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {MemoryPipeline,type SourceEvent,type Candidate} from '../pipeline.js';
import {parseExtraction,type ExtractedClaim} from '../extraction-provider.js';
import {readChatV4Sources} from '../chat-v4-reader.js';
import {chatParticipants} from '../../chat/participants.js';
import type {MemoryConfig} from './config.js';
export class MemoryError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type MemoryContext={conversationId:string;actor:string;realm:'real'|'game'|'simulation';audience:'private'|'group';grantRevision:string};
export type Entry={id:string;actor:string;conversation_id:string;source_id:string;source_revision:string;source_hash:string;grant_revision:string;realm:string;layer:'cognition'|'autobiography'|'impression';kind:string;statement:string;evidence:string;confidence:number;salience:number;perspective:string|null;parent_id:string|null;channel:string;created_at:string;withdrawn_at:string|null};
export type Evidence=SourceEvent&{role:string;conversationId:string};
export class LiveMemoryStore{
 constructor(readonly db:DatabaseSync,readonly config:MemoryConfig){}
 transaction<T>(run:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const x=run();this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 context(conversationId:string,actor:string):MemoryContext{
  if(conversationDeleted(this.db,conversationId))throw new MemoryError(403,'CONVERSATION_DELETED');
  if(!chatParticipants.some(p=>p.id===actor))throw new MemoryError(403,'MEMORY_ACTOR_DENIED');
  if(!this.db.prepare('SELECT 1 FROM chat_conversations WHERE id=?').get(conversationId))throw new MemoryError(404,'CONVERSATION_NOT_FOUND');
  const profile=this.db.prepare('SELECT kind FROM chat_live_profiles WHERE conversation_id=?').get(conversationId);
  const members=this.db.prepare('SELECT member_id FROM chat_live_members WHERE conversation_id=? ORDER BY member_id').all(conversationId).map(r=>String(r.member_id));
  const grant=this.db.prepare('SELECT allowed,revision FROM memory_live_grants WHERE conversation_id=? AND actor=?').get(conversationId,actor);
  if(grant?.allowed===0||profile&&!members.includes(actor)||!profile&&grant?.allowed!==1)throw new MemoryError(403,'MEMORY_ACTOR_DENIED');
  const scope=this.db.prepare('SELECT realm,revision FROM memory_live_scopes WHERE conversation_id=?').get(conversationId);
  return {conversationId,actor,realm:(scope?.realm??'real') as MemoryContext['realm'],audience:profile?.kind==='group'?'group':'private',grantRevision:hash([profile?.kind??'legacy',members,grant?.revision??0,scope?.revision??0])};
 }
 actors(conversationId:string){
  const profile=this.db.prepare('SELECT kind FROM chat_live_profiles WHERE conversation_id=?').get(conversationId);
  const ids=profile?this.db.prepare('SELECT member_id id FROM chat_live_members WHERE conversation_id=?').all(conversationId):this.db.prepare('SELECT actor id FROM memory_live_grants WHERE conversation_id=? AND allowed=1').all(conversationId);
  return ids.map(r=>String(r.id)).filter(actor=>{try{this.context(conversationId,actor);return true;}catch{return false;}});
 }
 setScope(conversationId:string,actor:string,allowed:boolean,realm:MemoryContext['realm']){
  if(!chatParticipants.some(p=>p.id===actor)||!['real','game','simulation'].includes(realm))throw new MemoryError(400,'INVALID_MEMORY_SCOPE');
  if(!this.db.prepare('SELECT 1 FROM chat_conversations WHERE id=?').get(conversationId))throw new MemoryError(404,'CONVERSATION_NOT_FOUND');
  const profile=this.db.prepare('SELECT kind FROM chat_live_profiles WHERE conversation_id=?').get(conversationId);
  if(profile&&allowed&&!this.db.prepare('SELECT 1 FROM chat_live_members WHERE conversation_id=? AND member_id=?').get(conversationId,actor))throw new MemoryError(403,'MEMORY_ACTOR_DENIED');
  if(!profile&&allowed){const other=this.db.prepare('SELECT actor FROM memory_live_grants WHERE conversation_id=? AND allowed=1 AND actor!=?').get(conversationId,actor);if(other)throw new MemoryError(409,'LEGACY_PRIVATE_OWNER_ALREADY_SET');}
  this.transaction(()=>{
   const old=this.db.prepare('SELECT realm FROM memory_live_scopes WHERE conversation_id=?').get(conversationId),grant=this.db.prepare('SELECT allowed FROM memory_live_grants WHERE conversation_id=? AND actor=?').get(conversationId,actor);
   const scopeChanged=(old?.realm??'real')!==realm;
   if(!scopeChanged&&(grant?grant.allowed===(allowed?1:0):!!profile===allowed))return;
   if(scopeChanged)this.db.prepare('INSERT INTO memory_live_scopes VALUES(?,?,1) ON CONFLICT(conversation_id) DO UPDATE SET realm=excluded.realm,revision=revision+1').run(conversationId,realm);
   this.db.prepare('INSERT INTO memory_live_grants VALUES(?,?,?,1) ON CONFLICT(conversation_id,actor) DO UPDATE SET allowed=excluded.allowed,revision=revision+1').run(conversationId,actor,allowed?1:0);
   this.db.prepare("UPDATE memory_live_jobs SET status='cancelled',error_code='SCOPE_CHANGED',payload=NULL WHERE conversation_id=? AND status IN ('queued','running') AND (?=1 OR actor=?)").run(conversationId,scopeChanged?1:0,actor);
  });
 }
 origins(target:MemoryContext){
  const rows=this.db.prepare('SELECT id FROM chat_conversations WHERE id IN (SELECT conversation_id FROM chat_live_members WHERE member_id=? UNION SELECT conversation_id FROM memory_live_grants WHERE actor=? AND allowed=1)').all(target.actor,target.actor);
  return rows.flatMap(row=>{try{const c=this.context(String(row.id),target.actor);return c.realm===target.realm&&(target.audience==='private'||c.conversationId===target.conversationId)?[c]:[];}catch{return [];}});
 }
 evidence(id:string,actor:string):Evidence|null{
  const row=this.db.prepare(`SELECT m.conversation_id,m.role,m.created_at,t.status,COALESCE(s.revision,1) revision,COALESCE(s.content,m.content) content,s.deleted_at FROM chat_messages m JOIN chat_turns t ON t.id=m.turn_id LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.id=?`).get(id);
  if(!row||row.status!=='succeeded'||row.deleted_at||!String(row.content).trim())return null;
  let c:MemoryContext;try{c=this.context(String(row.conversation_id),actor);}catch{return null;}
  return {eventId:`chat:${id}:v${row.revision}`,source:{id,version:String(row.revision),context:c.realm,scope:{type:c.audience,actors:[actor]},active:true,deleted:false,occurredAt:String(row.created_at)},text:String(row.content),role:String(row.role),conversationId:c.conversationId};
 }
 sources(c:MemoryContext,turnId?:string){
  const projection=readChatV4Sources(this.db,{conversationId:c.conversationId,actorIds:[c.actor],beforeSeq:Number.MAX_SAFE_INTEGER,limit:100});
  if(projection.status!=='ok')throw new MemoryError(503,'MEMORY_SOURCE_UNAVAILABLE');
  if(turnId)return this.db.prepare('SELECT id FROM chat_messages WHERE turn_id=? AND conversation_id=?').all(turnId,c.conversationId).flatMap(r=>{const e=this.evidence(String(r.id),c.actor);return e?[e]:[];});
  return projection.sources.flatMap(s=>{const e=this.evidence(s.source.id,c.actor);return e?[e]:[];});
 }
 valid(row:Entry,target:MemoryContext){
  let parentId=row.parent_id;const seen=new Set<string>([row.id]);
  while(parentId){if(seen.has(parentId)||seen.size>64)return false;seen.add(parentId);const parent=this.entry(parentId);if(!parent||parent.withdrawn_at||this.db.prepare('SELECT 1 FROM memory_live_corrections WHERE entry_id=?').get(parentId))return false;const e=this.evidence(parent.source_id,parent.actor);if(!e||e.source.version!==parent.source_revision||hash(e.text)!==parent.source_hash)return false;let pc;try{pc=this.context(parent.conversation_id,parent.actor);}catch{return false;}if(pc.grantRevision!==parent.grant_revision)return false;parentId=parent.parent_id;}
  if(row.withdrawn_at||row.actor!==target.actor||row.realm!==target.realm||target.audience==='group'&&row.conversation_id!==target.conversationId)return false;
  let c:MemoryContext;try{c=this.context(row.conversation_id,row.actor);}catch{return false;}
  if(c.grantRevision!==row.grant_revision)return false;
  const e=this.evidence(row.source_id,row.actor);
  return !!e&&e.source.version===row.source_revision&&hash(e.text)===row.source_hash;
 }
 entry(id:string){return this.db.prepare('SELECT * FROM memory_live_entries WHERE id=?').get(id) as Entry|undefined;}
 view(row:Entry,c:MemoryContext,history=false){
  if(!this.valid(row,c)||!history&&this.db.prepare('SELECT * FROM memory_live_entries WHERE parent_id=?').all(row.id).some(child=>this.valid(child as Entry,c)))return null;
  const corrections=this.db.prepare('SELECT id,text,created_at FROM memory_live_corrections WHERE entry_id=? ORDER BY rowid').all(row.id);
  const latest=corrections.at(-1);const source=this.evidence(row.source_id,row.actor)!;
  return {id:row.id,layer:row.layer,kind:row.kind,statement:String(latest?.text??row.statement),originalStatement:row.statement,confidence:row.confidence,salience:row.salience,subjective:row.kind==='impression',channel:row.channel,createdAt:row.created_at,version:hash([row.id,latest?.id??null,row.withdrawn_at]),userCorrected:!!latest,corrections,source:{id:source.source.id,revision:source.source.version,quote:row.evidence,role:source.role,conversationId:source.conversationId,occurredAt:source.source.occurredAt},parentId:row.parent_id};
 }
 search(c:MemoryContext,query:string,options:{before?:number;beforeExperience?:number;experiences?:boolean;limit?:number;browse?:boolean}={}){
  const origins=this.origins(c);if(!origins.length)return {status:'no_match',items:[],partial:false,nextBefore:null};
  const ids=origins.map(o=>o.conversationId),placeholders=ids.map(()=>'?').join(',');
  // Permission-constrained SQL precedes candidate text scoring. No globally ranked FTS results.
  const window=options.browse?Math.min(options.limit??20,this.config.pool):this.config.pool;
  const rows=this.db.prepare(`SELECT rowid cursor,* FROM memory_live_entries WHERE actor=? AND realm=? AND conversation_id IN (${placeholders}) AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(c.actor,c.realm,...ids,options.before??Number.MAX_SAFE_INTEGER,window+1) as unknown as Array<Entry&{cursor:number}>;
  const partial=rows.length>window,page=rows.slice(0,window);
  const all=page.filter(e=>this.valid(e,c)).filter(e=>!this.db.prepare('SELECT * FROM memory_live_entries WHERE parent_id=?').all(e.id).some(child=>this.valid(child as Entry,c)));
  const tokens=(s:string)=>new Set(s.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]{2}/gu)??[]);
  const q=tokens(query);const score=(s:string)=>{const t=tokens(s);let n=0;for(const x of q)if(t.has(x))n++;if(!n&&query.trim()&&s.includes(query.trim()))return 1;return n/Math.sqrt(Math.max(q.size,1)*Math.max(t.size,1));};
  const candidates=all.flatMap(row=>{const item=this.view(row,c);if(!item)return [];const relevance=options.browse?1:score(item.statement);const age=Math.max(0,(Date.now()-Date.parse(row.created_at))/86400000);return relevance>=this.config.minScore?[{...item,score:relevance,rank:relevance*(0.8+0.2*row.salience*Math.pow(0.5,age/this.config.halfLifeDays))}]:[];});
  candidates.sort((a,b)=>Number(b.userCorrected)-Number(a.userCorrected)||b.rank-a.rank||a.id.localeCompare(b.id));
  const seen=new Set<string>();const distinct=candidates.filter(m=>{const key=hash([m.kind,m.layer,m.statement.normalize('NFKC').trim()]);if(seen.has(key))return false;seen.add(key);return true;});
  const items=distinct.slice(0,options.limit??this.config.recallLimit);
  const raw=options.experiences?this.rawSearch(c,query,options.browse??false,options.beforeExperience):{items:[],partial:false,nextBefore:null};
  return {status:items.length||raw.items.length?'ok':'no_match',items,experiences:raw.items,partial:partial||raw.partial||candidates.length>items.length,nextBefore:partial?page.at(-1)!.cursor:null,nextExperienceBefore:raw.nextBefore};
 }
 rawSearch(c:MemoryContext,query:string,browse=false,before=Number.MAX_SAFE_INTEGER){
  const contexts=this.origins(c),ids=contexts.map(x=>x.conversationId);if(!ids.length)return {items:[],partial:false,nextBefore:null};
  const rows=this.db.prepare(`SELECT m.id,m.rowid cursor FROM chat_messages m JOIN chat_turns t ON t.id=m.turn_id WHERE m.conversation_id IN (${ids.map(()=>'?').join(',')}) AND t.status='succeeded' AND m.rowid<? ORDER BY m.rowid DESC LIMIT ?`).all(...ids,before,this.config.pool+1);
  const q=query.normalize('NFKC').toLowerCase().trim();
  const items:Array<{id:string;layer:string;statement:string;source:{id:string;revision:string;conversationId:string;role:string;occurredAt:string}}>=[];let cursor:number|null=null,scanned=0;
  for(const r of rows.slice(0,this.config.pool)){scanned++;cursor=Number(r.cursor);const e=this.evidence(String(r.id),c.actor);if(e&&(browse||e.text.normalize('NFKC').toLowerCase().includes(q)))items.push({id:e.source.id,layer:'experience',statement:e.text,source:{id:e.source.id,revision:e.source.version,conversationId:e.conversationId,role:e.role,occurredAt:e.source.occurredAt}});if(items.length>=(browse?20:this.config.recallLimit))break;}
  const partial=scanned<rows.length;return {items,partial,nextBefore:partial?cursor:null};
 }
 commit(c:MemoryContext,claim:ExtractedClaim,channel:'automatic'|'autonomous',layer:'cognition'|'autobiography'|'impression',parentId?:string){
  const parsed=parseExtraction(JSON.stringify({schema:1,candidates:[claim]}),64000,1)[0];
  const e=this.evidence(parsed.sourceId,c.actor);if(!e||e.source.version!==parsed.sourceVersion||e.eventId!==parsed.sourceEventId||e.conversationId!==c.conversationId||this.context(c.conversationId,c.actor).grantRevision!==c.grantRevision)throw new MemoryError(409,'MEMORY_EVIDENCE_CHANGED');
  if(parsed.kind==='impression'&&e.role==='assistant'&&this.db.prepare('SELECT sp.member_id FROM chat_messages m JOIN chat_live_turn_speakers sp ON sp.turn_id=m.turn_id WHERE m.id=?').get(e.source.id)?.member_id!==c.actor)throw new MemoryError(409,'OTHER_SPEAKER_NOT_SELF_EXPERIENCE');
  if(parsed.kind!=='impression'&&e.role!=='user')throw new MemoryError(409,'ASSISTANT_CLAIM_NOT_USER_FACT');
  if(parsed.kind==='impression'&&layer==='cognition'||parsed.kind!=='impression'&&layer!=='cognition')throw new MemoryError(400,'INVALID_MEMORY_LAYER');
  if(parentId){const parent=this.entry(parentId);if(!parent||!this.valid(parent,c)||parent.actor!==c.actor||parent.kind!==parsed.kind||parent.layer!==layer||parent.source_id!==e.source.id||parent.source_revision!==e.source.version||this.db.prepare('SELECT * FROM memory_live_entries WHERE parent_id=?').all(parentId).some(r=>this.valid(r as Entry,c))||this.db.prepare('SELECT 1 FROM memory_live_corrections WHERE entry_id=?').get(parentId))throw new MemoryError(409,'MEMORY_REVISION_DENIED');}
  const override=this.db.prepare('SELECT e.id FROM memory_live_entries e LEFT JOIN memory_live_corrections c ON c.entry_id=e.id WHERE e.actor=? AND e.source_id=? AND e.source_revision=? AND e.kind=? AND (e.withdrawn_at IS NOT NULL OR c.id IS NOT NULL) LIMIT 1').get(c.actor,e.source.id,e.source.version,parsed.kind);if(override)return String(override.id);
  const id='memory:'+hash([c.actor,c.grantRevision,parsed,layer,parentId??null]);
  const candidate:Candidate={id,owner:c.actor,sourceId:e.source.id,sourceVersion:e.source.version,kind:parsed.kind,statement:parsed.statement,evidenceQuote:parsed.evidenceQuote,confidence:parsed.confidence,salience:parsed.salience,...(parsed.perspective?{perspective:parsed.perspective}:{})};
  const pipeline=new MemoryPipeline();pipeline.acceptEvent(e);pipeline.acceptCandidate('decision:'+id,candidate);
  this.db.prepare('INSERT OR IGNORE INTO memory_live_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id,c.actor,c.conversationId,e.source.id,e.source.version,hash(e.text),c.grantRevision,c.realm,layer,parsed.kind,parsed.statement,parsed.evidenceQuote,parsed.confidence,parsed.salience,parsed.perspective??null,parentId??null,channel,new Date().toISOString());
  if(parsed.kind==='event'&&!this.db.prepare('SELECT 1 FROM memory_live_events WHERE root_entry_id=?').get(id)){
   const eventId=randomUUID();this.db.prepare('INSERT INTO memory_live_events VALUES(?,?,?,?,?,?)').run(eventId,c.actor,c.realm,parsed.evidenceQuote.slice(0,100),id,new Date().toISOString());
   this.db.prepare('INSERT INTO memory_live_event_revisions VALUES(?,?,NULL,?,?,?,?,?)').run(randomUUID(),eventId,JSON.stringify({state:'有来源记录，进展尚未确认',unresolved:[],understanding:''}),JSON.stringify([{id,version:this.view(this.entry(id)!,c)!.version}]),'active',channel,new Date().toISOString());
  }
  return id;
 }
 correct(c:MemoryContext,id:string,version:string,text:string,requestId:string){
  return this.transaction(()=>{const row=this.entry(id),view=row&&this.view(row,c);if(!view)throw new MemoryError(404,'MEMORY_NOT_AVAILABLE');
   const old=this.db.prepare('SELECT * FROM memory_live_corrections WHERE request_id=?').get(requestId);if(old){if(old.entry_id!==id||old.text!==text)throw new MemoryError(409,'CORRECTION_ID_CONFLICT');return this.view(row!,c);}
   if(view.version!==version)throw new MemoryError(409,'MEMORY_VERSION_CONFLICT');
   this.db.prepare('INSERT INTO memory_live_corrections VALUES(?,?,?,?,?)').run(randomUUID(),id,text,requestId,new Date().toISOString());return this.view(row!,c);
  });
 }
 withdraw(c:MemoryContext,id:string,version:string){const row=this.entry(id),view=row&&this.view(row,c);if(!view)throw new MemoryError(404,'MEMORY_NOT_AVAILABLE');if(view.version!==version)throw new MemoryError(409,'MEMORY_VERSION_CONFLICT');this.db.prepare('UPDATE memory_live_entries SET withdrawn_at=? WHERE id=?').run(new Date().toISOString(),id);}
 events(c:MemoryContext,options:{matching?:string[];id?:string}={}){
  const origins=this.origins(c).map(o=>o.conversationId);if(!origins.length||options.matching&&!options.matching.length)return [];
  const args:Array<string|number>=[c.actor,c.realm,...origins];let filter='';
  if(options.id){filter+=' AND ev.id=?';args.push(options.id);}
  if(options.matching){filter+=" AND EXISTS(SELECT 1 FROM memory_live_event_revisions r,json_each(r.entry_ids) ref WHERE r.event_id=ev.id AND json_extract(ref.value,'$.id') IN ("+options.matching.map(()=>'?').join(',')+"))";args.push(...options.matching);}
  args.push(this.config.pool);
  return this.db.prepare('SELECT ev.* FROM memory_live_events ev JOIN memory_live_entries root ON root.id=ev.root_entry_id WHERE ev.actor=? AND ev.realm=? AND root.conversation_id IN ('+origins.map(()=>'?').join(',')+')'+filter+' ORDER BY ev.rowid DESC LIMIT ?').all(...args).flatMap(event=>{
   const root=this.entry(String(event.root_entry_id));if(!root||!this.valid(root,c))return [];
   const rows=this.db.prepare('SELECT * FROM memory_live_event_revisions WHERE event_id=? ORDER BY rowid').all(String(event.id));
   const revisions=rows.flatMap(row=>{const refs=JSON.parse(String(row.entry_ids)) as Array<{id:string;version:string}>;const entries=refs.map(ref=>this.entry(ref.id));if(!entries.length||entries.some(e=>!e||!this.valid(e,c)))return [];const outdated=entries.some((e,i)=>this.view(e!,c)?.version!==refs[i].version);return [{id:String(row.id),parentId:row.parent_id,status:outdated?'outdated':row.status,channel:row.channel,payload:JSON.parse(String(row.payload)),sources:entries.map(e=>this.view(e!,c,true)),createdAt:row.created_at}];});
   const current=revisions.filter(r=>r.status==='active').at(-1);return revisions.length?[{id:String(event.id),title:String(event.title),revisions:revisions.map(r=>r.status==='active'&&r!==current?{...r,status:'historical'}:r)}]:[];
  });
 }
 /** Caller holds the transaction and rechecks captured source versions before proposing. */
 proposeEvent(c:MemoryContext,id:string,title:string|undefined,entryIds:string[],payload:Parameters<LiveMemoryStore['reviseEvent']>[4]){
  if(!entryIds.length||entryIds.length>20)throw new MemoryError(400,'INVALID_EVENT_SOURCES');
  const sources=[...new Set(entryIds)].map(id=>{const row=this.entry(id),view=row&&this.view(row,c);if(!view)throw new MemoryError(403,'EVENT_SOURCE_DENIED');return view;});
  const existing=this.db.prepare('SELECT * FROM memory_live_events WHERE id=?').get(id);
  if(existing){if(existing.actor!==c.actor||existing.realm!==c.realm||existing.root_entry_id!==sources[0].id)throw new MemoryError(409,'EVENT_ID_CONFLICT');return id;}
  if(title!==undefined&&(!title.trim()||title.length>100))throw new MemoryError(400,'INVALID_EVENT_TITLE');
  this.db.prepare('INSERT INTO memory_live_events VALUES(?,?,?,?,?,?)').run(id,c.actor,c.realm,title??sources[0].statement.slice(0,100),sources[0].id,new Date().toISOString());
  this.db.prepare('INSERT INTO memory_live_event_revisions VALUES(?,?,NULL,?,?,?,?,?)').run(randomUUID(),id,JSON.stringify(payload),JSON.stringify(sources.map(s=>({id:s.id,version:s.version}))),'pending','autonomous',new Date().toISOString());return id;
 }
 approveEvent(c:MemoryContext,id:string,revisionId:string){return this.transaction(()=>{
  const event=this.events(c,{id}).find(e=>e.id===id),revision=event?.revisions.find(r=>r.id===revisionId);
  if(!event||!revision)throw new MemoryError(404,'EVENT_PROPOSAL_NOT_AVAILABLE');
  const current=event.revisions.filter(r=>r.status==='active').at(-1);
  if(revision.status==='active'&&current?.id===revision.id)return {approved:true};
  if(revision.status!=='pending')throw new MemoryError(409,'EVENT_PROPOSAL_NOT_CURRENT');
  if((current?.id??null)!==revision.parentId)throw new MemoryError(409,'EVENT_VERSION_CONFLICT');
  this.db.prepare("UPDATE memory_live_event_revisions SET status='active' WHERE id=? AND status='pending'").run(revision.id);return {approved:true};
 });}
 reviseEvent(c:MemoryContext,eventId:string,parentId:string|null,entryIds:string[],payload:{state:string;unresolved:string[];understanding:string;cause?:string;turningPoints?:string[]},channel:'user'|'autonomous'){
  const event=this.events(c,{id:eventId}).find(e=>e.id===eventId);if(!event)throw new MemoryError(404,'EVENT_NOT_AVAILABLE');
  const current=event.revisions.filter(r=>r.status==='active').at(-1);if((current?.id??null)!==parentId)throw new MemoryError(409,'EVENT_VERSION_CONFLICT');
  if(!entryIds.length||entryIds.length>20||entryIds.some(id=>{const e=this.entry(id);return !e||!this.valid(e,c);}))throw new MemoryError(403,'EVENT_SOURCE_DENIED');
  const root=this.db.prepare('SELECT root_entry_id FROM memory_live_events WHERE id=?').get(eventId);entryIds=[...new Set([String(root!.root_entry_id),...entryIds])];if(entryIds.length>20)throw new MemoryError(400,'EVENT_SOURCE_LIMIT');
  const oldIds=new Set(current?.sources.map(e=>e!.id)??[]);if(channel==='autonomous'&&entryIds.every(id=>oldIds.has(id)))throw new MemoryError(409,'EVENT_REQUIRES_NEW_EVIDENCE');
  const id=randomUUID();this.db.prepare('INSERT INTO memory_live_event_revisions VALUES(?,?,?,?,?,?,?,?)').run(id,eventId,parentId,JSON.stringify(payload),JSON.stringify(entryIds.map(id=>({id,version:this.view(this.entry(id)!,c)!.version}))),channel==='user'?'active':'pending',channel,new Date().toISOString());return id;
 }
}
