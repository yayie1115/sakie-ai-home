/** Isolated, synthetic-only participant authority. Not a production migration.
 * Access is checked against the CURRENT grant on every read, never cached.
 */
import type {DatabaseSync} from 'node:sqlite';
import type {ParticipantGrant,ParticipantGrantResolver} from './chat-v4-authorized.js';

export const PARTICIPANT_GRANTS_LAB_SCHEMA = `
CREATE TABLE IF NOT EXISTS mem_lab_participant_grants (
  conversation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  status TEXT NOT NULL CHECK(status IN ('allowed','denied')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,actor_id)
) STRICT;
`;

function validId(s:string):boolean{return typeof s==='string'&&s.length>0&&s.length<=160&&!/\s/.test(s);}

export class SqliteParticipantGrants implements ParticipantGrantResolver {
  constructor(private readonly db:DatabaseSync){}
  resolve(conversationId:string,actorId:string):ParticipantGrant {
    const missing:ParticipantGrant={conversationId,actorId,status:'unknown',grantRevision:''};
    if(!validId(conversationId)||!validId(actorId))return missing;
    const row=this.db.prepare('SELECT revision,status FROM mem_lab_participant_grants WHERE conversation_id=? AND actor_id=?').get(conversationId,actorId) as {revision:number;status:'allowed'|'denied'}|undefined;
    return row?{conversationId,actorId,status:row.status,grantRevision:String(row.revision)}:missing;
  }
  /** Only an explicitly trusted service should call this. A revision is incremented even on re-approval. */
  set(conversationId:string,actorId:string,status:'allowed'|'denied',at=new Date().toISOString()):number {
    if(!validId(conversationId)||!validId(actorId)||!['allowed','denied'].includes(status))throw new Error('INVALID_PARTICIPANT_GRANT');
    this.db.prepare(`INSERT INTO mem_lab_participant_grants(conversation_id,actor_id,revision,status,updated_at)
      VALUES(?,?,1,?,?) ON CONFLICT(conversation_id,actor_id) DO UPDATE SET
      revision=revision+1,status=excluded.status,updated_at=excluded.updated_at`).run(conversationId,actorId,status,at);
    return Number((this.db.prepare('SELECT revision FROM mem_lab_participant_grants WHERE conversation_id=? AND actor_id=?').get(conversationId,actorId) as {revision:number}).revision);
  }
  /** Prevent stale jobs from committing work derived under a superseded grant. */
  isCurrentAllowed(conversationId:string,actorId:string,revision:string):boolean {
    const grant=this.resolve(conversationId,actorId);
    return grant.status==='allowed'&&grant.grantRevision===revision;
  }
}
