/** CHAT-DATA-01 isolated candidate; not a v4 wire protocol extension. */
export interface BubbleQuote {
    conversationId: string;
    bubbleId: string;
    versionId: string;
    revision: number;
    selectedText: string;
}
export interface BubbleInput {
    id: string;
    content: string;
    quote?: BubbleQuote;
}
export interface BubbleSubmission {
    requestId: string;
    conversationId: string;
    bubbles: BubbleInput[];
}
export interface BubbleVersion {
    id: string;
    ordinal: number;
    content: string;
    origin: 'original' | 'edit' | 'regeneration' | 'legacy';
}
export interface CurrentBubble {
    id: string;
    conversationId: string;
    turnId: string;
    role: 'user' | 'assistant';
    position: number;
    revision: number;
    activeVersionId: string;
    content: string;
    createdAt: string;
    deleted: boolean;
    versions: BubbleVersion[];
    quote?: BubbleQuote;
}
export interface BubbleReceipt {
    requestId: string;
    conversationId: string;
    turnId: string;
    turnSeq: number;
    bubbleIds: string[];
    durable: true;
}
export interface BubbleAccess {
    read: boolean;
    write: boolean;
    audience: string;
}
