/** Isolated, conservative adapter from chat mutations to evidence-eligible sources.
 * It does NOT claim to parse current GitHub outbox wire formats or modify production DB.
 */
import type { SourceEvent } from './pipeline.js';
import type { Source } from './memory.js';

export type ChatMutation = {
  eventId: string; messageId: string; actorIds: string[];
  kind: 'created' | 'edited' | 'regenerated' | 'deleted' | 'conflict' | 'resolved';
  revision: number; content?: string; occurredAt: string;
  origin?: 'real' | 'game';
};
export type Projection = { status: 'eligible' | 'deleted' | 'conflicted'; revision: number; source?: SourceEvent };
type State = { revision: number; text: string; occurredAt: string; actorIds: string[]; origin: 'real' | 'game'; deleted: boolean; conflicted: boolean };

const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
const assert = (ok:unknown,code:string) => { if(!ok) throw Error(code); };
export class ChatSourceProjector {
  private events = new Map<string,ChatMutation>();
  private messages = new Map<string,State>();
  apply(e:ChatMutation): 'applied' | 'duplicate' {
    assert(!!e.eventId?.trim() && !!e.messageId?.trim(),'missing_id');
    assert(Number.isSafeInteger(e.revision) && e.revision>=1,'invalid_revision');
    assert(Array.isArray(e.actorIds) && e.actorIds.length>0 && e.actorIds.every(a=>typeof a==='string' && !!a.trim()),'invalid_scope');
    assert(Number.isFinite(Date.parse(e.occurredAt)),'invalid_time');
    const oldEvent=this.events.get(e.eventId);
    if(oldEvent){assert(same(oldEvent,e),'event_id_conflict');return 'duplicate';}
    const old=this.messages.get(e.messageId);
    if(!old){
      assert(e.kind==='created' && e.revision===1 && !!e.content?.trim(),'first_event_must_create');
      this.messages.set(e.messageId,{revision:1,text:e.content!,occurredAt:e.occurredAt,actorIds:[...e.actorIds],origin:e.origin??'real',deleted:false,conflicted:false});
    } else {
      assert(same(old.actorIds,e.actorIds) && old.origin===(e.origin??'real'),'immutable_provenance');
      assert(!old.deleted,'deleted_terminal');
      if(e.kind==='conflict') {
        assert(e.revision===old.revision,'conflict_revision_mismatch');
        old.conflicted=true;
      } else if(e.kind==='resolved') {
        assert(old.conflicted && e.revision===old.revision+1 && !!e.content?.trim(),'invalid_resolution');
        old.revision=e.revision;old.text=e.content!;old.occurredAt=e.occurredAt;old.conflicted=false;
      } else if(e.kind==='deleted') {
        assert(e.revision===old.revision+1,'stale_or_gapped_revision');
        old.revision=e.revision;old.deleted=true;old.text='';
      } else {
        assert(!old.conflicted,'unresolved_conflict');
        assert((e.kind==='edited'||e.kind==='regenerated') && e.revision===old.revision+1 && !!e.content?.trim(),'stale_or_gapped_revision');
        old.revision=e.revision;old.text=e.content!;old.occurredAt=e.occurredAt;
      }
    }
    this.events.set(e.eventId,structuredClone(e));
    return 'applied';
  }
  get(messageId:string):Projection | undefined {
    const s=this.messages.get(messageId);if(!s)return;
    if(s.deleted)return {status:'deleted',revision:s.revision};
    if(s.conflicted)return {status:'conflicted',revision:s.revision};
    const source:Source={id:messageId,version:String(s.revision),context:s.origin,scope:{type:'private',actors:[...s.actorIds]},active:true,deleted:false,occurredAt:s.occurredAt};
    return {status:'eligible',revision:s.revision,source:{eventId:`chat:${messageId}:v${s.revision}`,source,text:s.text}};
  }
  eligibleSources():SourceEvent[] {
    return [...this.messages.keys()].map(id=>this.get(id)!).filter((p):p is Projection & {source:SourceEvent}=>p.status==='eligible' && !!p.source).map(p=>structuredClone(p.source));
  }
}
