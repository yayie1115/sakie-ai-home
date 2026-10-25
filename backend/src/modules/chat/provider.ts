export interface ModelToolCall {id:string;type:'function';function:{name:string;arguments:string};}
export interface ModelTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>};}
export interface ModelOptions {tools?:readonly ModelTool[];maxOutputTokens?:number;outputFormat?:'json';}
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?:string;tool_calls?:ModelToolCall[]; }
export interface ProviderUsage { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; cacheMissTokens?: number | null; }
export interface ModelReply { content: string; usage: ProviderUsage; requestId: string | null; toolCalls?:ModelToolCall[]; }
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsTools?:boolean;
  complete(messages: readonly ModelMessage[], signal: AbortSignal, onText?: (content: string) => void, options?:ModelOptions): Promise<ModelReply>;
}
/** Unknown means a supplier may have generated/billed a response. Never retry automatically. */
export class ModelError extends Error {
  constructor(readonly code: string, readonly outcome: 'failed' | 'unknown', readonly usage?: ProviderUsage) { super(code); }
}
