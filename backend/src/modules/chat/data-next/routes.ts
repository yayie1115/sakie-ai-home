/** Isolated UI bridge only. v11 receipts/history are presentation adapters, not storage envelopes. */
import { Router, type ErrorRequestHandler } from 'express';
import type { V11History, V11SubmissionReceipt } from '@sakie/contracts';
import type { AuthService } from '../../auth/service.js';
import { ChatError } from '../store.js';
import { validateSubmission } from '../v11-lab/codec.js';
import { ChatOpsService } from './ops-service.js';
import { FakeGenerationRunner } from './fake-generation.js';
import { operation, object, requestId, revision } from './ops-codec.js';
export function data01Router(service: ChatOpsService, auth: AuthService, conversationId: string, runner: FakeGenerationRunner) {
    const r = Router();
    r.use((req, _res, next) => { try {
        auth.require(req);
        next();
    }
    catch (e) {
        next(e);
    } });
    r.get('/capabilities', (_req, res) => { service.current(conversationId); res.json({ synthetic: true, conversationId, capabilities: ['normalized-bubbles-v1','chat-ops02'], archive: service.archiveReadiness() }); });
    r.post('/conversations/:id/submit', async (req, res) => {
        const s = validateSubmission(req.body, service.limits.maxChars);
        if (s.conversationId !== conversationId || req.params.id !== conversationId)
            throw new ChatError(403, 'LAB_CONVERSATION_DENIED');
        // Read immutable quoted version by bubble+revision; operation ledger handles ACK-loss replay.
        const bubbles = s.bubbles.map(b => {
            if (!b.quote)
                return { id: b.id, content: b.content };
            const targetId = b.quote.bubbleId ?? b.quote.messageId, target = service.get(targetId);
            if (b.quote.conversationId !== conversationId || target.conversationId !== conversationId)
                throw new ChatError(403, 'QUOTE_SCOPE_DENIED');
            const old = service.db.prepare('SELECT version_id FROM chat_bubble_states WHERE bubble_id=? AND revision=?').get(targetId, b.quote.revision);
            const versionId = String(old?.version_id ?? 'missing');
            return { id: b.id, content: b.content, quote: { conversationId, bubbleId: targetId, versionId, revision: b.quote.revision, selectedText: b.quote.selectedText } };
        });
        const receipt = service.submit({ requestId: s.submissionId, conversationId, bubbles });
        const turn = service.legacy.turn(receipt.turnId);
        if (turn.status === 'queued') await runner.kick(turn.id);
        res.status(202).json({ ...receipt, submissionId: receipt.requestId, messageId: receipt.bubbleIds[0], turn: service.legacy.turn(receipt.turnId) } satisfies V11SubmissionReceipt);
    });
    const within=(bubbleId:string)=>{const b=service.get(bubbleId);if(b.conversationId!==conversationId)throw new ChatError(403,'LAB_CONVERSATION_DENIED');return b;};
    const jobWithin=(jobId:string)=>{const job=service.generation(jobId);if(service.legacy.turn(job.turnId).conversationId!==conversationId)throw new ChatError(403,'LAB_CONVERSATION_DENIED');return job;};
    r.get('/history', (_req,res)=>{const ops=service.history(conversationId);const bubbles=ops.items.map(b=>({id:b.id,turnId:b.turnId,role:b.role,content:b.content,sourceMessageId:b.id,sourceRevision:b.revision,createdAt:b.createdAt,position:b.position,...(b.quote?{quote:{conversationId,messageId:b.quote.bubbleId,bubbleId:b.quote.bubbleId,revision:b.quote.available?b.quote.revision:0,selectedText:b.quote.available?b.quote.selectedText:'引用来源已失效'}}:{})}));res.json({conversationId,bubbles,unresolvedTurn:service.legacy.unresolved(conversationId),ops});});
    r.post('/bubbles/:id/operations',(req,res)=>{const b=within(String(req.params.id)),op=operation(req.body,service.limits.maxChars);const result=service.mutate(b.id,op);if('jobId'in result)void runner.kick(result.jobId);res.json(result);});
    r.get('/bubbles/:id/current',(req,res)=>{const b=within(String(req.params.id));if(b.deleted||b.revision!==revision(Number(req.query.revision)))throw new ChatError(409,'QUOTE_NOT_CURRENT');res.json({id:b.id,content:b.content,revision:b.revision,versionId:b.activeVersionId});});
    r.get('/search',(req,res)=>{if(typeof req.query.q!=='string')throw new ChatError(400,'INVALID_QUERY');res.json({items:service.search(conversationId,req.query.q)});});
    r.get('/jobs/:id',(req,res)=>res.json(jobWithin(String(req.params.id))));
    r.post('/jobs/:id/cancel',(req,res)=>{const x=object(req.body,['requestId']);jobWithin(String(req.params.id));res.json(service.cancel(requestId(x.requestId),String(req.params.id)));});
    r.post('/jobs/:id/retry',(req,res)=>{const x=object(req.body,['requestId','acknowledgeUnknown']);if(typeof x.acknowledgeUnknown!=='boolean')throw new ChatError(400,'INVALID_OPERATION');jobWithin(String(req.params.id));const ack=service.retry(requestId(x.requestId),String(req.params.id),x.acknowledgeUnknown);void runner.kick(String(req.params.id));res.json(ack);});
    const errors: ErrorRequestHandler = (e, _req, res, next) => e instanceof ChatError ? res.status(e.status).json({ error: e.code }) : next(e);
    r.use(errors);
    return r;
}
