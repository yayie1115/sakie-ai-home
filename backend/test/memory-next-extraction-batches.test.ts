import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryExtractionBatches } from '../src/modules/memory-next/extraction-batches.js';
import type { SourceEvent } from '../src/modules/memory-next/pipeline.js';

function event(id: string, version: string, text: string, overrides: Partial<SourceEvent['source']> = {}): SourceEvent {
  return {
    eventId: `chat:${id}:v${version}`,
    source: {
      id, version, context: 'real', scope: { type: 'private', actors: ['ai'] },
      active: true, deleted: false, occurredAt: '2026-10-18T00:00:00Z', ...overrides,
    },
    text,
  };
}

test('batches current authorized sources, preserving source IDs and versions', () => {
  const result = buildMemoryExtractionBatches([event('b', '3', 'hello'), event('a', '1', 'world')], 'ai');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]!.sourceRefs.map(r => [r.sourceId, r.version]), [['a', '1'], ['b', '3']]);
  assert.match(result[0]!.text, /"sourceVersion":"3"/);
});

test('does not disclose deleted, inactive or unauthorized messages', () => {
  const rows = [
    event('ok', '1', 'allowed'),
    event('deleted', '2', 'SECRET1', { deleted: true, active: false }),
    event('inactive', '1', 'SECRET2', { active: false }),
    event('other', '1', 'SECRET3', { scope: { type: 'private', actors: ['someone-else'] } }),
  ];
  const out = buildMemoryExtractionBatches(rows, 'ai');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.sourceRefs.map(s => s.sourceId), ['ok']);
  assert.doesNotMatch(out[0]!.text, /SECRET/);
});

test('rejects competing versions even if one was inactive', () => {
  assert.throws(() => buildMemoryExtractionBatches([
    event('a', '1', 'old', { active: false }), event('a', '2', 'new'),
  ], 'ai'), /duplicate_source_projection/);
});

test('splits on limits without severing single-source evidence', () => {
  const rows = [event('a', '1', 'x'.repeat(300)), event('b', '1', 'y'.repeat(300))];
  const out = buildMemoryExtractionBatches(rows, 'ai', 256);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.sourceRefs.length, 1);
  assert.equal(out[1]!.sourceRefs.length, 1);
});

test('rejects missing actor and invalid bounds', () => {
  assert.throws(() => buildMemoryExtractionBatches([], ''), /missing_actor/);
  assert.throws(() => buildMemoryExtractionBatches([], 'ai', 10), /invalid_batch_size/);
});
