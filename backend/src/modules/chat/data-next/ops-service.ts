import { randomUUID } from 'node:crypto';
import type { BubbleQuote, BubbleOperation, GenerationView, OpsHistory } from '@sakie/contracts';
import { BubbleService } from './service.js';
import { ChatError } from '../store.js';
export class ChatOpsService extends BubbleService {
    mutate(bubbleId: string, op: BubbleOperation) {
        const b = this.get(bubbleId);
        this.authorize(b.conversationId, true);
        if (op.kind === 'edit')
            this.edit(op.requestId, bubbleId, op.expectedRevision, op.content);
        else if (op.kind === 'switch')
            this.switchVersion(op.requestId, bubbleId, op.expectedRevision, op.versionId);
        else if (op.kind === 'delete')
            this.softDelete(op.requestId, bubbleId, op.expectedRevision);
        else
            return { ...this.prepareRegeneration(op.requestId, b.turnId, op.kind === 'regenerate' ? b.id : undefined, { bubbleId: b.id, revision: op.expectedRevision }), requestId: op.requestId, durable: true as const };
        return { requestId: op.requestId, durable: true as const };
    }
    quoteView(q: BubbleQuote) {
        try {
            const b = this.get(q.bubbleId);
            if (b.conversationId === q.conversationId && !b.deleted && b.revision === q.revision && b.activeVersionId === q.versionId && b.content.includes(q.selectedText))
                return { ...q, available: true as const };
        }
        catch (e) {
            if (!(e instanceof ChatError) || ![403, 404].includes(e.status))
                throw e;
        }
        return { bubbleId: q.bubbleId, available: false as const };
    }
    history(conversationId: string): OpsHistory {
        const items = this.current(conversationId).map(b => { const { quote, ...body } = b; return { ...body, ...(quote ? { quote: this.quoteView(quote) } : {}) }; });
        const jobs = this.db.prepare('SELECT j.id FROM chat_bubble_jobs j JOIN chat_turns t ON t.id=j.turn_id WHERE t.conversation_id=? ORDER BY j.rowid DESC LIMIT 30').all(conversationId).map(r => this.generation(String(r.id)));
        return { conversationId, items, jobs };
    }
    generation(jobId: string): GenerationView {
        const j = this.job(jobId, false), snapshot = JSON.parse(j.snapshot) as {
            audience: string;
            inputs: {
                id: string;
                version?: string;
                revision?: number;
                versionId?: string;
            }[];
        };
        const conversationId = this.legacy.turn(j.turn_id).conversationId;
        let evidence = true;
        try {
            if (this.authorize(conversationId).audience !== snapshot.audience)
                evidence = false;
            for (const input of snapshot.inputs) {
                const b = this.get(input.id);
                if (b.deleted || (input.version !== undefined ? input.version !== b.revision + ':' + b.activeVersionId : b.revision !== input.revision || b.activeVersionId !== input.versionId))
                    evidence = false;
            }
        }
        catch (e) {
            if (e instanceof ChatError && [403, 404].includes(e.status))
                evidence = false;
            else
                throw e;
        }
        const attempts = this.db.prepare('SELECT attempt FROM chat_generation_attempts WHERE job_id=? ORDER BY attempt').all(jobId).map(r => Number(r.attempt));
        const partials = evidence ? attempts.map(attempt => ({ attempt, outputs: this.db.prepare("SELECT bubble_id AS bubbleId,group_concat(content,'') AS text FROM (SELECT bubble_id,content FROM chat_generation_chunks WHERE job_id=? AND attempt=? ORDER BY seq) GROUP BY bubble_id").all(jobId, attempt).map(r => ({ bubbleId: String(r.bubbleId), text: String(r.text) })) })) : [];
        return { id: j.id, turnId: j.turn_id, kind: j.kind as 'reply' | 'regeneration', status: j.error_code === 'CANCELLED' ? 'cancelled' : j.status as GenerationView['status'], errorCode: j.error_code, attempt: attempts.at(-1) ?? 0, partials, evidenceAvailable: evidence };
    }
    ensureTargets(jobId: string) {
        return this.legacy.transaction(() => {
            const j = this.job(jobId);
            const old = this.targets(jobId);
            if (old.length)
                return old;
            if (j.status !== 'queued')
                throw new ChatError(409, 'JOB_NOT_QUEUED');
            const snapshot = JSON.parse(j.snapshot) as {
                targets: {
                    id: string;
                }[];
            };
            const ids = j.kind === 'reply' ? [randomUUID()] : snapshot.targets.map(t => t.id);
            ids.forEach((id, i) => this.db.prepare('INSERT INTO chat_generation_targets VALUES (?,?,?)').run(jobId, id, i));
            return ids;
        });
    }
    targets(jobId: string) { this.job(jobId, false); return this.db.prepare('SELECT bubble_id FROM chat_generation_targets WHERE job_id=? ORDER BY position').all(jobId).map(r => String(r.bubble_id)); }
    appendChunk(jobId: string, attempt: number, seq: number, bubbleId: string, content: string) {
        return this.legacy.transaction(() => {
            const j = this.job(jobId);
            if (j.status !== 'running' || this.generation(jobId).attempt !== attempt)
                throw new ChatError(409, 'JOB_NOT_RUNNING');
            if (!this.targets(jobId).includes(bubbleId) || typeof content !== 'string' || content.length > this.limits.maxChars || !Number.isSafeInteger(seq) || seq < 1)
                throw new ChatError(400, 'INVALID_CHUNK');
            const old = this.db.prepare('SELECT * FROM chat_generation_chunks WHERE job_id=? AND attempt=? AND seq=?').get(jobId, attempt, seq);
            if (old) {
                if (old.bubble_id !== bubbleId || old.content !== content)
                    throw new ChatError(409, 'CHUNK_CONFLICT');
                return;
            }
            const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM chat_generation_chunks WHERE job_id=? AND attempt=?').get(jobId, attempt)!.n);
            if (seq !== max + 1)
                throw new ChatError(409, 'CHUNK_GAP');
            const size = Number(this.db.prepare('SELECT COALESCE(SUM(length(content)),0) AS n FROM chat_generation_chunks WHERE job_id=? AND attempt=?').get(jobId, attempt)!.n);
            if (size + content.length > this.limits.maxChars)
                throw new ChatError(400, 'OUTPUT_TOO_LARGE');
            this.db.prepare('INSERT INTO chat_generation_chunks VALUES (?,?,?,?,?)').run(jobId, attempt, seq, bubbleId, content);
        });
    }
    finishChunks(jobId: string) {
        const view = this.generation(jobId);
        if (!view.evidenceAvailable)
            throw new ChatError(409, 'SOURCE_CHANGED');
        const chunks = view.partials.find(p => p.attempt === view.attempt)?.outputs ?? [];
        const outputs = this.targets(jobId).map(id => ({ id, content: chunks.find(c => c.bubbleId === id)?.text ?? '' }));
        return this.complete(jobId, outputs);
    }
    stopFailed(jobId: string) {
        return this.legacy.transaction(() => {
            const j = this.job(jobId);
            if (!['queued', 'running'].includes(j.status))
                return;
            this.db.prepare("UPDATE chat_bubble_jobs SET status='failed',error_code='MODEL_FAILED' WHERE id=?").run(jobId);
            if (j.kind === 'reply')
                this.db.prepare("UPDATE chat_turns SET status='failed',error_code='MODEL_FAILED' WHERE id=?").run(j.turn_id);
        });
    }
    cancel(requestId: string, jobId: string) {
        this.job(jobId);
        return this.operation(requestId, { kind: 'cancel', jobId }, () => {
            const j = this.job(jobId);
            if (j.status === 'succeeded')
                throw new ChatError(409, 'JOB_ALREADY_SUCCEEDED');
            if(j.error_code==='CANCELLED')return {requestId,durable:true as const};
            if(!['queued','running','unknown'].includes(j.status))throw new ChatError(409,'JOB_NOT_CANCELLABLE');
            this.db.prepare("UPDATE chat_bubble_jobs SET status='failed',error_code='CANCELLED' WHERE id=?").run(jobId);
            if (j.kind === 'reply')
                this.db.prepare("UPDATE chat_turns SET status='failed',error_code='CANCELLED' WHERE id=?").run(j.turn_id);
            this.event('generation.cancelled', { jobId });
            return { requestId, durable: true as const };
        });
    }
    retry(requestId: string, jobId: string, acknowledgeUnknown: boolean) {
        this.job(jobId);
        return this.operation(requestId, { kind: 'retry', jobId, acknowledgeUnknown }, () => {
            const j = this.job(jobId);
            if (!['failed', 'unknown'].includes(j.status))
                throw new ChatError(409, 'JOB_NOT_RETRYABLE');
            if(!this.generation(jobId).evidenceAvailable)throw new ChatError(409,'SOURCE_CHANGED');
            if (j.status === 'unknown' && acknowledgeUnknown !== true)
                throw new ChatError(409, 'UNKNOWN_ACK_REQUIRED');
            if (this.db.prepare("SELECT 1 FROM chat_bubble_jobs WHERE turn_id=? AND id!=? AND status IN ('queued','running','unknown')").get(j.turn_id, jobId))
                throw new ChatError(409, 'GENERATION_BUSY');
            this.db.prepare("UPDATE chat_bubble_jobs SET status='queued',error_code=NULL WHERE id=?").run(jobId);
            if (j.kind === 'reply')
                this.db.prepare("UPDATE chat_turns SET status='queued',error_code=NULL WHERE id=?").run(j.turn_id);
            return { requestId, durable: true as const };
        });
    }
}
