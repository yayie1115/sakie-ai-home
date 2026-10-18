/** MEM-04 (isolated): prepare current, authorized chat evidence for a later model extractor.
 * Pure transform only: no model calls, persistence, migrations or private DB reads.
 * Inspired by source-aware conversation batching, implemented independently.
 */
import type { SourceEvent } from './pipeline.js';

export interface ExtractionBatch {
  batchId: string;
  sourceRefs: Array<{ sourceId: string; version: string; eventId: string }>;
  text: string;
  sourceChars: number;
}

/** Input must come from a current-state projection, NOT an append-only raw chat history.
 * Fail closed if multiple revisions of the same source occur in one extraction request.
 */
export function buildMemoryExtractionBatches(
  sources: readonly SourceEvent[],
  actorId: string,
  maxChars = 12_000,
): ExtractionBatch[] {
  if (!actorId?.trim()) throw new Error('missing_actor');
  if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 200_000) throw new Error('invalid_batch_size');
  const seen = new Map<string, string>();
  const eligible: SourceEvent[] = [];
  for (const event of sources) {
    const source = event.source;
    if (!source?.id?.trim() || !source.version?.trim() || !event.eventId?.trim()) throw new Error('invalid_source');
    if (seen.has(source.id)) {
      // Even duplicate projections indicate ambiguous input and must be reconciled upstream.
      throw new Error('duplicate_source_projection');
    }
    seen.set(source.id, source.version);
    if (!source.active || source.deleted || !source.scope?.actors?.includes(actorId)) continue;
    const trimmed = event.text?.trim();
    if (!trimmed) continue;
    if (!Number.isFinite(Date.parse(source.occurredAt))) throw new Error('invalid_source_time');
    eligible.push(event);
  }
  eligible.sort((a, b) => Date.parse(a.source.occurredAt) - Date.parse(b.source.occurredAt)
    || a.source.id.localeCompare(b.source.id));

  const batches: ExtractionBatch[] = [];
  let refs: ExtractionBatch['sourceRefs'] = [];
  let chunks: string[] = [];
  let chars = 0;
  const flush = () => {
    if (!refs.length) return;
    batches.push({ batchId: `memory-extraction:${batches.length + 1}`,
      sourceRefs: refs, sourceChars: chars, text: chunks.join('\n\n') });
    refs = []; chunks = []; chars = 0;
  };
  for (const e of eligible) {
    // Labels are escaped so chat text cannot impersonate another source's metadata.
    // JSON string literal is data; it is not a trusted instruction to the future model.
    const item = JSON.stringify({
      sourceId: e.source.id,
      sourceVersion: e.source.version,
      occurredAt: e.source.occurredAt,
      context: e.source.context,
      content: e.text,
    });
    if (refs.length && chars + item.length + 2 > maxChars) flush();
    // A single oversized source stays whole: evidence offsets must not be lost.
    refs.push({ sourceId: e.source.id, version: e.source.version, eventId: e.eventId });
    chunks.push(item);
    chars += item.length + (chunks.length > 1 ? 2 : 0);
    if (chars >= maxChars) flush();
  }
  flush();
  return batches;
}
