/** Phase 1 contracts only. No transport, model invocation, or synchronization runtime. */
export type RuntimeRole = 'cloud' | 'windows';
export type RecordResource = 'memories' | 'diaries' | 'dreams' | 'activities';
export interface SourceReference { recordId: string; revision: number; contentHash: string; realityScope: 'actual' | 'dream' | 'fiction' | 'unknown'; }
export type MemoryLayer = 'experience' | 'fact-cognition' | 'autobiography' | 'impression';
export type MemoryChannel = 'automatic-facts' | 'primary-model-reflection';
export interface MemoryProvenance { layer: MemoryLayer; channel: MemoryChannel; sources: readonly SourceReference[]; revision: number; verified: boolean; }
export interface ClientMessage { clientMessageId: string; conversationId: string; content: string; }
export interface DurableMessageReceipt { messageId: string; turnId: string; turnSeq: number; durable: true; }
/** accept MUST atomically persist message + task + outbox before resolving. IDs reused with different payloads MUST conflict. */
export interface CloudMessageStore { accept(message: ClientMessage): Promise<DurableMessageReceipt>; }
export interface ArchiveIdentity { archiveId: string; restoreGeneration: string; }
export interface SyncEvent { schemaVersion: 1; eventId: string; producerId: string; producerSeq: number; streamSeq: number; payloadHash: string; kind: string; payload: unknown; }
/** A received frame is not an archival receipt. Never advance over an uncommitted gap. */
export interface ArchivedCursor { streamId: string; contiguousSeq: number; archive: ArchiveIdentity; durability: 'committed'; }
export interface ResumeRequest { archive: ArchiveIdentity; lastArchived: ArchivedCursor | null; }
export type ResumeDecision = { status: 'resume'; afterSeq: number } | { status: 'reconcile-required'; reason: 'restore-generation-changed' | 'cursor-ahead' | 'unknown-archive' };
/** Unacknowledged original messages MUST NOT be removed by cache TTL. */
export interface RetentionPolicy { canPrune(event: SyncEvent, receipt: ArchivedCursor | null): Promise<boolean>; }
export interface LocalArchivePort { commitBatch(events: readonly SyncEvent[]): Promise<ArchivedCursor>; inspectIdentity(): Promise<ArchiveIdentity>; }
export interface PairingRequest { pairingId: string; expiresAt: string; }
export interface DevicePrincipal { deviceId: string; scopes: readonly ('archive:write' | 'memory:read')[]; }
/** Separate from owner sessions. Pairing material is single-use; revoked credentials must fail authentication. */
export interface DeviceAuthPort { createPairing(): Promise<PairingRequest>; authenticate(credential: string): Promise<DevicePrincipal | null>; revoke(deviceId: string): Promise<void>; }
export interface MemorySearchPort { search(input: { query: string; minRelevance: number; maxItems: number; maxTokens: number }): Promise<{ status: 'ok' | 'no_match' | 'unavailable' | 'degraded'; items: readonly { content: string; sources: readonly SourceReference[] }[] }>; }
export interface ModelUsage { attemptId: string; purpose: string; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; currency: string; costMicros: number | null; priceVersion: string | null; rawUsage: unknown; }
export interface ModelCallLedger { recordAttempt(usage: ModelUsage): Promise<void>; }
export interface BudgetPort { reserve(input: { taskId: string; maxCostMicros: number; currency: string }): Promise<{ reservationId: string }>; settle(reservationId: string, actualCostMicros: number | null): Promise<void>; }
export interface ContextParts { personaVersion: string; stableInstructions: readonly string[]; dynamicEvidence: readonly { content: string; sources: readonly SourceReference[] }[]; }
export interface ContextAssemblyPort { build(input: { conversationId: string; triggerMessageId: string; tokenBudget: number }): Promise<ContextParts>; }
