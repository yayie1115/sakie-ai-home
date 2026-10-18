/** Isolated UI bridge only. v11 receipts/history are presentation adapters, not storage envelopes. */
import { Router, type ErrorRequestHandler } from 'express';
import type { V11History, V11SubmissionReceipt } from '@sakie/contracts';
import type { AuthService } from '../../auth/service.js';
import { ChatError } from '../store.js';
import { validateSubmission } from '../v11-lab/codec.js';
import { BubbleService } from './service.js';
import { randomUUID } from 'node:crypto';
export function data01Router(service: BubbleService, auth: AuthService, conversationId: string) {
    const r = Router();
    r.use((req, _res, next) => { try {
        auth.require(req);
        next();
    }
    catch (e) {
        next(e);
    } });
    r.get('/capabilities', (_req, res) => { service.current(conversationId); res.json({ synthetic: true, conversationId, capabilities: ['normalized-bubbles-v1'], archive: service.archiveReadiness() }); });
    r.post('/conversations/:id/submit', (req, res) => {
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
        if (turn.status === 'queued') {
            service.start(turn.id);
            const outputs = [{ id: randomUUID(), content: '[合成回复] ' + s.bubbles.map(b => b.content).join(' / ') }];
            service.complete(turn.id, outputs);
        }
        res.status(202).json({ ...receipt, submissionId: receipt.requestId, messageId: receipt.bubbleIds[0], turn: service.legacy.turn(receipt.turnId) } satisfies V11SubmissionReceipt);
    });
    r.get('/history', (_req, res) => { const bubbles = service.current(conversationId).map(b => ({ id: b.id, turnId: b.turnId, role: b.role, content: b.content, sourceMessageId: b.id, sourceRevision: b.revision, createdAt: b.createdAt, position: b.position, ...(b.quote ? { quote: { conversationId: b.quote.conversationId, messageId: b.quote.bubbleId, bubbleId: b.quote.bubbleId, revision: b.quote.revision, selectedText: b.quote.selectedText } } : {}) })); res.json({ conversationId, bubbles, unresolvedTurn: service.legacy.unresolved(conversationId) } satisfies V11History); });
    const errors: ErrorRequestHandler = (e, _req, res, next) => e instanceof ChatError ? res.status(e.status).json({ error: e.code }) : next(e);
    r.use(errors);
    return r;
}
