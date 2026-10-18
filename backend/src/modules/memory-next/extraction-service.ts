/** MEM-04 isolated integration. No production DB, routes, provider keys or sync changes. */
import { createHash } from 'node:crypto';
import type { ParticipantGrantResolver } from './chat-v4-authorized.js';
import { buildMemoryExtractionBatches, type ExtractionBatch } from './extraction-batches.js';
import { EXTRACTION_INSTRUCTION, parseExtraction, type ExtractionProvider, type ExtractedClaim } from './extraction-provider.js';
import { MemoryPipeline, type Candidate, type SourceEvent, type Snapshot } from './pipeline.js';
import type { ExtractionState, ExtractionStateStore, StoredRecord, StoredJob, UserCorrection, UserCorrectionAuthority } from './extraction-state.js';

export type ExtractionContext = { actorId: string; conversationId: string; audience: 'private' | 'group' };
export interface CurrentEvidenceReader {
 /** Both audience and privateOwnerId MUST come from authority, never request/model labels. */
 readCurrent(context:ExtractionContext): {conversationId:string;audience:'private'|'group';privateOwnerId?:string;sources:SourceEvent[]};
}
export type EvidenceProposal = {
 id:string;context:ExtractionContext;grantRevision:string;providerVersion:string;privateOwnerId?:string;
 claim:ExtractedClaim;sourceHash:string;quoteStart:number;quoteEnd:number;status:'pending_review';
};
export interface EvidenceReviewer {review(proposal:EvidenceProposal,signal:AbortSignal):Promise<'approve'|'reject'>;}
export type ExtractionLimits = {batchChars:number;outputChars:number;maxCandidates:number;maxSources:number;maxBatches:number;timeoutMs:number;maxJobs:number;maxConcurrent:number;maxRecords:number};
const defaults:ExtractionLimits={batchChars:12_000,outputChars:64_000,maxCandidates:32,maxSources:100,maxBatches:8,timeoutMs:30_000,maxJobs:64,maxConcurrent:2,maxRecords:2048};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf=(c:ExtractionContext)=>JSON.stringify([c.actorId,c.conversationId,c.audience]);
const contextOf=(c:ExtractionContext):ExtractionContext=>({actorId:c.actorId,conversationId:c.conversationId,audience:c.audience});
type View={sources:SourceEvent[];grantRevision:string;privateOwnerId?:string};
export type ExtractionOptions={stateStore?:ExtractionStateStore;corrections?:UserCorrectionAuthority};

export class IsolatedMemoryExtractor {
 private readonly limits:ExtractionLimits;
 private readonly providerVersion:string;
 private active=0;
 private revision=0;
 private broken=false;
 private dirty=false;
 private inFlight=new Map<string,Promise<EvidenceProposal[]>>();
 private records=new Map<string,StoredRecord>();
 private jobs=new Map<string,StoredJob>();
 private corrections:UserCorrection[]=[];
 constructor(private readonly grants:ParticipantGrantResolver,private readonly reader:CurrentEvidenceReader,
  private readonly provider:ExtractionProvider,private readonly reviewer?:EvidenceReviewer,
  limits:Partial<ExtractionLimits>={},private readonly options:ExtractionOptions={}) {
  this.limits={...defaults,...limits};this.providerVersion=provider.version;
  if(!this.providerVersion?.trim()||Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1)||this.limits.batchChars<256||this.limits.batchChars>200_000)throw Error('invalid_extraction_configuration');
  const saved=options.stateStore?.read();
  if(saved){this.revision=saved.revision;if(saved.state)this.restore(saved.state);}
  // A restarted process cannot know whether its interrupted model request was billed/completed.
  for(const job of this.jobs.values())if(job.status==='running'){job.status='unknown';this.dirty=true;}
 }
 private assertReady(){if(this.broken)throw Error('extraction_storage_unavailable');}
 private state():ExtractionState{return structuredClone({schema:1,records:[...this.records],jobs:[...this.jobs],corrections:this.corrections});}
 private restore(s:ExtractionState){
  if(s?.schema!==1||!Array.isArray(s.records)||!Array.isArray(s.jobs)||!Array.isArray(s.corrections)
   ||s.records.length>this.limits.maxRecords||s.jobs.length>this.limits.maxJobs||s.corrections.length>this.limits.maxRecords)throw Error('extraction_checkpoint_schema');
  const records=new Map<string,StoredRecord>();
  for(const [id,entry] of s.records){
   const p=entry?.proposal;
   if(!p||id!==p.id||p.status!=='pending_review'||!p.grantRevision?.trim()||!p.providerVersion?.trim()||!p.context?.actorId?.trim()||!p.context.conversationId?.trim()
    ||!['private','group'].includes(p.context.audience)||!Number.isSafeInteger(p.quoteStart)||p.quoteStart<0||p.quoteEnd!==p.quoteStart+p.claim?.evidenceQuote?.length
    ||!/^[a-f0-9]{64}$/.test(p.sourceHash)||records.has(id)||!['approved','rejected',undefined].includes(entry.decision))throw Error('extraction_checkpoint_schema');
   parseExtraction(JSON.stringify({schema:1,candidates:[p.claim]}),this.limits.outputChars,1);
   const {id:_id,...body}=p;if(id!==`mem-extraction:${hash(body)}`)throw Error('extraction_checkpoint_identity');
   if((entry.decision==='approved')!==!!entry.candidate)throw Error('extraction_checkpoint_decision');
   if(entry.candidate&&JSON.stringify(entry.candidate)!==JSON.stringify(this.candidate(p,entry.candidate.supersedes)))throw Error('extraction_checkpoint_candidate');
   records.set(id,structuredClone(entry));
  }
  const jobs=new Map<string,StoredJob>();
  for(const [key,job] of s.jobs){
   let context:unknown;try{context=JSON.parse(key);}catch{throw Error('extraction_checkpoint_job');}
   if(!Array.isArray(context)||context.length!==2||typeof key!=='string'||jobs.has(key)||!/^[a-f0-9]{64}$/.test(job.fingerprint)
    ||!['running','succeeded','failed','unknown'].includes(job.status)||!Array.isArray(job.proposalIds)||job.proposalIds.some(id=>typeof id!=='string'))throw Error('extraction_checkpoint_job');
   jobs.set(key,structuredClone(job));
  }
  if(s.corrections.some(c=>!c.requestId?.trim()||!c.actorId?.trim()||!c.targetId?.trim()||!c.replacementId?.trim()||!c.sourceId?.trim()||!c.sourceVersion?.trim()||c.context.actorId!==c.actorId))throw Error('extraction_checkpoint_correction');
  this.records=records;this.jobs=jobs;this.corrections=structuredClone(s.corrections);
 }
 /** All local state mutations publish only after durable CAS succeeds. No await in this section. */
 private change(action:()=>void,verify:()=>void=()=>{}){
  this.assertReady();const before=this.state();const wasDirty=this.dirty;
  try{action();verify();if(this.options.stateStore)this.revision=this.options.stateStore.write(this.revision,this.state(),verify);this.dirty=false;}
  catch(error){this.restore(before);this.dirty=wasDirty;if(this.options.stateStore)this.broken=true;throw error;}
 }
 private view(context:ExtractionContext):View {
  this.assertReady();
  if(!context.actorId?.trim()||!context.conversationId?.trim()||!['private','group'].includes(context.audience))throw Error('invalid_extraction_context');
  const grant=this.grants.resolve(context.conversationId,context.actorId);
  if(grant.status!=='allowed'||grant.actorId!==context.actorId||grant.conversationId!==context.conversationId||!grant.grantRevision?.trim()){
   this.purge(context);throw Error('extraction_not_authorized');
  }
  const current=structuredClone(this.reader.readCurrent(contextOf(context)));
  if(current.conversationId!==context.conversationId||current.audience!==context.audience||current.sources.some(e=>e.source.scope.type!==context.audience))throw Error('extraction_audience_mismatch');
  if(current.privateOwnerId!==undefined&&(!current.privateOwnerId.trim()||context.audience!=='private'))throw Error('extraction_invalid_private_owner');
  if(current.sources.length>this.limits.maxSources)throw Error('extraction_source_limit');
  const batches=buildMemoryExtractionBatches(current.sources,context.actorId,this.limits.batchChars);
  const eligible=new Set(batches.flatMap(b=>b.sourceRefs.map(r=>r.eventId)));
  const sources=current.sources.filter(e=>eligible.has(e.eventId)).sort((a,b)=>a.source.id.localeCompare(b.source.id));
  if(new Set(sources.map(e=>e.eventId)).size!==sources.length)throw Error('duplicate_source_event');
  const view:View={sources,grantRevision:grant.grantRevision,...(current.privateOwnerId?{privateOwnerId:current.privateOwnerId}:{})};
  for(const [id,entry]of this.records)if(keyOf(entry.proposal.context)===keyOf(context)&&!this.valid(entry.proposal,view)){this.records.delete(id);this.dirty=true;}
  return view;
 }
 private purge(context:ExtractionContext){for(const [id,e]of this.records)if(keyOf(e.proposal.context)===keyOf(context)){this.records.delete(id);this.dirty=true;}}
 private valid(p:EvidenceProposal,view:View){return p.grantRevision===view.grantRevision&&p.privateOwnerId===view.privateOwnerId&&view.sources.some(e=>e.source.id===p.claim.sourceId&&e.source.version===p.claim.sourceVersion&&e.eventId===p.claim.sourceEventId&&hash(e)===p.sourceHash);}
 private unchanged(c:ExtractionContext,before:View){if(hash(this.view(c))!==hash(before))throw Error('extraction_source_or_grant_changed');}
 private async timed<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>run(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('extraction_timeout'));},this.limits.timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 async extract(context:ExtractionContext,jobId:string):Promise<EvidenceProposal[]>{
  context=contextOf(context);if(!jobId?.trim()||jobId.length>160)throw Error('invalid_extraction_job');
  const before=this.view(context),key=JSON.stringify([keyOf(context),jobId]);
  const fingerprint=hash([before,this.providerVersion,this.limits]);const prior=this.jobs.get(key);
  if(prior&&prior.fingerprint!==fingerprint)throw Error('extraction_job_conflict');
  const active=this.inFlight.get(key);if(active){const result=await active;this.unchanged(context,before);return structuredClone(result);}
  if(prior?.status==='succeeded'){this.unchanged(context,before);return this.copyProposals(prior.proposalIds);}
  if(prior?.status==='unknown'||prior?.status==='running')throw Error('extraction_interrupted_ack_required');
  if(!prior&&this.jobs.size>=this.limits.maxJobs)throw Error('extraction_job_capacity');
  if(this.active>=this.limits.maxConcurrent)throw Error('extraction_concurrency_limit');
  this.change(()=>this.jobs.set(key,{fingerprint,status:'running',proposalIds:[]}),()=>this.unchanged(context,before));
  this.active++;
  const run=(async()=>{
   try{
    const proposals=await this.prepare(context,before);this.unchanged(context,before);
    if(this.records.size+proposals.filter(p=>!this.records.has(p.id)).length>this.limits.maxRecords)throw Error('extraction_record_capacity');
    this.change(()=>{for(const p of proposals)if(!this.records.has(p.id))this.records.set(p.id,{proposal:structuredClone(p)});this.jobs.set(key,{fingerprint,status:'succeeded',proposalIds:proposals.map(p=>p.id)});},()=>this.unchanged(context,before));
    return this.copyProposals(proposals.map(p=>p.id));
   }catch(error){if(!this.broken)this.change(()=>this.jobs.set(key,{fingerprint,status:'failed',proposalIds:[]}));throw error;}
   finally{this.active--;this.inFlight.delete(key);}
  })();this.inFlight.set(key,run);return structuredClone(await run);
 }
 /** Explicit caller action, not an automatic supplier retry. May repeat a previously billed call. */
 acknowledgeInterruptedJob(context:ExtractionContext,jobId:string):void{
  this.view(context);const key=JSON.stringify([keyOf(context),jobId]);if(this.jobs.get(key)?.status!=='unknown')throw Error('extraction_job_not_interrupted');
  this.change(()=>this.jobs.delete(key));
 }
 private async prepare(context:ExtractionContext,before:View):Promise<EvidenceProposal[]>{
  const batches=buildMemoryExtractionBatches(before.sources,context.actorId,this.limits.batchChars);
  if(batches.length>this.limits.maxBatches||batches.some(b=>b.text.length>this.limits.batchChars))throw Error('extraction_batch_limit');
  const proposals=new Map<string,EvidenceProposal>();
  for(const batch of batches){
   this.unchanged(context,before);let raw:string;
   try{raw=await this.timed(signal=>this.provider.extract({instruction:EXTRACTION_INSTRUCTION,batch:structuredClone(batch),signal}));}
   catch{this.unchanged(context,before);throw Error('extraction_provider_failed');}
   this.unchanged(context,before);
   for(const claim of parseExtraction(raw,this.limits.outputChars,this.limits.maxCandidates)){const p=this.bind(context,before,batch,claim);proposals.set(p.id,p);}
  }
  return [...proposals.values()];
 }
 private copyProposals(ids:string[]){return ids.map(id=>{const entry=this.records.get(id);if(!entry)throw Error('extraction_proposal_unavailable');return structuredClone(entry.proposal);});}
 private bind(context:ExtractionContext,view:View,batch:ExtractionBatch,claim:ExtractedClaim):EvidenceProposal{
  if(!batch.sourceRefs.some(r=>r.sourceId===claim.sourceId&&r.version===claim.sourceVersion&&r.eventId===claim.sourceEventId))throw Error('extraction_source_not_in_batch');
  const source=view.sources.find(e=>e.source.id===claim.sourceId&&e.source.version===claim.sourceVersion&&e.eventId===claim.sourceEventId);
  const start=source?.text.indexOf(claim.evidenceQuote)??-1;if(!source||start<0)throw Error('extraction_evidence_not_found');
  if(claim.kind==='fact'&&['game','simulation'].includes(source.source.context))throw Error('extraction_nonreal_fact');
  const body={context,grantRevision:view.grantRevision,providerVersion:this.providerVersion,claim,sourceHash:hash(source),quoteStart:start,quoteEnd:start+claim.evidenceQuote.length,status:'pending_review' as const,...(view.privateOwnerId?{privateOwnerId:view.privateOwnerId}:{})};
  return {id:`mem-extraction:${hash(body)}`,...body};
 }
 private candidate(p:EvidenceProposal,supersedes?:string):Candidate{
  const c=p.claim;return {id:p.id,owner:p.context.actorId,sourceId:c.sourceId,sourceVersion:c.sourceVersion,kind:c.kind,statement:c.statement,evidenceQuote:c.evidenceQuote,confidence:c.confidence,salience:c.salience,...(c.perspective?{perspective:c.perspective}:{}),...(supersedes?{supersedes}:{})};
 }
 private pipeline(context:ExtractionContext,view:View){
  const p=new MemoryPipeline();for(const e of view.sources)p.acceptEvent(e);
  for(const entry of this.records.values())if(entry.candidate&&keyOf(entry.proposal.context)===keyOf(context)&&this.valid(entry.proposal,view))p.acceptCandidate(`review:${entry.proposal.id}`,entry.candidate);
  return p;
 }
 async reviewAndCommit(context:ExtractionContext,id:string,supersedes?:string):Promise<'created'|'duplicate'|'rejected'|'pending_review'>{
  context=contextOf(context);const before=this.view(context);const entry=this.records.get(id);
  if(!entry||keyOf(entry.proposal.context)!==keyOf(context)||!this.valid(entry.proposal,before))throw Error('extraction_proposal_unavailable');
  if(entry.decision==='rejected')return 'rejected';
  if(entry.candidate){if(entry.candidate.supersedes!==supersedes)throw Error('extraction_revision_conflict');return 'duplicate';}
  if(!this.reviewer)return 'pending_review';let decision:'approve'|'reject';
  try{decision=await this.timed(signal=>this.reviewer!.review(structuredClone(entry.proposal),signal));}
  catch{this.unchanged(context,before);throw Error('extraction_reviewer_failed');}
  this.unchanged(context,before);if(!['approve','reject'].includes(decision))throw Error('extraction_invalid_review_decision');
  const current=this.records.get(id);if(!current)throw Error('extraction_proposal_unavailable');
  if(current.decision==='rejected')return 'rejected';
  if(current.candidate){if(current.candidate.supersedes!==supersedes)throw Error('extraction_revision_conflict');return 'duplicate';}
  if(decision==='reject'){this.change(()=>{current.decision='rejected';},()=>this.unchanged(context,before));return 'rejected';}
  if(supersedes){const prev=this.records.get(supersedes);if(!prev?.candidate||keyOf(prev.proposal.context)!==keyOf(context)||prev.candidate.kind!==current.proposal.claim.kind||prev.candidate.sourceId!==current.proposal.claim.sourceId||prev.candidate.sourceVersion!==current.proposal.claim.sourceVersion||[...this.records.values()].some(e=>e.candidate?.supersedes===supersedes))throw Error('extraction_invalid_revision');}
  const candidate=this.candidate(current.proposal,supersedes);this.pipeline(context,before).acceptCandidate(`review:${id}`,candidate);
  this.change(()=>{current.candidate=candidate;current.decision='approved';},()=>this.unchanged(context,before));return 'created';
 }
 /** Same-persona, same-owner private continuity is default; never forward private memories into groups. */
 recall(context:ExtractionContext,query:string,limit:number){
  const target=this.view(context);if(!Number.isInteger(limit)||limit<1||limit>20)return {status:'no_match' as const,memories:[]};
  const contexts=new Map<string,ExtractionContext>([[keyOf(context),contextOf(context)]]);
  if(context.audience==='private'&&target.privateOwnerId)for(const {proposal:p}of this.records.values())if(p.context.actorId===context.actorId&&p.context.audience==='private'&&p.privateOwnerId===target.privateOwnerId)contexts.set(keyOf(p.context),p.context);
  const memories=[];let unavailable=false;const verified:Array<{context:ExtractionContext;view:View}>=[];
  for(const origin of contexts.values()){
   try{const view=keyOf(origin)===keyOf(context)?target:this.view(origin);
    if(keyOf(origin)!==keyOf(context)&&(!target.privateOwnerId||view.privateOwnerId!==target.privateOwnerId))continue;
    verified.push({context:origin,view});memories.push(...this.pipeline(origin,view).recall(context.actorId,query,20).memories);
   }catch(error){if((error as Error).message!=='extraction_not_authorized')unavailable=true;}
  }
  if(unavailable)return {status:'unavailable' as const,memories:[]};
  const live=memories.filter(m=>!this.corrections.some(c=>c.actorId===m.owner&&c.sourceId===m.sourceId&&c.sourceVersion===m.sourceVersion&&c.replacementId!==m.id));
  const replacements=new Set(this.corrections.filter(c=>c.actorId===context.actorId).map(c=>c.replacementId));
  live.sort((a,b)=>Number(replacements.has(b.id))-Number(replacements.has(a.id))||b.salience-a.salience||a.id.localeCompare(b.id));
  const verify=()=>{for(const item of verified)this.unchanged(item.context,item.view);};verify();
  if(this.dirty)this.change(()=>{},verify);
  return {status:live.length?'ok' as const:'no_match' as const,memories:live.slice(0,limit)};
 }
 /** A trusted user correction masks the old source version, so re-extraction cannot resurrect it. */
 applyUserCorrection(context:ExtractionContext,requestId:string,targetId:string,replacementId:string):'created'|'duplicate'{
  const view=this.view(context);if(!requestId?.trim()||!this.options.corrections)throw Error('extraction_user_correction_denied');
  const prior=this.corrections.find(c=>c.requestId===requestId);
  if(prior){if(prior.targetId!==targetId||prior.replacementId!==replacementId||keyOf(prior.context)!==keyOf(context))throw Error('extraction_correction_conflict');return 'duplicate';}
  const target=this.records.get(targetId),replacement=this.records.get(replacementId);
  if(!target?.candidate||!replacement?.candidate||replacement.proposal.claim.basis!=='explicit'||replacement.proposal.context.actorId!==context.actorId||keyOf(replacement.proposal.context)!==keyOf(context))throw Error('extraction_user_correction_denied');
  const origin=this.view(target.proposal.context);
  if(target.proposal.context.actorId!==context.actorId||!this.valid(target.proposal,origin)||!this.valid(replacement.proposal,view)
   ||target.proposal.context.audience!==context.audience||(keyOf(target.proposal.context)!==keyOf(context)&&(!view.privateOwnerId||view.privateOwnerId!==origin.privateOwnerId)))throw Error('extraction_user_correction_denied');
  const correction:UserCorrection={requestId,actorId:context.actorId,targetId,replacementId,sourceId:target.proposal.claim.sourceId,sourceVersion:target.proposal.claim.sourceVersion,context:contextOf(context)};
  const verify=()=>{this.unchanged(context,view);this.unchanged(target.proposal.context,origin);if(!this.options.corrections!.authorize(structuredClone(correction)))throw Error('extraction_user_correction_denied');};
  if(this.corrections.length>=this.limits.maxRecords)throw Error('extraction_correction_capacity');
  this.change(()=>this.corrections.push(correction),verify);return 'created';
 }
 inspect(context:ExtractionContext):{snapshot:Snapshot;proposals:EvidenceProposal[]}{
  const view=this.view(context);return {snapshot:this.pipeline(context,view).snapshot(),proposals:structuredClone([...this.records.values()].filter(e=>keyOf(e.proposal.context)===keyOf(context)).map(e=>e.proposal))};
 }
}
