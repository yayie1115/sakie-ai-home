/** MEM-03.9 synthetic transactional source and participant verification.
 * The trusted, server-side job specifies a message id, exact content revision and
 * content SHA256. All checks and the resulting write run on the SAME SQLite handle.
 * This is not a production migration nor a deletion/backup propagation mechanism.
 */
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {QueuedMemoryJob} from './grant-guard.js';
import type {ParticipantGrantResolver} from './chat-v4-authorized.js';
export type SourceBoundJob=QueuedMemoryJob & Readonly<{sourceMessageId:string;sourceRevision:number;sourceContentHash:string}>;
export type AtomicResult='committed'|'denied';

/** No await between BEGIN IMMEDIATE and COMMIT; do not call with nested transactions. */
export function commitSourceBoundJobAtomic<T>(db:DatabaseSync,job:SourceBoundJob,grants:ParticipantGrantResolver,prepared:T,write:(value:T)=>void):AtomicResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const grant=grants.resolve(job.conversationId,job.actorId);
    const allowed=grant.status==='allowed'&&grant.conversationId===job.conversationId&&grant.actorId===job.actorId&&!!job.grantRevision&&grant.grantRevision===job.grantRevision;
    if(!allowed||!Number.isSafeInteger(job.sourceRevision)||job.sourceRevision<1||!/^[0-9a-f]{64}$/.test(job.sourceContentHash)||!job.sourceMessageId){db.exec('ROLLBACK');return 'denied';}
    const row=db.prepare(`SELECT m.content AS original_content,m.conversation_id,s.content AS current_content,
      COALESCE(s.revision,1) AS revision,s.deleted_at AS deleted_at
      FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.id=?`).get(job.sourceMessageId) as {original_content:string;conversation_id:string;current_content:string|null;revision:number;deleted_at:string|null}|undefined;
    const content=row?(row.current_content??row.original_content):'';
    const live=!!row&&row.conversation_id===job.conversationId&&row.deleted_at===null&&row.revision===job.sourceRevision&&content.length>0&&createHash('sha256').update(content).digest('hex')===job.sourceContentHash;
    if(!live){db.exec('ROLLBACK');return 'denied';}
    write(prepared);
    db.exec('COMMIT');return 'committed';
  }catch(error){db.exec('ROLLBACK');throw error;}
}
