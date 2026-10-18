import type { BubbleInput } from '@sakie/contracts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, migrations, schemaVersion } from '../src/database/migrations.js';
import { ChatStore } from '../src/modules/chat/store.js';
import { BubbleService } from '../src/modules/chat/data-next/service.js';
import { data01Migrations, migrateSyntheticChatData } from '../src/modules/chat/data-next/schema.js';
import { data01Marker } from '../src/modules/chat/data-next/guard.js';
const root = process.env.TEST_DATA_ROOT;
function fixture(db = new DatabaseSync(':memory:')) { db.exec('PRAGMA foreign_keys=ON'); migrateSyntheticChatData(db); const conversationId = randomUUID(); let allowed = true, audience = 'private:owner'; const service = new BubbleService(db, c => ({ read: allowed && c === conversationId, write: allowed && c === conversationId, audience })); service.legacy.createConversation(conversationId, 'synthetic'); return { db, service, conversationId, revoke() { allowed = false; }, audience() { audience = 'group:other'; }, close() { db.close(); } }; }
const bubble = (content = 'synthetic') => ({ id: randomUUID(), content });
const request = (conversationId: string, bubbles: BubbleInput[] = [bubble(), bubble('second')]) => ({ requestId: randomUUID(), conversationId, bubbles });
function reply(f: ReturnType<typeof fixture>, s = request(f.conversationId)) { const receipt = f.service.submit(s); f.service.start(receipt.turnId); const outputs = [bubble('assistant one'), bubble('assistant two')]; f.service.complete(receipt.turnId, outputs); return { receipt, outputs, s }; }
const count = (db: DatabaseSync, table: string) => Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
test('candidate migration is additive, repeatable, preserves legacy v4 identities/hash/outbox and known revisions', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db);
    const old = new ChatStore(db), c = randomUUID();
    old.createConversation(c, 'old');
    const receipt = await old.accept({ conversationId: c, clientMessageId: randomUUID(), content: 'original legacy' });
    db.prepare("UPDATE chat_turns SET status='succeeded' WHERE id=?").run(receipt.turnId);
    db.prepare('INSERT INTO chat_message_state VALUES (?,4,?,NULL)').run(receipt.messageId, 'known revision four');
    const before = JSON.stringify(db.prepare('SELECT * FROM chat_messages').all()), outbox = JSON.stringify(db.prepare('SELECT * FROM chat_outbox').all());
    migrateSyntheticChatData(db);
    migrateSyntheticChatData(db);
    assert.equal(schemaVersion(db), 5);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM chat_messages').all()), before);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM chat_outbox').all()), outbox);
    const svc = new BubbleService(db, () => ({ read: true, write: true, audience: 'owner' })), b = svc.get(receipt.messageId);
    assert.deepEqual(b.versions.map(v => v.ordinal), [1, 4]);
    assert.equal(b.content, 'known revision four');
    assert.equal(b.revision, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
});
test('injected migration interruption rolls back schema, ledger and user_version', () => { const db = new DatabaseSync(':memory:'); migrate(db); assert.throws(() => migrate(db, data01Migrations, { afterStep(v) { if (v === 5)
        throw Error('interrupted'); } }), /interrupted/); assert.equal(schemaVersion(db), 4); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_bubbles'").get(), undefined); assert.equal(count(db, 'schema_migrations'), 4); migrateSyntheticChatData(db); db.close(); });
test('invalid candidate SQL rolls back without changing v4', () => { const db = new DatabaseSync(':memory:'); migrate(db); assert.throws(() => migrate(db, [...migrations, { version: 5, name: 'fault', sql: 'CREATE TABLE synthetic_fault(id TEXT); INVALID SQL;' }])); assert.equal(schemaVersion(db), 4); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='synthetic_fault'").get(), undefined); db.close(); });
test('multi bubble turn has stable IDs, independent rows and deterministic order without message envelopes', () => { const f = fixture(); try {
    const { s, receipt } = reply(f);
    const rows = f.service.current(f.conversationId);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.slice(0, 2).map(b => b.id), s.bubbles.map(b => b.id));
    assert.ok(rows.every(b => b.turnId === receipt.turnId));
    assert.deepEqual(rows.map(b => b.position), [0, 1, 0, 1]);
    assert.equal(count(f.db, 'chat_messages'), 0);
    assert.equal(count(f.db, 'chat_turns'), 1);
}
finally {
    f.close();
} });
test('ACK lost retries return original durable receipt after completion', () => { const f = fixture(); try {
    const { s, receipt } = reply(f);
    assert.deepEqual(f.service.submit(s), receipt);
    assert.deepEqual(f.service.submit(s), receipt);
    assert.equal(count(f.db, 'chat_turns'), 1);
    assert.equal(count(f.db, 'chat_bubbles'), 4);
}
finally {
    f.close();
} });
test('same request different second bubble conflicts without writes', () => { const f = fixture(); try {
    const { s } = reply(f);
    const before = count(f.db, 'chat_bubble_outbox');
    assert.throws(() => f.service.submit({ ...s, bubbles: [s.bubbles[0], { ...s.bubbles[1], content: 'changed' }] }), /REQUEST_ID_CONFLICT/);
    assert.equal(count(f.db, 'chat_bubble_outbox'), before);
}
finally {
    f.close();
} });
test('bubble UUID cannot be reused across turns', () => { const f = fixture(); try {
    const { s } = reply(f);
    assert.throws(() => f.service.submit(request(f.conversationId, [s.bubbles[0]])), /BUBBLE_ID_CONFLICT/);
    assert.equal(count(f.db, 'chat_turns'), 1);
}
finally {
    f.close();
} });
test('one unresolved turn blocks further admission without sequence advancement', () => { const f = fixture(); try {
    f.service.submit(request(f.conversationId));
    assert.throws(() => f.service.submit(request(f.conversationId)), /TURN_UNRESOLVED/);
    assert.equal(f.db.prepare('SELECT next_turn_seq AS n FROM chat_conversations').get()!.n, 2);
}
finally {
    f.close();
} });
test('strict input rejects unknown fields, nontext tool bubbles and duplicate IDs', () => { const f = fixture(); try {
    const s = request(f.conversationId);
    assert.throws(() => f.service.submit({ ...s, tool: 'real' }), /INVALID_DATA/);
    assert.throws(() => f.service.submit({ ...s, bubbles: [{ ...s.bubbles[0], kind: 'tool' }] }), /INVALID_DATA/);
    assert.throws(() => f.service.submit({ ...s, bubbles: [s.bubbles[0], s.bubbles[0]] }), /DUPLICATE_BUBBLE_ID/);
    assert.throws(() => f.service.submit({ ...s, bubbles: [{ id: 'not-id', content: 'x' }] }), /INVALID_ID/);
    assert.equal(count(f.db, 'chat_turns'), 0);
}
finally {
    f.close();
} });
test('configured batch and character limits enforce atomic admission', () => { const f = fixture(); try {
    const limited = new BubbleService(f.db, f.service.access, { maxBubbles: 1, maxChars: 3 });
    assert.throws(() => limited.submit(request(f.conversationId)), /INVALID_BATCH/);
    assert.throws(() => limited.submit(request(f.conversationId, [bubble('long')])), /INVALID_TEXT/);
    assert.equal(count(f.db, 'chat_turns'), 0);
}
finally {
    f.close();
} });
test('quote stores immutable bubble/version/revision and exact selected evidence', () => { const f = fixture(); try {
    const { s } = reply(f), target = f.service.get(s.bubbles[0].id);
    const q = { conversationId: f.conversationId, bubbleId: target.id, versionId: target.activeVersionId, revision: target.revision, selectedText: 'synthetic' };
    const next = request(f.conversationId, [{ ...bubble('quote reply'), quote: q }]);
    f.service.submit(next);
    assert.deepEqual(f.service.get(next.bubbles[0].id).quote, q);
}
finally {
    f.close();
} });
for (const scenario of ['forged', 'stale', 'cross-scope'] as const)
    test('quote rejects ' + scenario, () => { const f = fixture(); try {
        const { s } = reply(f), target = f.service.get(s.bubbles[0].id);
        const q = { conversationId: scenario === 'cross-scope' ? randomUUID() : f.conversationId, bubbleId: target.id, versionId: target.activeVersionId, revision: scenario === 'stale' ? 9 : 1, selectedText: scenario === 'forged' ? 'not evidence' : 'synthetic' };
        assert.throws(() => f.service.submit(request(f.conversationId, [{ ...bubble(), quote: q }])));
        assert.equal(count(f.db, 'chat_turns'), 1);
    }
    finally {
        f.close();
    } });
test('single bubble edit preserves original and later replies without regeneration', () => { const f = fixture(); try {
    const { s, outputs } = reply(f);
    const original = f.service.get(s.bubbles[0].id), later = JSON.stringify(f.service.get(outputs[0].id));
    const b = f.service.edit(randomUUID(), original.id, 1, 'edited user');
    assert.equal(b.revision, 2);
    assert.equal(b.versions[0].content, 'synthetic');
    assert.equal(b.versions.length, 2);
    assert.equal(JSON.stringify(f.service.get(outputs[0].id)), later);
    assert.equal(count(f.db, 'chat_bubble_jobs'), 1);
}
finally {
    f.close();
} });
test('edit CAS and operation replay cannot duplicate versions', () => { const f = fixture(); try {
    const { s } = reply(f), id = randomUUID();
    const b = f.service.edit(id, s.bubbles[0].id, 1, 'edit');
    assert.deepEqual(f.service.edit(id, b.id, 1, 'edit'), b);
    assert.throws(() => f.service.edit(randomUUID(), b.id, 1, 'race'), /REVISION_CONFLICT/);
    assert.equal(f.service.get(b.id).versions.length, 2);
}
finally {
    f.close();
} });
test('switching back increments evidence revision and never resurrects stale memory source', () => { const f = fixture(); try {
    const { s } = reply(f), old = f.service.sources(f.conversationId)[0], b = f.service.get(s.bubbles[0].id);
    const edited = f.service.edit(randomUUID(), b.id, 1, 'changed');
    assert.equal(f.service.evidenceCurrent(f.conversationId, old), false);
    const back = f.service.switchVersion(randomUUID(), b.id, edited.revision, b.activeVersionId);
    assert.equal(back.content, 'synthetic');
    assert.equal(back.revision, 3);
    assert.equal(f.service.evidenceCurrent(f.conversationId, old), false);
    assert.equal(f.service.search(f.conversationId, 'changed').length, 0);
}
finally {
    f.close();
} });
test('version from another bubble cannot be activated', () => { const f = fixture(); try {
    const { s } = reply(f);
    assert.throws(() => f.service.switchVersion(randomUUID(), s.bubbles[0].id, 1, f.service.get(s.bubbles[1].id).activeVersionId), /VERSION_SCOPE_DENIED/);
}
finally {
    f.close();
} });
test('soft delete hides search/memory but keeps raw versions and quotations', () => { const f = fixture(); try {
    const { s } = reply(f), source = f.service.sources(f.conversationId)[0];
    f.service.softDelete(randomUUID(), source.id, 1);
    assert.equal(f.service.evidenceCurrent(f.conversationId, source), false);
    assert.equal(f.service.get(s.bubbles[0].id).versions.length, 1);
    assert.equal(f.service.current(f.conversationId).length, 3);
}
finally {
    f.close();
} });
test('pending and unknown messages cannot become search or memory evidence', () => { const f = fixture(); try {
    const r = f.service.submit(request(f.conversationId));
    assert.equal(f.service.sources(f.conversationId).length, 0);
    f.service.start(r.turnId);
    f.service.recoverInterrupted();
    assert.equal(f.service.sources(f.conversationId).length, 0);
}
finally {
    f.close();
} });
test('single assistant bubble regeneration leaves peer and subsequent turns unchanged', () => { const f = fixture(); try {
    const first = reply(f);
    reply(f);
    const target = f.service.get(first.outputs[0].id), peer = JSON.stringify(f.service.get(first.outputs[1].id)), countBefore = count(f.db, 'chat_bubbles');
    const { jobId } = f.service.prepareRegeneration(randomUUID(), first.receipt.turnId, target.id);
    f.service.start(jobId);
    f.service.complete(jobId, [{ id: target.id, content: 'regenerated' }]);
    assert.equal(f.service.get(target.id).versions.length, 2);
    assert.equal(JSON.stringify(f.service.get(first.outputs[1].id)), peer);
    assert.equal(count(f.db, 'chat_bubbles'), countBefore);
}
finally {
    f.close();
} });
test('whole turn regeneration atomically versions only assistant bubbles', () => { const f = fixture(); try {
    const { receipt, outputs, s } = reply(f);
    const { jobId } = f.service.prepareRegeneration(randomUUID(), receipt.turnId);
    f.service.start(jobId);
    const result = outputs.map(o => ({ ...o, content: 'new ' + o.content }));
    f.service.complete(jobId, result);
    assert.deepEqual(outputs.map(o => f.service.get(o.id).revision), [2, 2]);
    assert.equal(f.service.get(s.bubbles[0].id).revision, 1);
    assert.deepEqual(f.service.complete(jobId, result), { durable: true });
    assert.equal(count(f.db, 'chat_bubble_versions'), 6);
}
finally {
    f.close();
} });
test('partial whole-turn regeneration output is rejected with zero version writes', () => { const f = fixture(); try {
    const { receipt, outputs } = reply(f);
    const { jobId } = f.service.prepareRegeneration(randomUUID(), receipt.turnId);
    f.service.start(jobId);
    assert.throws(() => f.service.complete(jobId, [outputs[0]]), /REGENERATION_TARGET_MISMATCH/);
    assert.equal(count(f.db, 'chat_bubble_versions'), 4);
}
finally {
    f.close();
} });
test('changed input while model is running rejects stale regeneration result', () => { const f = fixture(); try {
    const { receipt, outputs, s } = reply(f);
    const { jobId } = f.service.prepareRegeneration(randomUUID(), receipt.turnId);
    f.service.start(jobId);
    f.service.edit(randomUUID(), s.bubbles[0].id, 1, 'correction');
    assert.throws(() => f.service.complete(jobId, outputs), /SOURCE_CHANGED/);
    assert.equal(f.service.get(outputs[0].id).revision, 1);
    f.service.fail(jobId);
}
finally {
    f.close();
} });
test('changed successful completion conflicts without new output', () => { const f = fixture(); try {
    const { receipt, outputs } = reply(f);
    assert.throws(() => f.service.complete(receipt.turnId, outputs.map(o => ({ ...o, content: 'different' }))), /RESULT_CONFLICT/);
    assert.equal(count(f.db, 'chat_bubbles'), 4);
}
finally {
    f.close();
} });
test('permission revoke blocks reads, edits, pending completion and idempotent replay', () => { const f = fixture(); try {
    const s = request(f.conversationId), r = f.service.submit(s);
    f.service.start(r.turnId);
    f.revoke();
    for (const action of [() => f.service.current(f.conversationId), () => f.service.submit(s), () => f.service.complete(r.turnId, [bubble()]), () => f.service.get(s.bubbles[0].id)])
        assert.throws(action, /CONVERSATION_DENIED/);
    assert.equal(count(f.db, 'chat_bubbles'), 2);
}
finally {
    f.close();
} });
test('audience change invalidates in-flight model output', () => { const f = fixture(); try {
    const r = f.service.submit(request(f.conversationId));
    f.service.start(r.turnId);
    f.audience();
    assert.throws(() => f.service.complete(r.turnId, [bubble()]), /AUDIENCE_CHANGED/);
}
finally {
    f.close();
} });
test('tool operations remain independent durable idempotent events', () => { const f = fixture(); try {
    const { receipt } = reply(f);
    const id = randomUUID();
    f.service.recordTool(id, receipt.turnId, 'synthetic-tool', 'requested', 'no real side effect');
    f.service.recordTool(id, receipt.turnId, 'synthetic-tool', 'requested', 'no real side effect');
    assert.equal(count(f.db, 'chat_tool_events'), 1);
    assert.equal(count(f.db, 'chat_bubbles'), 4);
    assert.throws(() => f.service.recordTool(id, receipt.turnId, 'synthetic-tool', 'succeeded', 'changed'), /REQUEST_ID_CONFLICT/);
}
finally {
    f.close();
} });
test('candidate outbox is durable, hashed, separate from v4 and cannot be marked archived', () => { const f = fixture(); try {
    reply(f);
    assert.equal(count(f.db, 'chat_outbox'), 0);
    assert.equal(f.service.archiveReadiness().canPrune, false);
    assert.ok(f.service.archiveReadiness().pending > 0);
    assert.throws(() => f.db.exec('UPDATE chat_bubble_outbox SET archived=1'));
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}
finally {
    f.close();
} });
test('restart recovers unknown, explicit ACK retries same turn and preserves IDs and ordering', () => {
    assert.ok(root, 'Set TEST_DATA_ROOT to a new isolated root');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'chat-data01-lab-'));
    writeFileSync(join(dir, 'synthetic-marker.txt'), data01Marker, { flag: 'wx' });
    const file = join(dir, 'chat-data01-synthetic.db');
    let db = new DatabaseSync(file), f = fixture(db);
    const s = request(f.conversationId), receipt = f.service.submit(s);
    f.service.start(receipt.turnId);
    f.close();
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON');
    const svc = new BubbleService(db, () => ({ read: true, write: true, audience: 'private:owner' }));
    assert.equal(svc.recoverInterrupted(), 1);
    assert.throws(() => svc.retryUnknown(receipt.turnId, false), /UNKNOWN_ACK_REQUIRED/);
    svc.retryUnknown(receipt.turnId, true);
    svc.start(receipt.turnId);
    const out = [bubble('after restart')];
    svc.complete(receipt.turnId, out);
    assert.deepEqual(svc.submit(s), receipt);
    assert.deepEqual(svc.current(s.conversationId).map(b => b.id), [...s.bubbles.map(b => b.id), out[0].id]);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    db.close();
});
test('unmarked file database rejected before candidate migration', () => { assert.ok(root); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'wrong-')), db = new DatabaseSync(join(dir, 'unmarked.db')); try {
    migrate(db);
    assert.throws(() => migrateSyntheticChatData(db), /SYNTHETIC_DATABASE_REQUIRED/);
    assert.equal(schemaVersion(db), 4);
}
finally {
    db.close();
} });
test('outbox persistence failure rolls back the whole admission and can retry the same IDs', () => { const f = fixture(); try {
    const s = request(f.conversationId);
    f.db.exec("CREATE TRIGGER data01_fault BEFORE INSERT ON chat_bubble_outbox BEGIN SELECT RAISE(ABORT,'synthetic write fault'); END");
    assert.throws(() => f.service.submit(s), /synthetic write fault/);
    for (const table of ['chat_turns', 'chat_bubbles', 'chat_bubble_versions', 'chat_bubble_operations', 'chat_bubble_jobs'])
        assert.equal(count(f.db, table), 0);
    assert.equal(f.db.prepare('SELECT next_turn_seq AS n FROM chat_conversations').get()!.n, 1);
    f.db.exec('DROP TRIGGER data01_fault');
    assert.equal(f.service.submit(s).durable, true);
}
finally {
    f.close();
} });
test('failure halfway through whole turn activation leaves every bubble on original version', () => { const f = fixture(); try {
    const { receipt, outputs } = reply(f), job = f.service.prepareRegeneration(randomUUID(), receipt.turnId).jobId;
    f.service.start(job);
    f.db.exec("CREATE TRIGGER data01_second_fault BEFORE UPDATE ON chat_bubbles WHEN OLD.position=1 AND OLD.role='assistant' BEGIN SELECT RAISE(ABORT,'synthetic second bubble fault'); END");
    assert.throws(() => f.service.complete(job, outputs.map(o => ({ ...o, content: 'updated' }))), /synthetic second bubble fault/);
    assert.deepEqual(outputs.map(o => f.service.get(o.id).revision), [1, 1]);
    assert.equal(count(f.db, 'chat_bubble_versions'), 4);
    assert.equal(f.db.prepare('SELECT status FROM chat_bubble_jobs WHERE id=?').get(job)!.status, 'running');
    f.service.fail(job);
}
finally {
    f.close();
} });
test('model failure retains user bubbles and explicit retry completes the same turn', () => { const f = fixture(); try {
    const s = request(f.conversationId), r = f.service.submit(s);
    f.service.start(r.turnId);
    f.service.fail(r.turnId);
    assert.equal(f.service.legacy.turn(r.turnId).status, 'failed');
    assert.equal(f.service.sources(f.conversationId).length, 0);
    assert.throws(() => f.service.complete(r.turnId, [bubble()]), /JOB_NOT_RUNNING/);
    f.service.retryFailed(r.turnId);
    f.service.start(r.turnId);
    f.service.complete(r.turnId, [bubble('retry success')]);
    assert.equal(count(f.db, 'chat_turns'), 1);
    assert.equal(f.service.current(f.conversationId).length, 3);
    assert.deepEqual(f.service.submit(s), r);
}
finally {
    f.close();
} });
test('outbox event IDs and hashes are immutable under operation retries', () => { const f = fixture(); try {
    const { s } = reply(f), before = f.db.prepare('SELECT * FROM chat_bubble_outbox ORDER BY seq').all();
    f.service.submit(s);
    assert.deepEqual(f.db.prepare('SELECT * FROM chat_bubble_outbox ORDER BY seq').all(), before);
    assert.equal(new Set(before.map(r => r.event_id)).size, before.length);
}
finally {
    f.close();
} });
test('legacy writer cannot create an odd/even sequence gap in an opted-in candidate database', async () => { const f = fixture(); try {
    reply(f);
    const before = f.db.prepare('SELECT next_turn_seq FROM chat_conversations').get()!.next_turn_seq;
    await assert.rejects(f.service.legacy.accept({ conversationId: f.conversationId, clientMessageId: randomUUID(), content: 'legacy mixing prohibited' }), /CANDIDATE_LEGACY_WRITER_BLOCKED/);
    assert.equal(count(f.db, 'chat_turns'), 1);
    assert.equal(f.db.prepare('SELECT next_turn_seq FROM chat_conversations').get()!.next_turn_seq, before);
    assert.equal(count(f.db, 'chat_outbox'), 0);
}
finally {
    f.close();
} });

test('migration refuses unfinished legacy turns rather than orphaning their recovery state',async()=>{const db=new DatabaseSync(':memory:');migrate(db);const old=new ChatStore(db),c=randomUUID();old.createConversation(c,'synthetic pending legacy');await old.accept({conversationId:c,clientMessageId:randomUUID(),content:'unfinished legacy'});const before=JSON.stringify(db.prepare('SELECT * FROM chat_turns').all());assert.throws(()=>migrateSyntheticChatData(db),/LEGACY_UNRESOLVED_TURN/);assert.equal(schemaVersion(db),4);assert.equal(JSON.stringify(db.prepare('SELECT * FROM chat_turns').all()),before);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='chat_bubbles'").get(),undefined);db.close();});
