/** MEM-02 isolated evidence-first extraction and revision. No model calls. */
import { MemoryStore, type Source, type Kind, type NewMemory, type Recall } from './memory.js';

export type SourceEvent = { eventId: string; source: Source; text: string };
export type Candidate = {
  id: string; owner: string; sourceId: string; sourceVersion: string;
  kind: Kind; statement: string; evidenceQuote: string; confidence: number;
  salience: number; perspective?: string; supersedes?: string;
};
export type IngestResult = { status: 'created' | 'duplicate'; memoryId: string };
export type Snapshot = { schema: 1; events: SourceEvent[]; candidates: Candidate[]; decisions: {eventId:string; candidateId:string}[] };
const clean = (s:string) => s.normalize('NFKC').trim();
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
function checkId(v:string) { if (!v?.trim()) throw Error('missing_id'); }

export class MemoryPipeline {
  private events = new Map<string,SourceEvent>();
  private candidates = new Map<string,Candidate>();
  private decisions = new Map<string,string>();
  private store = new MemoryStore();

  acceptEvent(event:SourceEvent):void {
    checkId(event.eventId); checkId(event.source.id);
    if (!clean(event.text)) throw Error('empty_event');
    const prev=this.events.get(event.eventId);
    if (prev) { if(!same(prev,event)) throw Error('event_id_conflict'); return; }
    const prior=[...this.events.values()].find(e=>e.source.id===event.source.id);
    if(prior && prior.source.deleted && !event.source.deleted) throw Error('source_deleted_terminal');
    this.store.putSource(event.source);
    this.events.set(event.eventId,structuredClone(event));
  }
  /** Model output is never automatically trusted: caller supplies quoted verbatim evidence. */
  acceptCandidate(decisionEventId:string, c:Candidate):IngestResult {
    checkId(decisionEventId); checkId(c.id);
    const oldDecision=this.decisions.get(decisionEventId);
    if(oldDecision) {
      const existing=this.candidates.get(oldDecision);
      if(oldDecision!==c.id || !same(existing,c)) throw Error('decision_id_conflict');
      return {status:'duplicate',memoryId:oldDecision};
    }
    const prior=this.candidates.get(c.id);
    if(prior) throw Error('candidate_id_conflict');
    const matching=[...this.events.values()].filter(e=>e.source.id===c.sourceId && e.source.version===c.sourceVersion && !e.source.deleted && e.source.active);
    if(!matching.length) throw Error('source_not_current');
    if(!c.evidenceQuote?.trim() || !matching.some(e=>clean(e.text).includes(clean(c.evidenceQuote)))) throw Error('evidence_not_found');
    // A quote supports that words occurred; it cannot establish the truth of a model inference.
    if(c.kind==='fact' && clean(c.statement)!==clean(c.evidenceQuote)) throw Error('fact_must_be_verbatim');
    const {evidenceQuote: _quote, ...body}=c;
    const memory:NewMemory={...body};
    this.store.add(memory);
    this.candidates.set(c.id,structuredClone(c));
    this.decisions.set(decisionEventId,c.id);
    return {status:'created',memoryId:c.id};
  }
  revokeSource(id:string):void {
    this.store.revoke(id);
    for (const [eid,e] of this.events) if(e.source.id===id) this.events.set(eid,{...e,source:{...e.source,active:false,deleted:true}});
  }
  recall(actor:string,query:string,limit=5):Recall { return this.store.recall(actor,query,limit); }
  snapshot():Snapshot {
    // Permanently revoked source contents and all derived claims must not be persisted.
    const liveEvents=[...this.events.values()].filter(e=>!e.source.deleted && e.source.active);
    const liveSources=new Set(liveEvents.map(e=>`${e.source.id}::${e.source.version}`));
    const candidates=[...this.candidates.values()].filter(c=>liveSources.has(`${c.sourceId}::${c.sourceVersion}`));
    const validIds=new Set(candidates.map(c=>c.id));
    return structuredClone({schema:1 as const,events:liveEvents,candidates,decisions:[...this.decisions].filter(([,id])=>validIds.has(id)).map(([eventId,candidateId])=>({eventId,candidateId}))});
  }
  static fromSnapshot(s:Snapshot):MemoryPipeline {
    if(s?.schema!==1 || !Array.isArray(s.events)||!Array.isArray(s.candidates)||!Array.isArray(s.decisions)) throw Error('snapshot_schema');
    const p=new MemoryPipeline();
    // Reconstruct deleted sources by registering their pre-deletion state first, then revoking them.
    for(const e of s.events){p.acceptEvent({...e,source:e.source.deleted?{...e.source,deleted:false,active:true}:e.source});}
    for(const c of s.candidates){const d=s.decisions.find(x=>x.candidateId===c.id);if(!d)throw Error('snapshot_missing_decision');p.acceptCandidate(d.eventId,c);}
    const deleted=new Set(s.events.filter(e=>e.source.deleted).map(e=>e.source.id));
    for(const id of deleted)p.revokeSource(id);
    if(p.decisions.size!==s.decisions.length)throw Error('snapshot_duplicate_decision');
    return p;
  }
}
