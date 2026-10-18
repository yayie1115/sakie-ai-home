import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { IsolatedMemoryExtractor, type ExtractionContext, type EvidenceReviewer, type CurrentEvidenceReader } from '../src/modules/memory-next/extraction-service.js';
import { SqliteExtractionLab, extractionLabMarker } from '../src/modules/memory-next/extraction-journal.js';
import type { ExtractionStateStore, UserCorrectionAuthority } from '../src/modules/memory-next/extraction-state.js';
import type { SourceEvent } from '../src/modules/memory-next/pipeline.js';
import type { ExtractedClaim, ExtractionProvider } from '../src/modules/memory-next/extraction-provider.js';
const context:ExtractionContext={actorId:'yan',conversationId:'A',audience:'private'};
const quote='I like green tea';
function source(id='m1',text=quote,audience:'private'|'group'='private'):SourceEvent{return {eventId:id+':v1',text,source:{id,version:'1',context:'real',scope:{type:audience,actors:['yan','owner']},active:true,deleted:false,occurredAt:'2026-10-18T00:00:00Z'}};}
function claim(e:SourceEvent,kind:ExtractedClaim['kind']='preference'):ExtractedClaim{return {kind,sourceId:e.source.id,sourceVersion:e.source.version,sourceEventId:e.eventId,statement:e.text,evidenceQuote:e.text,confidence:.8,salience:.5,basis:kind==='impression'?'interpretation':'explicit',...(kind==='impression'?{perspective:'self' as const}:{})};}
const approve:EvidenceReviewer={async review(){return 'approve';}};
function fixture(){const root=process.env.TEST_DATA_ROOT??join(tmpdir(),'sakie-memory-synthetic-tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'mem04-synthetic-'));writeFileSync(join(dir,'synthetic-marker.txt'),extractionLabMarker,{flag:'wx'});const path=join(dir,'extractor.sqlite');return {dir,path,journal:SqliteExtractionLab.open(path)};}
function setup(options:{store?:ExtractionStateStore;reviewer?:EvidenceReviewer;corrections?:UserCorrectionAuthority;model?:ExtractionProvider['extract']}={}){
 const rooms:Record<string,{status:'allowed'|'denied';revision:string;audience:'private'|'group';owner?:string;sources:SourceEvent[]}>= {
  A:{status:'allowed',revision:'1',audience:'private',owner:'owner',sources:[source()]},B:{status:'allowed',revision:'1',audience:'private',owner:'owner',sources:[]},
  C:{status:'allowed',revision:'1',audience:'private',owner:'different-owner',sources:[]},G:{status:'allowed',revision:'1',audience:'group',sources:[source('group','Group-only note','group')]},
 };
 let calls=0;
 const reader:CurrentEvidenceReader={readCurrent(c){const r=rooms[c.conversationId];return {conversationId:c.conversationId,audience:r.audience,...(r.owner?{privateOwnerId:r.owner}:{}),sources:r.sources};}};
 const grants={resolve(conversationId:string,actorId:string){const r=rooms[conversationId];return {conversationId,actorId,status:r?.status??'unknown' as const,grantRevision:r?.revision??''};}};
 const provider:ExtractionProvider={version:'fake-v1',async extract(request){calls++;if(options.model)return options.model(request);const claims=request.batch.sourceRefs.map(r=>claim(Object.values(rooms).flatMap(r=>r.sources).find(e=>e.eventId===r.eventId)!));return JSON.stringify({schema:1,candidates:claims});}};
 const make=(store=options.store,reviewer=options.reviewer??approve)=>new IsolatedMemoryExtractor(grants,reader,provider,reviewer,{}, {stateStore:store,corrections:options.corrections});
 return {rooms,reader,grants,provider,make,get calls(){return calls;}};
}
async function approved(service:IsolatedMemoryExtractor,ctx=context,job='one'){const [p]=await service.extract(ctx,job);assert.equal(await service.reviewAndCommit(ctx,p.id),'created');return p;}

test('same-persona same-owner private continuity is default, but other owners and groups never inherit it',async()=>{
 const f=setup(),s=f.make();const p=await approved(s);
 assert.equal(s.recall({...context,conversationId:'B'},'green',5).memories[0].id,p.id);
 assert.equal(s.recall({...context,conversationId:'C'},'green',5).memories.length,0);
 assert.equal(s.recall({...context,conversationId:'G',audience:'group'},'green',5).memories.length,0);
 assert.equal(s.recall({...context,actorId:'other'},'green',5).memories.length,0);
});
test('missing trusted owner metadata conservatively disables cross-private sharing',async()=>{
 const f=setup();delete f.rooms.A.owner;delete f.rooms.B.owner;const s=f.make();await approved(s);
 assert.equal(s.recall(context,'green',5).memories.length,1);assert.equal(s.recall({...context,conversationId:'B'},'green',5).memories.length,0);
});
test('origin revocation, source editing and deletion immediately remove cross-private recall',async()=>{
 for(const mutation of ['revoke','edit','delete']){const f=setup(),s=f.make();await approved(s);if(mutation==='revoke')f.rooms.A.status='denied';if(mutation==='edit')f.rooms.A.sources[0].source.version='2';if(mutation==='delete'){f.rooms.A.sources[0].source.active=false;f.rooms.A.sources[0].source.deleted=true;}
  assert.equal(s.recall({...context,conversationId:'B'},'green',5).memories.length,0);
 }
});
test('grant reapproval and changed private ownership do not reactivate old evidence',async()=>{
 const f=setup(),s=f.make();await approved(s);f.rooms.A.revision='2';assert.equal(s.recall({...context,conversationId:'B'},'green',5).memories.length,0);
 const other=setup(),t=other.make();await approved(t);other.rooms.A.owner='different-owner';assert.equal(t.recall({...context,conversationId:'B'},'green',5).memories.length,0);
});
test('origin authority unavailable fails closed; final origin check detects a later revocation',async()=>{
 const f=setup(),s=f.make();await approved(s);const original=f.reader.readCurrent;f.reader.readCurrent=c=>{if(c.conversationId==='A')throw Error('unavailable');return original(c);};
 assert.equal(s.recall({...context,conversationId:'B'},'green',5).status,'unavailable');
 f.reader.readCurrent=original;let reads=0;f.reader.readCurrent=c=>{const result=original(c);if(c.conversationId==='B'&&++reads===2)f.rooms.A.status='denied';return result;};
 // Rechecking A after the target check must reject rather than return its secret.
 try{const result=s.recall({...context,conversationId:'B'},'green',5);assert.equal(result.memories.length,0);}catch(e){assert.match((e as Error).message,/authorized|changed/);}
});
test('pending and approved records, evidence and completed jobs survive SQLite close/reopen without another model call',async()=>{
 const lab=fixture();let journal=lab.journal;try{const f=setup({store:journal}),s=f.make();const [p]=await s.extract(context,'one');journal.close();journal=SqliteExtractionLab.open(lab.path);
 const restored=f.make(journal);assert.deepEqual(await restored.extract(context,'one'),[p]);assert.equal(f.calls,1);assert.equal(restored.recall(context,'green',5).memories.length,0);
 assert.equal(await restored.reviewAndCommit(context,p.id),'created');journal.close();journal=SqliteExtractionLab.open(lab.path);const again=f.make(journal);
 assert.equal(await again.reviewAndCommit(context,p.id),'duplicate');assert.equal(again.recall({...context,conversationId:'B'},'green',5).memories.length,1);assert.equal(journal.integrity(),'ok');assert.equal(f.calls,1);
 }finally{journal.close();}
});
test('review rejection is terminal and durable; later reviewers cannot silently approve it',async()=>{
 const lab=fixture();let journal=lab.journal;try{let reviews=0;const f=setup({store:journal,reviewer:{async review(){reviews++;return 'reject';}}});const s=f.make();const [p]=await s.extract(context,'one');assert.equal(await s.reviewAndCommit(context,p.id),'rejected');journal.close();journal=SqliteExtractionLab.open(lab.path);
 const next=f.make(journal,{async review(){reviews++;return 'approve';}});assert.equal(await next.reviewAndCommit(context,p.id),'rejected');assert.equal(reviews,1);assert.equal(next.recall(context,'green',5).memories.length,0);
 }finally{journal.close();}
});
test('reviewer errors and malformed decisions leave proposals pending and allow an explicit retry',async()=>{
 let calls=0;const f=setup({reviewer:{async review(){calls++;if(calls===1)throw Error('synthetic reviewer outage');if(calls===2)return 'maybe' as 'approve';return 'approve';}}}),s=f.make();const [p]=await s.extract(context,'one');
 await assert.rejects(s.reviewAndCommit(context,p.id),/reviewer_failed/);await assert.rejects(s.reviewAndCommit(context,p.id),/invalid_review_decision/);assert.equal(s.inspect(context).snapshot.candidates.length,0);assert.equal(await s.reviewAndCommit(context,p.id),'created');
});
test('reviewer timeout does not promote late approval',async()=>{
 const f=setup();const service=new IsolatedMemoryExtractor(f.grants,f.reader,f.provider,{async review(){await new Promise(r=>setTimeout(r,30));return 'approve';}},{timeoutMs:5});const [p]=await service.extract(context,'one');await assert.rejects(service.reviewAndCommit(context,p.id),/reviewer_failed/);await new Promise(r=>setTimeout(r,40));assert.equal(service.inspect(context).snapshot.candidates.length,0);
});
test('a failed durable approval cannot leak success; reopen restores pending and can explicitly retry',async()=>{
 const lab=fixture();try{let fail=true;const wrapper:ExtractionStateStore={read:()=>lab.journal.read(),write:(rev,state,verify)=>{if(fail&&state.records.some(([,r])=>r.candidate))throw Error('synthetic disk failure');return lab.journal.write(rev,state,verify);}};
 const f=setup({store:wrapper}),s=f.make();const [p]=await s.extract(context,'one');await assert.rejects(s.reviewAndCommit(context,p.id),/disk failure/);assert.throws(()=>s.recall(context,'green',5),/storage_unavailable/);assert.equal(lab.journal.read().state!.records[0][1].candidate,undefined);
 fail=false;const reopened=f.make(lab.journal);assert.equal(await reopened.reviewAndCommit(context,p.id),'created');assert.equal(f.calls,1);
 }finally{lab.journal.close();}
});
test('durable preflight rechecks sources before approval and blocks a race',async()=>{
 const lab=fixture();try{const f=setup();let inject=false;const wrapper:ExtractionStateStore={read:()=>lab.journal.read(),write:(rev,state,verify)=>{if(inject&&state.records.some(([,r])=>r.candidate))f.rooms.A.sources[0].source.version='2';return lab.journal.write(rev,state,verify);}};const s=f.make(wrapper);const [p]=await s.extract(context,'one');inject=true;await assert.rejects(s.reviewAndCommit(context,p.id),/changed/);assert.equal(lab.journal.read().state!.records[0][1].candidate,undefined);
 }finally{lab.journal.close();}
});
test('stale SQLite writers fail CAS before another model call',async()=>{
 const lab=fixture();const other=SqliteExtractionLab.open(lab.path);try{const f=setup(),a=f.make(lab.journal),b=f.make(other);await a.extract(context,'one');await assert.rejects(b.extract(context,'other'),/checkpoint_conflict/);assert.equal(f.calls,1);assert.throws(()=>b.inspect(context),/storage_unavailable/);
 }finally{other.close();lab.journal.close();}
});
test('actual process exit after durable job admission requires explicit interrupted-job acknowledgement',async()=>{
 const lab=fixture();lab.journal.close();
 const worker=fileURLToPath(new URL('./fixtures/memory-extraction-crash.ts',import.meta.url));const run=spawnSync(process.execPath,['--import','tsx',worker,lab.path],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(run.status,71,run.stderr);
 const journal=SqliteExtractionLab.open(lab.path);try{const f=setup({store:journal}),s=f.make();await assert.rejects(s.extract(context,'interrupted'),/interrupted_ack_required/);assert.equal(f.calls,0);s.acknowledgeInterruptedJob(context,'interrupted');assert.equal((await s.extract(context,'interrupted')).length,1);assert.equal(f.calls,1);assert.equal(journal.integrity(),'ok');
 }finally{journal.close();}
});
test('corrupted journal checksum and unmarked paths fail before any extraction',()=>{
 const lab=fixture();lab.journal.write(0,{schema:1,records:[],jobs:[],corrections:[]},()=>{});lab.journal.close();const db=new DatabaseSync(lab.path);db.exec("UPDATE mem04_state SET payload='{}'");db.close();const journal=SqliteExtractionLab.open(lab.path);try{assert.throws(()=>setup({store:journal}).make(),/journal_corrupt/);assert.throws(()=>SqliteExtractionLab.open(join(lab.dir,'not-extractor.sqlite')),/synthetic_path_only/);}finally{journal.close();}
});
test('deletion and revocation are rechecked after restart, not trusted from a stored approved snapshot',async()=>{
 const lab=fixture();try{const f=setup({store:lab.journal}),s=f.make();await approved(s);f.rooms.A.status='denied';const restored=f.make(lab.journal);assert.equal(restored.recall({...context,conversationId:'B'},'green',5).memories.length,0);assert.equal(lab.journal.read().state!.records.length,0);
 }finally{lab.journal.close();}
});
test('trusted user correction wins over old impressions and cannot be undone by duplicate extraction',async()=>{
 const f=setup({corrections:{authorize:()=>true},model:async req=>{const e=Object.values(f.rooms).flatMap(r=>r.sources).find(e=>e.eventId===req.batch.sourceRefs[0].eventId)!;const c=claim(e,e.source.id==='m1'?'impression':'preference');if(c.kind==='impression')c.statement='I feel green tea is a favorite';return JSON.stringify({schema:1,candidates:[c]});}}),s=f.make();const old=await approved(s);
 f.rooms.B.sources=[source('correction','I dislike green tea now')];const replacement=await approved(s,{...context,conversationId:'B'},'correction');
 assert.equal(s.applyUserCorrection({...context,conversationId:'B'},'owner-request',old.id,replacement.id),'created');assert.equal(s.applyUserCorrection({...context,conversationId:'B'},'owner-request',old.id,replacement.id),'duplicate');
 assert.deepEqual(s.recall(context,'green',5).memories.map(m=>m.id),[replacement.id]);await s.extract(context,'reextract-old');assert.deepEqual(s.recall(context,'green',5).memories.map(m=>m.id),[replacement.id]);
 f.rooms.B.sources[0].source.deleted=true;f.rooms.B.sources[0].source.active=false;assert.equal(s.recall(context,'green',5).memories.length,0);
});
test('untrusted correction is denied and correction masks survive SQLite restart',async()=>{
 const lab=fixture();try{const f=setup({store:lab.journal,corrections:{authorize:()=>true}}),s=f.make();const old=await approved(s);f.rooms.B.sources=[source('correction','I dislike green tea now')];const replacement=await approved(s,{...context,conversationId:'B'},'replacement');
 const noAuthority=setup().make();assert.throws(()=>noAuthority.applyUserCorrection(context,'forged',old.id,replacement.id),/correction_denied/);
 s.applyUserCorrection({...context,conversationId:'B'},'owner-request',old.id,replacement.id);const restored=f.make(lab.journal);assert.deepEqual(restored.recall(context,'green',5).memories.map(m=>m.id),[replacement.id]);assert.equal(restored.applyUserCorrection({...context,conversationId:'B'},'owner-request',old.id,replacement.id),'duplicate');
 }finally{lab.journal.close();}
});

test('malformed extraction output records a failed job, and explicit retry after reopening is safe',async()=>{
 const lab=fixture();try{let malformed=true;const f=setup({store:lab.journal,model:async()=>malformed?'{':JSON.stringify({schema:1,candidates:[claim(source())]})}),s=f.make();
 await assert.rejects(s.extract(context,'retry'),/invalid_json/);assert.equal(lab.journal.read().state!.jobs[0][1].status,'failed');assert.equal(lab.journal.read().state!.records.length,0);
 malformed=false;const restored=f.make(lab.journal);const [p]=await restored.extract(context,'retry');assert.equal(f.calls,2);assert.equal(await restored.reviewAndCommit(context,p.id),'created');assert.equal(restored.recall(context,'green',5).memories.length,1);
 }finally{lab.journal.close();}
});
test('a trusted correction authority denying an actual request leaves both source claims unchanged',async()=>{
 const f=setup({corrections:{authorize:()=>false}}),s=f.make();const old=await approved(s);f.rooms.B.sources=[source('correction','I dislike green tea now')];const replacement=await approved(s,{...context,conversationId:'B'},'replacement');
 await assert.rejects(async()=>s.applyUserCorrection({...context,conversationId:'B'},'denied',old.id,replacement.id),/correction_denied/);
 assert.equal(s.recall(context,'green',5).memories.length,2);
});
test('user correction cannot use a different owner or group as its replacement audience',async()=>{
 const f=setup({corrections:{authorize:()=>true}}),s=f.make();const old=await approved(s);f.rooms.C.sources=[source('other','I dislike green tea')];const other=await approved(s,{...context,conversationId:'C'},'other');
 assert.throws(()=>s.applyUserCorrection({...context,conversationId:'C'},'cross-owner',old.id,other.id),/correction_denied/);
 const group=await approved(s,{...context,conversationId:'G',audience:'group'},'group');assert.throws(()=>s.applyUserCorrection({...context,conversationId:'G',audience:'group'},'cross-group',old.id,group.id),/correction_denied/);
 assert.equal(s.recall(context,'green',5).memories.length,1);
});
test('concurrent reject/approve decisions cannot flip an already terminal rejection',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let reviews=0;
 const f=setup({reviewer:{async review(){reviews++;if(reviews===1)return 'reject';await gate;return 'approve';}}}),s=f.make();const [p]=await s.extract(context,'one');
 const rejected=s.reviewAndCommit(context,p.id),late=s.reviewAndCommit(context,p.id);assert.equal(await rejected,'rejected');release();assert.equal(await late,'rejected');assert.equal(s.recall(context,'green',5).memories.length,0);
});
