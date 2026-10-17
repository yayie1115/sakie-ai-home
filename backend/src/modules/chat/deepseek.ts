import type { ChatConfig } from './config.js';
import { ModelError, type ModelMessage, type ModelProvider, type ModelReply, type ProviderUsage } from './provider.js';
const token = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
/** Native fetch: no SDK retries, redirects, transcript logging, or extra resident service. */
export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  readonly model: string;
  constructor(private settings: ChatConfig, private transport: typeof fetch = fetch) { this.model = settings.model; }
  async complete(messages: readonly ModelMessage[], signal: AbortSignal): Promise<ModelReply> {
    let response: Response;
    try {
      response = await this.transport(this.settings.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: 'Bearer ' + this.settings.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: this.settings.maxOutputTokens, thinking: { type: 'disabled' } }),
      });
    } catch { throw new ModelError(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK_ERROR', 'unknown'); }
    if (!response.ok) {
      await response.body?.cancel();
      const rejected = [400,401,402,403,404,422,429].includes(response.status);
      throw new ModelError('MODEL_HTTP_' + response.status, rejected ? 'failed' : 'unknown');
    }
    let value: any;
    try {
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const {done,value:chunk} = await reader.read(); if(done) break; size += chunk.byteLength;
        if(size > 1024*1024) { await reader.cancel(); throw new Error(); } chunks.push(chunk); } }
      finally { reader.releaseLock(); }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new ModelError(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_INVALID_RESPONSE', 'unknown'); }
    const usage: ProviderUsage = { inputTokens: token(value?.usage?.prompt_tokens), outputTokens: token(value?.usage?.completion_tokens),
      cacheReadTokens: token(value?.usage?.prompt_cache_hit_tokens ?? value?.usage?.prompt_tokens_details?.cached_tokens),
      cacheWriteTokens: null, cacheMissTokens: token(value?.usage?.prompt_cache_miss_tokens) };
    // A truncated/filter/tool response is not a completed text reply.
    if (value?.choices?.[0]?.finish_reason !== 'stop') throw new ModelError('MODEL_INCOMPLETE_REPLY', 'failed', usage);
    const content = value?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 100000) throw new ModelError('MODEL_INVALID_RESPONSE', 'unknown', usage);
    return { content, usage, requestId: typeof value.id === 'string' ? value.id.slice(0,200) : null };
  }
}
