/** MEM-03.7: independent, synthetic-only grant guard for long-term recall and queued writes.
 * A caller-supplied actor is not authority. A trusted immutable provenance binding
 * records the conversation and grant revision under which each memory was derived.
 * This is an application gate, NOT secure erasure of stored copies.
 */
import type {ParticipantGrantResolver} from './chat-v4-authorized.js';
import type {Memory,Recall} from './memory.js';
import type {SqliteMemoryLab} from './sqlite.js';

export type MemoryProvenance = Readonly<{
  memoryId:string; owner:string; sourceId:string; conversationId:string; grantRevision:string;
}>;
export interface ProvenanceRegistry {get(memoryId:string):MemoryProvenance|undefined;}
export type GuardedRecall = Recall | {status:'permission_unavailable';memories:[]};

/** Must be populated by a trusted ingestion path, never by client model output. */
export class LabProvenanceRegistry implements ProvenanceRegistry {
  private readonly rows = new Map<string,MemoryProvenance>();
  add(binding:MemoryProvenance):void {
    if(Object.values(binding).some(v=>typeof v!=='string'||!v.trim()))throw Error('INVALID_PROVENANCE');
    const old=this.rows.get(binding.memoryId);
    if(old && JSON.stringify(old)!==JSON.stringify(binding))throw Error('PROVENANCE_CONFLICT');
    this.rows.set(binding.memoryId,Object.freeze({...binding}));
  }
  get(id:string):MemoryProvenance|undefined {return this.rows.get(id);}
}
function authorized(m:Memory,actor:string,grant:ParticipantGrantResolver,registry:ProvenanceRegistry):boolean {
  const p=registry.get(m.id);
  if(!p||p.memoryId!==m.id||p.owner!==actor||m.owner!==actor||p.sourceId!==m.sourceId)return false;
  try {
    const d=grant.resolve(p.conversationId,actor);
    return d.conversationId===p.conversationId&&d.actorId===actor&&d.status==='allowed'&&d.grantRevision===p.grantRevision&&!!d.grantRevision;
  }catch{return false;}
}
/** Post-filter both short-token and FTS paths: derived index hits do not grant access. */
export function guardedRecall(db:SqliteMemoryLab,actor:string,query:string,grants:ParticipantGrantResolver,registry:ProvenanceRegistry,limit=5):GuardedRecall {
  if(!actor.trim())return {status:'permission_unavailable',memories:[]};
  const raw=db.recall(actor,query,20);
  if(raw.status!=='ok')return raw;
  const memories=raw.memories.filter(m=>authorized(m,actor,grants,registry)).slice(0,limit);
  return {status:memories.length?'ok':'no_match',memories};
}
export type QueuedMemoryJob = Readonly<{jobId:string;actorId:string;conversationId:string;grantRevision:string}>;
/** Two checks: before preparation and immediately before synchronous commit. */
export async function commitAuthorizedJob<T>(job:QueuedMemoryJob,grants:ParticipantGrantResolver,prepare:()=>Promise<T>,commit:(prepared:T)=>void):Promise<'committed'|'denied'> {
  const check=()=>{
    try {const g=grants.resolve(job.conversationId,job.actorId);return g.status==='allowed'&&g.actorId===job.actorId&&g.conversationId===job.conversationId&&!!job.grantRevision&&g.grantRevision===job.grantRevision;}catch{return false;}
  };
  if(!check())return 'denied';
  const value=await prepare();
  if(!check())return 'denied';
  commit(value); // Must be synchronous and use a single DB transaction in production.
  return 'committed';
}

/** MEM-03.8 laboratory adapter: authorization and the DB write share ONE SQLite
 * IMMEDIATE transaction and the same connection. No await is allowed after BEGIN.
 * Real integration must also bind the source-version check to this transaction.
 */
export function commitAuthorizedJobAtomic<T>(
  db:import('node:sqlite').DatabaseSync,
  job:QueuedMemoryJob,
  grants:ParticipantGrantResolver,
  prepared:T,
  commit:(prepared:T)=>void,
):'committed'|'denied' {
  db.exec('BEGIN IMMEDIATE');
  try {
    const g=grants.resolve(job.conversationId,job.actorId);
    if(g.status!=='allowed'||g.actorId!==job.actorId||g.conversationId!==job.conversationId||!job.grantRevision||g.grantRevision!==job.grantRevision){
      db.exec('ROLLBACK');return 'denied';
    }
    commit(prepared);
    db.exec('COMMIT');return 'committed';
  }catch(e){db.exec('ROLLBACK');throw e;}
}
