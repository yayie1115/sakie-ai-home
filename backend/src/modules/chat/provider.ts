export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ProviderUsage { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cacheMissTokens?: number | null; }
export interface ModelReply { content: string; usage: ProviderUsage; requestId: string | null; }
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(messages: readonly ModelMessage[], signal: AbortSignal, onText?: (content: string) => void): Promise<ModelReply>;
}
/** Unknown means a supplier may have generated/billed a response. Never retry automatically. */
export class ModelError extends Error {
  constructor(readonly code: string, readonly outcome: 'failed' | 'unknown', readonly usage?: ProviderUsage) { super(code); }
}
