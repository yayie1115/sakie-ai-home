import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, restoreBackup } from '../../database/backup.js';
import { preservedTables, assertPreservedTables, databaseFingerprint } from '../../database/fingerprint.js';
import { assertMigrationHistory, schemaVersion } from '../../database/migrations.js';
import { previousMutation, saveMutation, reviseMessage } from '../sync/mutations.js';
import { segmentSource, reviseSegment, isBatchParent } from './live-batch.js';
import { ChatError, ChatStore } from './store.js';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function currentMessage(store: ChatStore, id: string) {
    const p = segmentSource(store.db, id);
    const row = p ? { id, conversationId: String(p.conversation_id), turnId: String(p.turn_id), role: 'user' as const, content: String(p.content), revision: Number(p.revision), deleted: p.deleted_at, original: String(p.original_content), parentId: String(p.parent_id) } : store.db.prepare(`SELECT m.id,m.conversation_id AS conversationId,m.turn_id AS turnId,m.role,COALESCE(s.content,m.content) content,COALESCE(s.revision,1) revision,s.deleted_at AS deleted,m.content AS original,m.id AS parentId FROM chat_messages m LEFT JOIN chat_message_state s ON s.message_id=m.id WHERE m.id=?`).get(id);
    if (!row || row.deleted || !store.conversation(String(row.conversationId)) || !p && isBatchParent(store.db, id))
        throw new ChatError(404, 'MESSAGE_NOT_AVAILABLE');
    return { id, conversationId: String(row.conversationId), turnId: String(row.turnId), role: row.role as 'user' | 'assistant', content: String(row.content), revision: Number(row.revision), original: String(row.original), parentId: String(row.parentId) };
}
/** Revisions already live in the immutable v4 outbox; selecting one appends a fresh revision. */
export function messageVersions(store: ChatStore, id: string) {
    const m = currentMessage(store, id), versions = new Map<number, string>([[1, m.original]]);
    const rows = store.db.prepare(`SELECT payload FROM chat_outbox WHERE kind IN ('chat.message.created','chat.message.updated') AND json_extract(payload,'$.id')=? ORDER BY stream_seq`).all(m.parentId);
    for (const row of rows) {
        const p = JSON.parse(String(row.payload));
        if (id !== m.parentId) {
            const segment = p.segments?.find((s: {
                id: string;
            }) => s.id === id);
            if (segment && !segment.deletedAt)
                versions.set(Number(segment.revision), String(segment.content));
        }
        else if (!p.deletedAt)
            versions.set(Number(p.revision ?? 1), String(p.content));
    }
    versions.set(m.revision, m.content);
    const selections=store.db.prepare("SELECT result_json FROM sync_mutations WHERE json_extract(result_json,'$.id')=? AND json_type(result_json,'$.selectedVersionRevision')='integer'").all(id);
    const origins=new Map<number,number>();for(const row of selections){const result=JSON.parse(String(row.result_json));origins.set(Number(result.revision),Number(result.selectedVersionRevision));}
    let activeVersionRevision=m.revision;const seen=new Set<number>();while(origins.has(activeVersionRevision)){if(seen.has(activeVersionRevision))throw new ChatError(503,'VERSION_HISTORY_INVALID');seen.add(activeVersionRevision);activeVersionRevision=origins.get(activeVersionRevision)!;}
    return {id,currentRevision:m.revision,activeVersionRevision,items:[...versions].filter(([revision])=>!origins.has(revision)).sort(([a],[b])=>a-b).map(([revision,content])=>({revision,content}))};
}
export function selectMessageVersion(store: ChatStore, id: string, baseRevision: number, revision: number, requestId: string) {
    return store.transaction(() => {
        currentMessage(store, id);
        const request = { resource: 'chat-version-selection', id, baseRevision, revision };
        const prior = previousMutation<Record<string, unknown>>(store.db, requestId, request);
        if (prior)
            return prior;
        const m = currentMessage(store, id);
        if (m.revision !== baseRevision)
            throw new ChatError(409, 'REVISION_CONFLICT');
        const old = messageVersions(store, id).items.find(x => x.revision === revision);
        if (!old)
            throw new ChatError(404, 'VERSION_NOT_FOUND');
        // Same CAS/idempotent revision/outbox path as editing. Deterministic child mutation id is private to this request.
        const child = hash(['select', requestId]);
        const childId = child.slice(0, 8) + '-' + child.slice(8, 12) + '-4' + child.slice(13, 16) + '-a' + child.slice(17, 20) + '-' + child.slice(20, 32);
        const result = reviseSegment(store.db, id, baseRevision, childId, old.content, false) ?? reviseMessage(store.db, id, baseRevision, childId, old.content, false);
        // Persist selection with the revision in one transaction by the public wrapper below.
        const selected={...result,selectedVersionRevision:old.revision};
        saveMutation(store.db, requestId, request, selected);
        return selected;
    });
}
const sql = `CREATE TABLE chat_live_ops_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT;
CREATE TABLE chat_live_generations(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),turn_id TEXT NOT NULL REFERENCES chat_turns(id),message_id TEXT NOT NULL REFERENCES chat_messages(id),scope TEXT NOT NULL CHECK(scope IN ('bubble','turn')),base_revision INTEGER NOT NULL,context_hash TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','unknown')),partial TEXT NOT NULL DEFAULT '',error_code TEXT,result_revision INTEGER,usage_json TEXT,provider TEXT,model TEXT,provider_request_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE INDEX chat_live_generations_queue ON chat_live_generations(status,created_at);`;
const checksum = hash(sql);
export function operationsReady(db: DatabaseSync) { if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_live_ops_schema'").get())
    return false; if (db.prepare('SELECT checksum FROM chat_live_ops_schema WHERE version=1').get()?.checksum !== checksum)
    throw new ChatError(503, 'OPS_SCHEMA_MISMATCH'); return true; }
export function migrateOperations(db: DatabaseSync, verify: () => void = () => { }, before: () => void = () => { }) { if (operationsReady(db))
    return; assertMigrationHistory(db); if (schemaVersion(db) !== 4)
    throw Error('OPS_REQUIRES_V4'); db.exec('BEGIN IMMEDIATE'); try {
    before();
    db.exec(sql);
    db.prepare('INSERT INTO chat_live_ops_schema VALUES(1,?)').run(checksum);
    verify();
    if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw Error('OPS_FOREIGN_KEYS');
    db.exec('COMMIT');
}
catch (e) {
    db.exec('ROLLBACK');
    throw e;
} }
const busy = (db: DatabaseSync) => !!db.prepare("SELECT 1 FROM chat_turns WHERE status IN ('queued','running')").get() || !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_live_jobs'").get() && !!db.prepare("SELECT 1 FROM memory_live_jobs WHERE status IN ('queued','running')").get();
export async function upgradeOperations(filename: string, backups: string) { let d = new DatabaseSync(filename, { readOnly: true }); let tables: ReturnType<typeof preservedTables>, fingerprint: string; try {
    if (operationsReady(d))
        return { changed: false };
    if (busy(d))
        throw Error('OPS_DRAIN_REQUIRED');
    tables = preservedTables(d);
    fingerprint = databaseFingerprint(d);
}
finally {
    d.close();
} const backupDirectory = await createBackup(filename, backups), candidate = await restoreBackup(backupDirectory, join(mkdtempSync(join(backups, 'ops-rehearsal-')), 'candidate')); d = new DatabaseSync(candidate); try {
    migrateOperations(d, () => assertPreservedTables(d, tables!));
}
finally {
    d.close();
} d = new DatabaseSync(filename); try {
    d.exec('PRAGMA foreign_keys=ON');
    migrateOperations(d, () => assertPreservedTables(d, tables!), () => { if (busy(d) || databaseFingerprint(d) !== fingerprint!)
        throw Error('OPS_SOURCE_CHANGED'); });
}
finally {
    d.close();
} return { changed: true, backupDirectory, rehearsalDatabase: candidate }; }
export type { LiveChatGeneration as LiveGeneration } from '@sakie/contracts';
import type { LiveChatGeneration as LiveGeneration } from '@sakie/contracts';
export class LiveOperations {
    constructor(readonly store: ChatStore, private contextTurns: number) { }
    get ready() { return operationsReady(this.store.db); }
    active(conversationId?: string) { return this.ready ? this.store.db.prepare("SELECT id FROM chat_live_generations WHERE status IN ('pending','running')" + (conversationId ? ' AND conversation_id=?' : '') + ' LIMIT 1').get(...(conversationId ? [conversationId] : [])) : undefined; }
    snapshot(messageId: string) { const m = currentMessage(this.store, messageId), turn = this.store.turn(m.turnId); const history = this.store.db.prepare("SELECT id FROM chat_turns WHERE conversation_id=? AND turn_seq<=? AND status='succeeded' ORDER BY turn_seq DESC LIMIT ?").all(m.conversationId, turn.turnSeq, this.contextTurns + 1).map(t => this.store.turnMessages(String(t.id)).map(m => ({ id: m.id, revision: m.revision, content: m.content, quote: m.quote }))); const grants = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_live_grants'").get() ? this.store.db.prepare('SELECT * FROM memory_live_grants WHERE conversation_id=? ORDER BY actor').all(m.conversationId) : []; const scope = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_live_scopes'").get() ? this.store.db.prepare('SELECT * FROM memory_live_scopes WHERE conversation_id=?').all(m.conversationId) : []; return hash([this.store.conversation(m.conversationId)?.profile, grants, scope, history]); }
    enqueue(id: string, messageId: string, scope: 'bubble' | 'turn', base: number) { if (!this.ready)
        throw new ChatError(503, 'OPS_UPGRADE_REQUIRED'); const requestHash = hash([messageId, scope, base]), previous = this.store.db.prepare('SELECT request_hash FROM chat_live_generations WHERE id=?').get(id); if (previous) {
        if (previous.request_hash !== requestHash)
            throw new ChatError(409, 'GENERATION_ID_CONFLICT');
        return this.view(id);
    } const m = currentMessage(this.store, messageId); if (m.role !== 'assistant')
        throw new ChatError(400, 'ASSISTANT_REQUIRED'); if (m.revision !== base)
        throw new ChatError(409, 'REVISION_CONFLICT'); if (this.store.turn(m.turnId).status !== 'succeeded' || this.store.unresolved(m.conversationId) || this.active(m.conversationId))
        throw new ChatError(409, 'CHAT_IN_PROGRESS'); const now = new Date().toISOString(); this.store.db.prepare(`INSERT INTO chat_live_generations(id,conversation_id,turn_id,message_id,scope,base_revision,context_hash,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, m.conversationId, m.turnId, messageId, scope, base, this.snapshot(messageId), requestHash, now, now); return this.view(id); }
    view(id: string): LiveGeneration { const r = this.store.db.prepare('SELECT * FROM chat_live_generations WHERE id=?').get(id); if (!r || !this.store.conversation(String(r.conversation_id)))
        throw new ChatError(404, 'GENERATION_NOT_AVAILABLE'); let visible = false; try {
        visible = this.snapshot(String(r.message_id)) === r.context_hash;
    }
    catch { } return { id, conversationId: String(r.conversation_id), turnId: String(r.turn_id), messageId: String(r.message_id), scope: r.scope as LiveGeneration['scope'], status: r.status as LiveGeneration['status'], partial: visible ? String(r.partial) : '', errorCode: visible ? r.error_code as string | null : 'SOURCES_CHANGED', resultRevision: r.result_revision as number | null }; }
    assertCurrent(id: string) { const row = this.store.db.prepare('SELECT * FROM chat_live_generations WHERE id=?').get(id); if (!row || row.status !== 'running')
        throw new ChatError(409, 'GENERATION_CANCELLED'); if (this.snapshot(String(row.message_id)) !== row.context_hash)
        throw new ChatError(409, 'GENERATION_SOURCES_CHANGED'); return row; }
    recover() { if (this.ready)
        this.store.db.prepare("UPDATE chat_live_generations SET status='unknown',error_code='PROCESS_INTERRUPTED',updated_at=? WHERE status='running'").run(new Date().toISOString()); }
    next() { return this.ready ? this.store.db.prepare("SELECT id FROM chat_live_generations WHERE status='pending' ORDER BY rowid LIMIT 1").get() : undefined; }
    cancel(id: string) { const current = this.view(id); if (['pending', 'running'].includes(current.status))
        this.store.db.prepare("UPDATE chat_live_generations SET status='cancelled',error_code='USER_CANCELLED',updated_at=? WHERE id=? AND status IN ('pending','running')").run(new Date().toISOString(), id); return this.view(id); }
}

/** API-only metadata: no extra network request per bubble and no mutation of saved text. */
export function withVersionNavigation(store:ChatStore,messages:import('@sakie/contracts').ChatMessage[]){
 return messages.map(m=>{if((m.revision??1)<=1)return m;const history=messageVersions(store,m.id),index=history.items.findIndex(v=>v.revision===history.activeVersionRevision);if(index<0)throw new ChatError(503,'VERSION_HISTORY_INCOMPLETE');return {...m,versionNavigation:{index:index+1,total:history.items.length,previousRevision:history.items[index-1]?.revision,nextRevision:history.items[index+1]?.revision}};});
}
