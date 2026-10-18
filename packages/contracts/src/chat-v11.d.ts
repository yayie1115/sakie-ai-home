/** Isolated compatibility candidate, not a production API or sync protocol version. */
export interface V11QuoteTarget { conversationId: string; messageId: string; revision: number; bubbleId?: string; selectedText: string; }
export interface V11PendingBubble { id: string; revision: number; content: string; quote?: V11QuoteTarget; }
export interface V11Submission { schemaVersion: 1; submissionId: string; conversationId: string; bubbles: V11PendingBubble[]; }
export interface V11SubmissionReceipt { submissionId: string; conversationId: string; bubbleIds: string[]; messageId: string; turnId: string; turnSeq: number; durable: true; turn: import('./index.js').ChatTurn; }
export interface V11HistoryBubble { id: string; turnId: string; role: 'user' | 'assistant'; content: string; sourceMessageId: string; sourceRevision: number; createdAt: string; position: number; quote?: V11QuoteTarget; }
export interface V11History { conversationId: string; bubbles: V11HistoryBubble[]; unresolvedTurn: import('./index.js').ChatTurn | null; }
