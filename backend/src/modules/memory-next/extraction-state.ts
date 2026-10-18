/** Durable boundary for the isolated extractor; not a production migration or sync event. */
import type { Candidate } from './pipeline.js';
import type { EvidenceProposal, ExtractionContext } from './extraction-service.js';
export type StoredRecord = { proposal: EvidenceProposal; candidate?: Candidate; decision?: 'approved' | 'rejected' };
export type StoredJob = { fingerprint: string; status: 'running' | 'succeeded' | 'failed' | 'unknown'; proposalIds: string[] };
export type UserCorrection = { requestId: string; actorId: string; targetId: string; replacementId: string; sourceId: string; sourceVersion: string; context: ExtractionContext };
export type ExtractionState = { schema: 1; records: Array<[string,StoredRecord]>; jobs: Array<[string,StoredJob]>; corrections: UserCorrection[] };
export interface ExtractionStateStore {
 read(): { revision: number; state: ExtractionState | null };
 /** Must be synchronous, transactional, compare-and-set, and invoke verify before writing. */
 write(expectedRevision: number, state: ExtractionState, verify: () => void): number;
}
export interface UserCorrectionAuthority {
 /** Trusted owner/author check. Model output and caller-supplied actor IDs are not authority. */
 authorize(correction: Readonly<UserCorrection>): boolean;
}
