import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateSyntheticOps } from '../src/modules/chat/data-next/ops-schema.js';
import { data01Marker } from '../src/modules/chat/data-next/guard.js';
import { ChatOpsService } from '../src/modules/chat/data-next/ops-service.js';
import { FakeGenerationRunner, type SyntheticGenerator } from '../src/modules/chat/data-next/fake-generation.js';
import { operation } from '../src/modules/chat/data-next/ops-codec.js';
function fixture(db = new DatabaseSync(':memory:')) { db.exec('PRAGMA foreign_keys=ON'); migrateSyntheticOps(db); const c = randomUUID(); let read = true, write = true; const service = new ChatOpsService(db, conv => ({ read: read && conv === c, write: write && conv === c, audience: 'owner-private' })); service.legacy.createConversation(c, 'synthetic ops'); return { db, service, c, access(r: boolean, w = r) { read = r; write = w; }, close() { db.close(); } }; }
const b = (content = 'synthetic user') => ({ id: randomUUID(), content });
function ready(f: ReturnType<typeof fixture>) { const input = { requestId: randomUUID(), conversationId: f.c, bubbles: [b()] }, r = f.service.submit(input); f.service.start(r.turnId); const outputs = [b('assistant first'), b('assistant second')]; f.service.complete(r.turnId, outputs); return { r, outputs, input }; }
const count = (f: ReturnType<typeof fixture>, table: string) => Number(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
const op = <K extends 'edit' | 'delete' | 'regenerate' | 'regenerate-turn'>(kind: K, revision = 1) => ({ requestId: randomUUID(), kind, expectedRevision: revision });
test('ops synthetic schema repeats safely and leaves original v4 outbox untouched', () => { const f = fixture(); try {
    migrateSyntheticOps(f.db);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(count(f, 'schema_migrations'), 6);
    assert.equal(count(f, 'chat_outbox'), 0);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}
finally {
    f.close();
} });
test('strict operation codec rejects extra fields, wrong revisions, UUIDs and tool injection', () => { for (const input of [{ ...op('edit'), content: 'ok', tool: 'execute' }, { ...op('edit'), content: 'ok', expectedRevision: 0 }, { ...op('delete'), requestId: 'bad' }, { ...op('delete'), content: 'extra' }, { ...op('edit'), content: ' ' }, { ...op('delete'), kind: 'tool' }])
    assert.throws(() => operation(input, 12000)); });
test('edit and version switch use durable UUID ledger without touching other bubbles', () => { const f = fixture(); try {
    const { outputs } = ready(f), target = f.service.get(outputs[0].id), peer = JSON.stringify(f.service.get(outputs[1].id));
    const edit = { ...op('edit'), content: 'edited' };
    f.service.mutate(target.id, edit);
    f.service.mutate(target.id, edit);
    assert.equal(f.service.get(target.id).revision, 2);
    f.service.mutate(target.id, { requestId: randomUUID(), kind: 'switch', expectedRevision: 2, versionId: target.activeVersionId });
    assert.equal(f.service.get(target.id).content, target.content);
    assert.equal(JSON.stringify(f.service.get(outputs[1].id)), peer);
    assert.equal(count(f, 'chat_outbox'), 0);
}
finally {
    f.close();
} });
test('stale regeneration expected revision is rejected before a job is created', () => { const f = fixture(); try {
    const { outputs } = ready(f);
    f.service.edit(randomUUID(), outputs[0].id, 1, 'new');
    const before = count(f, 'chat_bubble_jobs');
    assert.throws(() => f.service.mutate(outputs[0].id, op('regenerate')), /REVISION_CONFLICT/);
    assert.equal(count(f, 'chat_bubble_jobs'), before);
}
finally {
    f.close();
} });
test('partial fake output followed by failure stays durable but never activates a version', async () => { const f = fixture(); try {
    const { outputs } = ready(f), target = f.service.get(outputs[0].id), job = f.service.mutate(target.id, op('regenerate'));
    assert.ok('jobId' in job);
    const generate: SyntheticGenerator = async function* (_j, targets) { yield { bubbleId: targets[0], text: 'partial evidence' }; throw Error('fake failure'); };
    const runner = new FakeGenerationRunner(f.service, generate);
    await runner.kick(job.jobId);
    assert.equal(f.service.generation(job.jobId).status, 'failed');
    assert.equal(f.service.generation(job.jobId).partials[0].outputs[0].text, 'partial evidence');
    assert.equal(f.service.get(target.id).activeVersionId, target.activeVersionId);
    await runner.close();
}
finally {
    f.close();
} });
test('cancel before start is durable/idempotent and cannot publish a late completion', () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    const requestId = randomUUID();
    f.service.cancel(requestId, job.jobId);
    f.service.cancel(requestId, job.jobId);
    assert.equal(f.service.generation(job.jobId).status, 'cancelled');
    assert.throws(() => f.service.start(job.jobId), /JOB_NOT_QUEUED/);
    assert.throws(() => f.service.complete(job.jobId, [outputs[0]]), /JOB_NOT_RUNNING/);
    assert.equal(f.service.get(outputs[0].id).revision, 1);
}
finally {
    f.close();
} });
test('cancel running retains partial text and preserves all effective versions', () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.service.ensureTargets(job.jobId);
    f.service.start(job.jobId);
    const a = f.service.generation(job.jobId).attempt;
    f.service.appendChunk(job.jobId, a, 1, outputs[0].id, 'cancelled partial');
    f.service.cancel(randomUUID(), job.jobId);
    assert.equal(f.service.generation(job.jobId).partials[0].outputs[0].text, 'cancelled partial');
    assert.throws(() => f.service.appendChunk(job.jobId, a, 2, outputs[0].id, 'late'), /JOB_NOT_RUNNING/);
    assert.equal(f.service.get(outputs[0].id).revision, 1);
}
finally {
    f.close();
} });
test('explicit retry starts a separate attempt and never concatenates earlier failed text', () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.service.ensureTargets(job.jobId);
    f.service.start(job.jobId);
    f.service.appendChunk(job.jobId, 1, 1, outputs[0].id, 'failed prefix');
    f.service.fail(job.jobId);
    const nonce = randomUUID();
    f.service.retry(nonce, job.jobId, false);
    f.service.retry(nonce, job.jobId, false);
    f.service.start(job.jobId);
    f.service.appendChunk(job.jobId, 2, 1, outputs[0].id, 'successful replacement');
    f.service.finishChunks(job.jobId);
    assert.equal(f.service.get(outputs[0].id).content, 'successful replacement');
    assert.equal(count(f, 'chat_generation_chunks'), 2);
    assert.equal(f.service.generation(job.jobId).status, 'succeeded');
}
finally {
    f.close();
} });
test('duplicate chunks are idempotent, conflicts and gaps are rejected', () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.service.ensureTargets(job.jobId);
    f.service.start(job.jobId);
    f.service.appendChunk(job.jobId, 1, 1, outputs[0].id, 'one');
    f.service.appendChunk(job.jobId, 1, 1, outputs[0].id, 'one');
    assert.throws(() => f.service.appendChunk(job.jobId, 1, 1, outputs[0].id, 'different'), /CHUNK_CONFLICT/);
    assert.throws(() => f.service.appendChunk(job.jobId, 1, 3, outputs[0].id, 'gap'), /CHUNK_GAP/);
    assert.equal(count(f, 'chat_generation_chunks'), 1);
}
finally {
    f.close();
} });
test('whole-turn regeneration targets only nondeleted assistant bubbles of selected turn', async () => { const f = fixture(); try {
    const first = ready(f), second = ready(f);
    const job = f.service.mutate(first.outputs[0].id, op('regenerate-turn'));
    assert.ok('jobId' in job);
    const prior = JSON.stringify(f.service.get(second.outputs[0].id));
    const runner = new FakeGenerationRunner(f.service, async function* (_job, targets) { for (const id of targets)
        yield { bubbleId: id, text: 'new ' + id }; });
    await runner.kick(job.jobId);
    assert.deepEqual(first.outputs.map(o => f.service.get(o.id).revision), [2, 2]);
    assert.equal(f.service.get(first.input.bubbles[0].id).revision, 1);
    assert.equal(JSON.stringify(f.service.get(second.outputs[0].id)), prior);
    await runner.close();
}
finally {
    f.close();
} });
test('whole turn missing output fails without partially activating any bubble', async () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate-turn'));
    assert.ok('jobId' in job);
    const runner = new FakeGenerationRunner(f.service, async function* (_j, targets) { yield { bubbleId: targets[0], text: 'one only' }; });
    await runner.kick(job.jobId);
    assert.equal(f.service.generation(job.jobId).status, 'failed');
    assert.deepEqual(outputs.map(o => f.service.get(o.id).revision), [1, 1]);
    await runner.close();
}
finally {
    f.close();
} });
test('source switch, delete and revoke redact quote, search, evidence and draft generation output', () => { const f = fixture(); try {
    const first = ready(f), source = f.service.get(first.input.bubbles[0].id);
    const q = { conversationId: f.c, bubbleId: source.id, versionId: source.activeVersionId, revision: 1, selectedText: 'synthetic' };
    const req = { requestId: randomUUID(), conversationId: f.c, bubbles: [{ ...b('quoted user'), quote: q }] }, r = f.service.submit(req);
    f.service.start(r.turnId);
    f.service.complete(r.turnId, [b('reply')]);
    const job = f.service.mutate(first.outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.service.ensureTargets(job.jobId);
    f.service.start(job.jobId);
    f.service.appendChunk(job.jobId, 1, 1, first.outputs[0].id, 'private derived partial');
    f.service.edit(randomUUID(), source.id, 1, 'corrected text');
    const history = f.service.history(f.c), quoted = history.items.find(x => x.id === req.bubbles[0].id)!;
    assert.deepEqual(quoted.quote, { bubbleId: source.id, available: false });
    assert.equal(f.service.search(f.c, 'synthetic user').length, 0);
    assert.equal(f.service.evidenceCurrent(f.c, { id: source.id, version: '1:' + source.activeVersionId }), false);
    assert.deepEqual(f.service.generation(job.jobId).partials, []);
    f.service.softDelete(randomUUID(), source.id, 2);
    assert.equal(f.service.history(f.c).items.some(x => x.id === source.id), false);
    f.access(false);
    assert.equal(f.service.quoteView(q).available, false);
    assert.throws(() => f.service.history(f.c), /CONVERSATION_DENIED/);
    f.access(true);
    f.service.fail(job.jobId);
}
finally {
    f.close();
} });
test('read-only audience cannot mutate, cancel or retry even with a known job UUID', () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.access(true, false);
    assert.ok(f.service.history(f.c));
    assert.throws(() => f.service.mutate(outputs[0].id, { ...op('edit'), content: 'unauthorized' }), /CONVERSATION_DENIED/);
    assert.throws(() => f.service.cancel(randomUUID(), job.jobId), /CONVERSATION_DENIED/);
    assert.throws(() => f.service.retry(randomUUID(), job.jobId, false), /CONVERSATION_DENIED/);
}
finally {
    f.close();
} });
test('restart recovers unknown and retains chunks, effective versions and explicit retry requirement', () => { const root = process.env.TEST_DATA_ROOT; assert.ok(root); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'chat-data01-lab-')); writeFileSync(join(dir, 'synthetic-marker.txt'), data01Marker, { flag: 'wx' }); const file = join(dir, 'chat-data01-synthetic.db'); const f = fixture(new DatabaseSync(file)); const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate')); assert.ok('jobId' in job); f.service.ensureTargets(job.jobId); f.service.start(job.jobId); f.service.appendChunk(job.jobId, 1, 1, outputs[0].id, 'persisted prefix'); const c = f.c; f.close(); const db = new DatabaseSync(file); db.exec('PRAGMA foreign_keys=ON'); migrateSyntheticOps(db); const service = new ChatOpsService(db, x => ({ read: x === c, write: x === c, audience: 'owner-private' })); assert.equal(service.recoverInterrupted(), 1); assert.equal(service.generation(job.jobId).status, 'unknown'); assert.equal(service.generation(job.jobId).partials[0].outputs[0].text, 'persisted prefix'); assert.throws(() => service.retry(randomUUID(), job.jobId, false), /UNKNOWN_ACK_REQUIRED/); service.retry(randomUUID(), job.jobId, true); assert.equal(service.generation(job.jobId).status, 'queued'); assert.equal(service.get(outputs[0].id).revision, 1); db.close(); });
test('concurrent generation and retry conflicts return explicit busy without overwriting jobs', () => { const f = fixture(); try {
    const { outputs } = ready(f), first = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in first);
    assert.throws(() => f.service.mutate(outputs[1].id, op('regenerate')), /GENERATION_BUSY/);
    f.service.cancel(randomUUID(), first.jobId);
    const second = f.service.mutate(outputs[1].id, op('regenerate'));
    assert.ok('jobId' in second);
    assert.throws(() => f.service.retry(randomUUID(), first.jobId, false), /GENERATION_BUSY/);
    assert.equal(f.service.generation(first.jobId).status, 'cancelled');
    assert.equal(f.service.generation(second.jobId).status, 'queued');
}
finally {
    f.close();
} });
test('generation preparation write failure stops instead of retrying in a busy loop', async () => { const f = fixture(); try {
    const { outputs } = ready(f), job = f.service.mutate(outputs[0].id, op('regenerate'));
    assert.ok('jobId' in job);
    f.db.exec("CREATE TRIGGER ops_target_fault BEFORE INSERT ON chat_generation_targets BEGIN SELECT RAISE(ABORT,'synthetic target fault'); END");
    let calls = 0;
    const runner = new FakeGenerationRunner(f.service, async function* () { calls++; throw Error('must not run'); });
    await runner.kick(job.jobId);
    assert.equal(calls, 0);
    assert.equal(f.service.generation(job.jobId).status, 'failed');
    assert.equal(f.service.get(outputs[0].id).revision, 1);
    await runner.close();
}
finally {
    f.close();
} });

test('failed state cannot be relabelled cancelled and stale-source retry cannot start a model',()=>{const f=fixture();try{const {outputs,input}=ready(f),job=f.service.mutate(outputs[0].id,op('regenerate'));assert.ok('jobId'in job);f.service.ensureTargets(job.jobId);f.service.start(job.jobId);f.service.fail(job.jobId);assert.throws(()=>f.service.cancel(randomUUID(),job.jobId),/JOB_NOT_CANCELLABLE/);f.service.edit(randomUUID(),input.bubbles[0].id,1,'source correction');assert.throws(()=>f.service.retry(randomUUID(),job.jobId,false),/SOURCE_CHANGED/);assert.equal(f.service.generation(job.jobId).status,'failed');assert.equal(f.service.generation(job.jobId).errorCode,'MODEL_FAILED');}finally{f.close();}});
