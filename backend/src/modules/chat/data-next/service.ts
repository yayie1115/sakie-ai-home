/** Normalized candidate in the EXISTING SQLite. Never mounted by production app.ts. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BubbleAccess, BubbleInput, BubbleQuote, BubbleSubmission, BubbleReceipt, CurrentBubble, BubbleVersion } from '@sakie/contracts';
import { ChatStore, ChatError, hashContent } from '../store.js';
import { assertData01Database } from './guard.js';
type Job = {
    id: string;
    turn_id: string;
    kind: string;
    request_hash: string;
    snapshot: string;
    status: string;
    result_hash: string | null;
    error_code: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, status = 409): never => { throw new ChatError(status, code); };
const exact = (v: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return fail('INVALID_DATA', 400);
    const x = v as Record<string, unknown>;
    if (required.some(k => !(k in x)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k)))
        fail('INVALID_DATA', 400);
    return x;
};
const id = (v: unknown): string => typeof v === 'string' && uuid.test(v) ? v : fail('INVALID_ID', 400);
const text = (v: unknown, max: number): string => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : fail('INVALID_TEXT', 400);
export class BubbleService {
    readonly legacy: ChatStore;
    constructor(readonly db: DatabaseSync, readonly access: (conversationId: string) => BubbleAccess, readonly limits = { maxBubbles: 8, maxChars: 12000 }) {
        assertData01Database(db);
        this.legacy = new ChatStore(db);
        if (!Number.isSafeInteger(limits.maxBubbles) || limits.maxBubbles < 1 || !Number.isSafeInteger(limits.maxChars) || limits.maxChars < 1)
            throw Error('INVALID_LIMITS');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_bubbles'").get())
            throw Error('CANDIDATE_MIGRATION_REQUIRED');
    }
    protected authorize(c: string, write = false) { const a = this.access(c); if (!a.read || write && !a.write || !a.audience)
        fail('CONVERSATION_DENIED', 403); return a; }
    protected event(kind: string, payload: unknown) { const raw = JSON.stringify(payload); this.db.prepare('INSERT INTO chat_bubble_outbox(event_id,kind,payload,payload_hash) VALUES (?,?,?,?)').run(randomUUID(), kind, raw, hashContent(raw)); }
    protected operation<T>(requestId: string, input: unknown, action: () => T): T {
        id(requestId);
        const digest = hashContent(JSON.stringify(input));
        return this.legacy.transaction(() => {
            const prior = this.db.prepare('SELECT * FROM chat_bubble_operations WHERE id=?').get(requestId);
            if (prior) {
                if (prior.request_hash !== digest)
                    fail('REQUEST_ID_CONFLICT');
                return JSON.parse(String(prior.result)) as T;
            }
            const result = action();
            this.db.prepare('INSERT INTO chat_bubble_operations VALUES (?,?,?)').run(requestId, digest, JSON.stringify(result));
            return result;
        });
    }
    private quote(value: unknown, conversationId: string): BubbleQuote {
        const q = exact(value, ['conversationId', 'bubbleId', 'versionId', 'revision', 'selectedText']);
        if (q.conversationId !== conversationId)
            fail('QUOTE_SCOPE_DENIED', 403);
        this.authorize(conversationId);
        const b = this.get(String(q.bubbleId));
        if (b.conversationId !== conversationId || b.deleted || b.revision !== q.revision || b.activeVersionId !== q.versionId)
            fail('QUOTE_NOT_CURRENT');
        const selected = text(q.selectedText, this.limits.maxChars);
        if (!b.content.includes(selected))
            fail('QUOTE_EVIDENCE_MISMATCH');
        return { conversationId, bubbleId: b.id, versionId: b.activeVersionId, revision: b.revision, selectedText: selected };
    }
    private validate(value: unknown): BubbleSubmission {
        const s = exact(value, ['requestId', 'conversationId', 'bubbles']);
        const requestId = id(s.requestId), conversationId = id(s.conversationId);
        if (!Array.isArray(s.bubbles) || !s.bubbles.length || s.bubbles.length > this.limits.maxBubbles)
            fail('INVALID_BATCH', 400);
        const seen = new Set<string>();
        let chars = 0;
        const bubbles = (s.bubbles as unknown[]).map(v => {
            const b = exact(v, ['id', 'content'], ['quote']);
            const bubbleId = id(b.id), content = text(b.content, this.limits.maxChars);
            chars += content.length;
            if (seen.has(bubbleId))
                fail('DUPLICATE_BUBBLE_ID', 400);
            seen.add(bubbleId);
            // Evidence validation is performed after idempotency lookup inside the write transaction.
            let quote: BubbleQuote | undefined;
            if (b.quote !== undefined) {
                const q = exact(b.quote, ['conversationId', 'bubbleId', 'versionId', 'revision', 'selectedText']);
                if (!Number.isSafeInteger(q.revision) || Number(q.revision) < 1)
                    fail('INVALID_QUOTE', 400);
                quote = { conversationId: id(q.conversationId), bubbleId: id(q.bubbleId), versionId: text(q.versionId, 200), revision: Number(q.revision), selectedText: text(q.selectedText, this.limits.maxChars) };
            }
            return { id: bubbleId, content, ...(quote ? { quote } : {}) };
        });
        if (chars > this.limits.maxChars)
            fail('BATCH_TOO_LARGE', 400);
        return { requestId, conversationId, bubbles };
    }
    private insertBubble(input: BubbleInput, conversationId: string, turnId: string, role: 'user' | 'assistant', position: number) {
        const versionId = randomUUID(), now = new Date().toISOString();
        this.db.prepare('INSERT INTO chat_bubbles VALUES (?,?,?,?,?,1,?,?,0)').run(input.id, conversationId, turnId, role, position, versionId, now);
        this.db.prepare("INSERT INTO chat_bubble_versions VALUES (?,?,1,?,'original',?)").run(versionId, input.id, input.content, now);
        if (input.quote) {
            const q = input.quote;
            this.db.prepare('INSERT INTO chat_bubble_quotes VALUES (?,?,?,?,?,?)').run(input.id, q.conversationId, q.bubbleId, q.versionId, q.revision, q.selectedText);
        }
        this.db.prepare('INSERT INTO chat_bubble_states VALUES (?,1,?)').run(input.id, versionId);
        this.event('bubble.created', this.get(input.id));
    }
    submit(value: unknown): BubbleReceipt {
        const s = this.validate(value);
        this.authorize(s.conversationId, true);
        return this.operation(s.requestId, { kind: 'submit', ...s }, () => {
            this.authorize(s.conversationId, true);
            if (!this.legacy.conversation(s.conversationId))
                fail('CONVERSATION_NOT_FOUND', 404);
            if (this.legacy.unresolved(s.conversationId))
                fail('TURN_UNRESOLVED');
            for (const b of s.bubbles) {
                if (this.db.prepare('SELECT 1 FROM chat_bubbles WHERE id=?').get(b.id))
                    fail('BUBBLE_ID_CONFLICT');
                if (b.quote)
                    b.quote = this.quote(b.quote, s.conversationId);
            }
            const seq = Number(this.db.prepare('SELECT next_turn_seq FROM chat_conversations WHERE id=?').get(s.conversationId)!.next_turn_seq);
            if (!Number.isSafeInteger(seq) || seq > Math.floor((Number.MAX_SAFE_INTEGER - 2) / 2))
                fail('SEQUENCE_EXHAUSTED');
            const turnId = randomUUID(), now = new Date().toISOString();
            // The hash covers the canonical batch, NOT a serialized message envelope.
            this.db.prepare("INSERT INTO chat_turns VALUES (?,?,?,?,?,'queued',NULL,?,?)").run(turnId, s.conversationId, s.requestId, hashContent(JSON.stringify(s)), seq, now, now);
            this.db.prepare('UPDATE chat_conversations SET next_turn_seq=next_turn_seq+1 WHERE id=?').run(s.conversationId);
            s.bubbles.forEach((b, i) => this.insertBubble(b, s.conversationId, turnId, 'user', i));
            const snapshot = JSON.stringify({ conversationId: s.conversationId, audience: this.authorize(s.conversationId).audience, targets: [], inputs: this.current(s.conversationId).map(b => ({ id: b.id, revision: b.revision, versionId: b.activeVersionId })) });
            this.db.prepare("INSERT INTO chat_bubble_jobs VALUES (?,?,'reply',?,?,'queued',NULL,NULL)").run(turnId, turnId, hashContent(snapshot), snapshot);
            return { requestId: s.requestId, conversationId: s.conversationId, turnId, turnSeq: seq, bubbleIds: s.bubbles.map(b => b.id), durable: true };
        });
    }
    get(bubbleId: string): CurrentBubble {
        const row = this.db.prepare('SELECT b.*,v.content FROM chat_bubbles b JOIN chat_bubble_versions v ON v.id=b.active_version_id AND v.bubble_id=b.id WHERE b.id=?').get(bubbleId);
        if (!row)
            fail('BUBBLE_NOT_FOUND', 404);
        const r = row!;
        this.authorize(String(r.conversation_id));
        const versions = this.db.prepare('SELECT id,ordinal,content,origin FROM chat_bubble_versions WHERE bubble_id=? ORDER BY ordinal').all(bubbleId) as unknown as BubbleVersion[];
        const q = this.db.prepare('SELECT conversation_id AS conversationId,target_bubble_id AS bubbleId,target_version_id AS versionId,target_revision AS revision,selected_text AS selectedText FROM chat_bubble_quotes WHERE bubble_id=?').get(bubbleId) as unknown as BubbleQuote | undefined;
        return { id: String(r.id), conversationId: String(r.conversation_id), turnId: String(r.turn_id), role: r.role as 'user' | 'assistant', position: Number(r.position), revision: Number(r.revision), activeVersionId: String(r.active_version_id), content: String(r.content), createdAt: String(r.created_at), deleted: !!r.deleted, versions: versions.map(v => ({ ...v })), ...(q ? { quote: { ...q } } : {}) };
    }
    current(conversationId: string): CurrentBubble[] { this.authorize(conversationId); return this.db.prepare("SELECT b.id FROM chat_bubbles b JOIN chat_turns t ON t.id=b.turn_id WHERE b.conversation_id=? AND b.deleted=0 ORDER BY t.turn_seq,CASE b.role WHEN 'user' THEN 0 ELSE 1 END,b.position").all(conversationId).map(r => this.get(String(r.id))); }
    /** Search and memory never see pending/unknown turns, old versions, or revoked audiences. */
    sources(conversationId: string) { const scope = this.authorize(conversationId); return this.current(conversationId).filter(b => this.legacy.turn(b.turnId).status === 'succeeded').map(b => ({ id: b.id, version: b.revision + ':' + b.activeVersionId, text: b.content, conversationId, audience: scope.audience, active: true as const, deleted: false as const })); }
    search(conversationId: string, query: string) { text(query, this.limits.maxChars); return this.sources(conversationId).filter(s => s.text.includes(query)); }
    evidenceCurrent(conversationId: string, source: {
        id: string;
        version: string;
    }) { return this.sources(conversationId).some(s => s.id === source.id && s.version === source.version); }
    private mutable(bubbleId: string, expected: number) { const b = this.get(bubbleId); this.authorize(b.conversationId, true); if (b.deleted || b.revision !== expected)
        fail('REVISION_CONFLICT'); if (this.legacy.turn(b.turnId).status !== 'succeeded')
        fail('TURN_NOT_COMPLETE'); return b; }
    private activate(b: CurrentBubble, versionId: string) { this.db.prepare('UPDATE chat_bubbles SET active_version_id=?,revision=revision+1 WHERE id=?').run(versionId, b.id); this.db.prepare('INSERT INTO chat_bubble_states VALUES (?,?,?)').run(b.id, b.revision + 1, versionId); this.event('bubble.active-version', this.get(b.id)); return this.get(b.id); }
    edit(requestId: string, bubbleId: string, expected: number, content: string) {
        const before = this.get(bubbleId);
        this.authorize(before.conversationId, true);
        text(content, this.limits.maxChars);
        return this.operation(requestId, { kind: 'edit', bubbleId, expected, content }, () => { const b = this.mutable(bubbleId, expected), v = randomUUID(); this.db.prepare("INSERT INTO chat_bubble_versions VALUES (?,?,?,?,'edit',?)").run(v, b.id, Math.max(...b.versions.map(v => v.ordinal)) + 1, content, new Date().toISOString()); return this.activate(b, v); });
    }
    switchVersion(requestId: string, bubbleId: string, expected: number, versionId: string) {
        const before = this.get(bubbleId);
        this.authorize(before.conversationId, true);
        return this.operation(requestId, { kind: 'switch', bubbleId, expected, versionId }, () => { const b = this.mutable(bubbleId, expected); if (!b.versions.some(v => v.id === versionId))
            fail('VERSION_SCOPE_DENIED'); return this.activate(b, versionId); });
    }
    softDelete(requestId: string, bubbleId: string, expected: number) {
        const before = this.get(bubbleId);
        this.authorize(before.conversationId, true);
        return this.operation(requestId, { kind: 'delete', bubbleId, expected }, () => { const b = this.mutable(bubbleId, expected); this.db.prepare('UPDATE chat_bubbles SET deleted=1,revision=revision+1 WHERE id=?').run(b.id); this.event('bubble.deleted', this.get(b.id)); return { deleted: true }; });
    }
    prepareRegeneration(requestId: string, turnId: string, bubbleId?: string, expected?: {bubbleId:string;revision:number}) {
        const turn = this.legacy.turn(turnId);
        this.authorize(turn.conversationId, true);
        id(requestId);
        return this.operation(requestId, { kind: 'regeneration', turnId, bubbleId: bubbleId ?? null, ...(expected?{expected}:{}) }, () => {
            if(expected){const selected=this.get(expected.bubbleId);if(selected.turnId!==turnId||selected.role!=='assistant'||selected.deleted||selected.revision!==expected.revision)fail('REVISION_CONFLICT');}
            if (turn.status !== 'succeeded')
                fail('TURN_NOT_COMPLETE');
            if(this.db.prepare("SELECT 1 FROM chat_bubble_jobs WHERE turn_id=? AND status IN ('queued','running','unknown')").get(turnId))fail('GENERATION_BUSY');
            const all = this.current(turn.conversationId).filter(b => b.turnId === turnId && b.role === 'assistant');
            const targets = bubbleId ? all.filter(b => b.id === bubbleId) : all;
            if (!targets.length)
                fail('REGENERATION_TARGET_DENIED');
            const snapshot = JSON.stringify({ conversationId: turn.conversationId, audience: this.authorize(turn.conversationId).audience, targets: targets.map(b => ({ id: b.id, revision: b.revision, versionId: b.activeVersionId })), inputs: this.sources(turn.conversationId).map(s => ({ id: s.id, version: s.version })) });
            this.db.prepare("INSERT INTO chat_bubble_jobs VALUES (?,?,'regeneration',?,?,'queued',NULL,NULL)").run(requestId, turnId, hashContent(snapshot), snapshot);
            return { jobId: requestId };
        });
    }
    protected job(jobId: string, write = true): Job { const j = this.db.prepare('SELECT * FROM chat_bubble_jobs WHERE id=?').get(jobId) as unknown as Job | undefined; if (!j)
        fail('JOB_NOT_FOUND', 404); this.authorize(this.legacy.turn(j!.turn_id).conversationId, write); return j!; }
    start(jobId: string) { return this.legacy.transaction(() => { const j = this.job(jobId); if (j.status !== 'queued')
        fail('JOB_NOT_QUEUED'); this.db.prepare("UPDATE chat_bubble_jobs SET status='running' WHERE id=?").run(jobId); if (j.kind === 'reply')
        this.db.prepare("UPDATE chat_turns SET status='running' WHERE id=?").run(j.turn_id); }); }
    recoverInterrupted() { return this.legacy.transaction(() => { const rows = this.db.prepare("SELECT * FROM chat_bubble_jobs WHERE status='running'").all() as unknown as Job[]; for (const j of rows) {
        this.job(j.id);
        this.db.prepare("UPDATE chat_bubble_jobs SET status='unknown',error_code='PROCESS_INTERRUPTED' WHERE id=?").run(j.id);
        if (j.kind === 'reply')
            this.db.prepare("UPDATE chat_turns SET status='unknown',error_code='PROCESS_INTERRUPTED' WHERE id=?").run(j.turn_id);
    } return rows.length; }); }
    retryUnknown(jobId: string, acknowledge: boolean) { return this.legacy.transaction(() => { const j = this.job(jobId); if (j.status !== 'unknown' || acknowledge !== true)
        fail('UNKNOWN_ACK_REQUIRED'); this.db.prepare("UPDATE chat_bubble_jobs SET status='queued',error_code=NULL WHERE id=?").run(jobId); if (j.kind === 'reply')
        this.db.prepare("UPDATE chat_turns SET status='queued',error_code=NULL WHERE id=?").run(j.turn_id); }); }
    retryFailed(jobId: string) { return this.legacy.transaction(() => { const j = this.job(jobId); if (j.status !== 'failed')
        fail('JOB_NOT_FAILED'); this.db.prepare("UPDATE chat_bubble_jobs SET status='queued',error_code=NULL WHERE id=?").run(jobId); if (j.kind === 'reply')
        this.db.prepare("UPDATE chat_turns SET status='queued',error_code=NULL WHERE id=?").run(j.turn_id); }); }
    fail(jobId: string) { return this.legacy.transaction(() => { const j = this.job(jobId); if (j.status !== 'running')
        fail('JOB_NOT_RUNNING'); this.db.prepare("UPDATE chat_bubble_jobs SET status='failed',error_code='MODEL_FAILED' WHERE id=?").run(jobId); if (j.kind === 'reply')
        this.db.prepare("UPDATE chat_turns SET status='failed',error_code='MODEL_FAILED' WHERE id=?").run(j.turn_id); }); }
    complete(jobId: string, outputs: BubbleInput[]) {
        if (!Array.isArray(outputs) || !outputs.length || outputs.length > this.limits.maxBubbles)
            fail('INVALID_OUTPUT', 400);
        for (const o of outputs) {
            exact(o, ['id', 'content']);
            id(o.id);
            text(o.content, this.limits.maxChars);
        }
        if (new Set(outputs.map(o => o.id)).size !== outputs.length || outputs.reduce((n, o) => n + o.content.length, 0) > this.limits.maxChars)
            fail('INVALID_OUTPUT', 400);
        return this.legacy.transaction(() => {
            const j = this.job(jobId), digest = hashContent(JSON.stringify(outputs));
            if (j.status === 'succeeded') {
                if (j.result_hash !== digest)
                    fail('RESULT_CONFLICT');
                return { durable: true };
            }
            if (j.status !== 'running')
                fail('JOB_NOT_RUNNING');
            const snapshot = JSON.parse(j.snapshot) as {
                conversationId: string;
                audience: string;
                targets: {
                    id: string;
                    revision: number;
                    versionId: string;
                }[];
                inputs: ({
                    id: string;
                    version?: string;
                    revision?: number;
                    versionId?: string;
                })[];
            };
            if (this.authorize(snapshot.conversationId, true).audience !== snapshot.audience)
                fail('AUDIENCE_CHANGED');
            for (const input of snapshot.inputs) {
                const b = this.get(input.id);
                if (b.deleted || input.version !== undefined && input.version !== b.revision + ':' + b.activeVersionId || input.revision !== undefined && (b.revision !== input.revision || b.activeVersionId !== input.versionId))
                    fail('SOURCE_CHANGED');
            }
            if (j.kind === 'reply') {
                outputs.forEach((o, i) => this.insertBubble(o, snapshot.conversationId, j.turn_id, 'assistant', i));
                this.db.prepare("UPDATE chat_turns SET status='succeeded',error_code=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), j.turn_id);
            }
            else {
                if (outputs.length !== snapshot.targets.length || outputs.some((o, i) => o.id !== snapshot.targets[i].id))
                    fail('REGENERATION_TARGET_MISMATCH');
                for (const [i, o] of outputs.entries()) {
                    const target = snapshot.targets[i], b = this.mutable(o.id, target.revision);
                    if (b.activeVersionId !== target.versionId)
                        fail('SOURCE_CHANGED');
                    const v = randomUUID();
                    this.db.prepare("INSERT INTO chat_bubble_versions VALUES (?,?,?,?,'regeneration',?)").run(v, b.id, Math.max(...b.versions.map(v => v.ordinal)) + 1, o.content, new Date().toISOString());
                    this.activate(b, v);
                }
            }
            this.db.prepare("UPDATE chat_bubble_jobs SET status='succeeded',result_hash=? WHERE id=?").run(digest, jobId);
            this.event('turn.completed', { jobId, turnId: j.turn_id, bubbleIds: outputs.map(o => o.id) });
            return { durable: true };
        });
    }
    recordTool(eventId: string, turnId: string, toolName: string, state: 'requested' | 'succeeded' | 'failed' | 'unknown', detail: string) {
        this.authorize(this.legacy.turn(turnId).conversationId, true);
        id(eventId);
        text(toolName, 100);
        text(detail, this.limits.maxChars);
        if (!['requested', 'succeeded', 'failed', 'unknown'].includes(state))
            fail('INVALID_TOOL_STATE', 400);
        return this.operation(eventId, { kind: 'tool', turnId, toolName, state, detail }, () => { this.db.prepare('INSERT INTO chat_tool_events VALUES (?,?,?,?,?)').run(eventId, turnId, toolName, state, detail); this.event('tool.event', { eventId, turnId, toolName, state, detail }); return { eventId }; });
    }
    archiveReadiness() { return { compatibleWithV4: false, canPrune: false, pending: Number(this.db.prepare('SELECT count(*) AS n FROM chat_bubble_outbox').get()!.n), reason: 'BUBBLE_ARCHIVE_CAPABILITY_REQUIRED' } as const; }
}
