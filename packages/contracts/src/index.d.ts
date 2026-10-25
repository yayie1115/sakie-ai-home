/** Shared contracts; runtime implementations live in backend and local-agent. */
export type RuntimeRole = 'cloud' | 'windows';
export type RecordResource = 'memories' | 'diaries' | 'dreams' | 'activities';
export interface SourceReference { recordId: string; revision: number; contentHash: string; realityScope: 'actual' | 'dream' | 'fiction' | 'unknown'; }
export type MemoryLayer = 'experience' | 'fact-cognition' | 'autobiography' | 'impression';
export type MemoryChannel = 'automatic-facts' | 'primary-model-reflection';
export interface MemoryProvenance { layer: MemoryLayer; channel: MemoryChannel; sources: readonly SourceReference[]; revision: number; verified: boolean; }
export interface LiveChatSegment {id:string;revision:number;content:string;quote?:import('./chat-v11.js').V11QuoteTarget;}
export interface ClientMessage {segments?:LiveChatSegment[]; clientMessageId: string; conversationId: string; content: string; replyToMemberId?: string; }
export interface DurableMessageReceipt { messageId: string; turnId: string; turnSeq: number; durable: true; }
/** accept MUST atomically persist message + task + outbox before resolving. IDs reused with different payloads MUST conflict. */
export interface CloudMessageStore { accept(message: ClientMessage): Promise<DurableMessageReceipt>; }
export interface ArchiveIdentity { archiveId: string; restoreGeneration: string; }
export interface SyncEvent { schemaVersion: 1; eventId: string; producerId: string; producerSeq: number; streamSeq: number; payloadHash: string; kind: string; payload: unknown; }
/** A received frame is not an archival receipt. Never advance over an uncommitted gap. */
export interface ArchivedCursor { streamId: string; contiguousSeq: number; archive: ArchiveIdentity; durability: 'committed'; }
export interface ResumeRequest { archive: ArchiveIdentity; lastArchived: ArchivedCursor | null; }
export type ResumeDecision = { status: 'resume'; afterSeq: number } | { status: 'reconcile-required'; reason: 'restore-generation-changed' | 'cursor-ahead' | 'cursor-behind' | 'stream-changed' | 'proof-mismatch' | 'unknown-archive' };
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

/** Phase 2 text chat wire types. Durable acceptance is not a completed model reply. */
export type ChatTurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
export interface ChatParticipant { id: string; name: string; }
export interface ChatConversationProfile { kind: 'private' | 'group'; members: string[]; }
export interface ChatConversation { pinned?:boolean; id: string; title: string; createdAt: string; profile?: ChatConversationProfile | null; }
export interface ChatTurn { id: string; conversationId: string; clientMessageId: string; turnSeq: number; status: ChatTurnStatus; replyToMemberId?: string | null; errorCode: string | null; createdAt: string; }
export interface ChatMessage {parentMessageId?:string;segmentPosition?:number;quote?:(import('./chat-v11.js').V11QuoteTarget & {unavailable?:boolean}); id: string; turnId: string; messageSeq: number; role: 'user' | 'assistant'; content: string; createdAt: string; revision?: number; speakerId?: string | null; usage?: {cacheRateApplicable?:boolean;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null}; }
export interface ChatHistoryPage { items: ChatMessage[]; nextBefore: number | null; unresolvedTurn: ChatTurn | null; }
export interface ChatConversationPage { items: (ChatConversation & {cursor:number})[]; nextBefore: number | null; }

/** Raw JSON is preserved verbatim so hashes do not depend on object key reserialization. */
export interface WireSyncEvent extends SyncEvent { payloadJson: string; }
export interface SyncProofCursor extends ArchivedCursor { lastEventId: string | null; lastPayloadHash: string | null; }
export interface SyncResumeRequest extends ResumeRequest { lastArchived: SyncProofCursor | null; }
export type SyncResumeResponse = ResumeDecision & { streamId: string; headSeq: number; ackSeq: number; };
export interface SyncBatch { streamId: string; headSeq: number; afterSeq: number; events: WireSyncEvent[]; }
export interface SyncTransport {
 resume(request: SyncResumeRequest): Promise<SyncResumeResponse>;
 pull(afterSeq: number, limit: number): Promise<SyncBatch>;
 acknowledge(cursor: SyncProofCursor): Promise<{ackSeq:number}>;
}
export interface ArchiveRecordPayload {
 resource: RecordResource; id: string; revision: number; record: Record<string,unknown>; deletedAt: string | null;
}
export interface ChatRevisionPayload { id: string; conversationId: string; revision: number; content: string; deletedAt: string | null; }

/** Experimental v11 batch contracts; existing v3/v4 wire types remain unchanged. */
export type { V11QuoteTarget, V11PendingBubble, V11Submission, V11SubmissionReceipt, V11HistoryBubble, V11History } from './chat-v11.js';

export type * from './chat-data01.js';
