import {NetworkPolicyError} from './network-policy.js';
import type {SyncTransport} from '@sakie/contracts';
import {LocalArchive,ArchiveError} from './archive.js';
import {TransportError} from './transport.js';
export interface RunnerOptions { batchSize?:number;pollMs?:number;retryBaseMs?:number;retryMaxMs?:number;now?:()=>number;random?:()=>number;afterCommit?:()=>void; }
export class SyncRunner {
 private options:Required<Omit<RunnerOptions,'afterCommit'>>&Pick<RunnerOptions,'afterCommit'>;
 constructor(readonly archive:LocalArchive,private transport:SyncTransport,options:RunnerOptions={}){
  this.options={batchSize:50,pollMs:5000,retryBaseMs:1000,retryMaxMs:60000,now:Date.now,random:Math.random,...options};
  for(const key of ['batchSize','pollMs','retryBaseMs','retryMaxMs'] as const)if(!Number.isSafeInteger(this.options[key])||this.options[key]<1)throw new Error('Invalid '+key);
  if(this.options.batchSize>100||this.options.retryMaxMs<this.options.retryBaseMs)throw new Error('Invalid sync bounds');
 }
 async syncOnce(){
  try{
   const identity=await this.archive.inspectIdentity();const local=await this.archive.cursor();
   const resume=await this.transport.resume({archive:identity,lastArchived:local});
   if(resume.status!=='resume')throw new ArchiveError('RECONCILE_'+resume.reason);
   if(!Number.isSafeInteger(resume.afterSeq)||resume.afterSeq<0||resume.afterSeq>(local?.contiguousSeq??0))throw new ArchiveError('SERVER_CURSOR_AHEAD');
   this.archive.bindStream(resume.streamId);
   const batch=await this.transport.pull(resume.afterSeq,this.options.batchSize);
   if(batch.streamId!==resume.streamId||batch.afterSeq!==resume.afterSeq||!Array.isArray(batch.events)||batch.events.length>this.options.batchSize||!Number.isSafeInteger(batch.headSeq)||batch.headSeq<resume.afterSeq)throw new ArchiveError('BATCH_ENVELOPE_INVALID');
   let last=resume.afterSeq;for(const event of batch.events){if(event.streamSeq!==last+1)throw new ArchiveError('EVENT_GAP');last=event.streamSeq;}
   if(batch.headSeq<last||(!batch.events.length&&batch.headSeq>last))throw new ArchiveError('BATCH_HEAD_INVALID');
   if(batch.events.length){
    await this.archive.commitBatch(batch.events);
    this.options.afterCommit?.();
    // Replayed pages can end BELOW our local cursor after an ACK loss or a fresh pairing.
    // Only confirm a delivered, already committed prefix; never advertise an undelivered local maximum.
    const receipt=await this.archive.receiptAt(last);const ack=await this.transport.acknowledge(receipt);
    if(ack.ackSeq!==last)throw new ArchiveError('ACK_RESPONSE_INVALID');
   }
   const caughtUp=last===batch.headSeq;this.archive.setRetry(0,this.options.now()+(caughtUp?this.options.pollMs:0),caughtUp?'caught-up':'catching-up',null);
   return{caughtUp,ackSeq:last,localSeq:(await this.archive.cursor())!.contiguousSeq,headSeq:batch.headSeq};
  }catch(error){
   const code=error instanceof ArchiveError||error instanceof TransportError||error instanceof NetworkPolicyError?error.code:'SYNC_NETWORK_UNAVAILABLE';
   const blocked=error instanceof NetworkPolicyError||error instanceof ArchiveError||(error instanceof TransportError&&!error.retryable);
   const failures=Math.min(this.archive.retryState().failures+1,30);
   const base=Math.min(this.options.retryMaxMs,this.options.retryBaseMs*2**Math.min(failures-1,20));
   const delay=Math.min(this.options.retryMaxMs,Math.round(base*(0.5+this.options.random()*0.5)));
   this.archive.setRetry(failures,this.options.now()+delay,blocked?'blocked':'offline',code);throw error;
  }
 }
 async run(signal:AbortSignal){
  while(!signal.aborted){
   const state=this.archive.retryState();if(state.phase==='blocked')throw new ArchiveError(state.lastError??'SYNC_BLOCKED');
   const delay=Math.max(0,state.nextRetryAt-this.options.now());
   if(delay)await new Promise<void>(resolve=>{const timer=setTimeout(done,Math.min(delay,this.options.retryMaxMs));function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
   if(signal.aborted)break;
   try{await this.syncOnce();}catch{if(this.archive.retryState().phase==='blocked')throw new ArchiveError(this.archive.retryState().lastError??'SYNC_BLOCKED');}
  }
 }
}
