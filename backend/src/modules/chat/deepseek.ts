import type { ChatConfig } from './config.js';
import { ModelError, type ModelMessage, type ModelProvider, type ModelReply, type ProviderUsage } from './provider.js';
const token = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
/** Native fetch: no SDK retries, redirects, transcript logging, or extra resident service. */
export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  readonly model: string;
  constructor(private settings: ChatConfig, private transport: typeof fetch = fetch) { this.model = settings.model; }
  async complete(messages: readonly ModelMessage[], signal: AbortSignal, onText?: (content: string) => void): Promise<ModelReply> {
    let response: Response;
    try {
      response = await this.transport(this.settings.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: 'Bearer ' + this.settings.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: !!onText, ...(onText ? {stream_options:{include_usage:true}} : {}), max_tokens: this.settings.maxOutputTokens, thinking: { type: 'disabled' } }),
      });
    } catch { throw new ModelError(signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK_ERROR', 'unknown'); }
    if (!response.ok) {
      await response.body?.cancel();
      const rejected = [400,401,402,403,404,422,429].includes(response.status);
      throw new ModelError('MODEL_HTTP_' + response.status, rejected ? 'failed' : 'unknown');
    }
    if (onText && response.headers.get('content-type')?.includes('text/event-stream')) {
      return this.readStream(response, signal, onText);
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
  private async readStream(response: Response, signal: AbortSignal, onText: (content: string) => void): Promise<ModelReply> {
    const reader = response.body?.getReader();
    if (!reader) throw new ModelError('MODEL_INVALID_RESPONSE','unknown');
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let buffer = '', content = '', finish: string | null = null, done = false, requestId: string | null = null, bytes = 0;
    let usage: ProviderUsage = {inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,cacheMissTokens:null};
    const event = (data: string) => {
      if (data === '[DONE]') { done = true; return; }
      const value = JSON.parse(data);
      if (value.error) throw new Error('Provider stream error');
      if (typeof value.id === 'string') requestId = value.id.slice(0,200);
      if (value.usage) usage = {inputTokens:token(value.usage.prompt_tokens),outputTokens:token(value.usage.completion_tokens),
        cacheReadTokens:token(value.usage.prompt_cache_hit_tokens ?? value.usage.prompt_tokens_details?.cached_tokens),cacheWriteTokens:null,cacheMissTokens:token(value.usage.prompt_cache_miss_tokens)};
      const choice = value.choices?.find((c: {index?:number}) => c.index === 0);
      if (choice?.finish_reason != null) finish = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (delta != null && typeof delta !== 'string') throw new Error('Invalid text delta');
      if (delta) {
        content += delta;
        if (content.length > 100000) throw new Error('Reply too large');
        onText(content); // Only answer text; reasoning/tool fragments never enter the preview.
      }
    };
    const consume = (final = false) => {
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0,end); buffer = buffer.slice(end+2);
        const data = block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if (data && !done) event(data);
      }
      if (buffer.length > 1024*1024) throw new Error('Stream event too large');
      if (final && buffer.trim()) throw new Error('Truncated stream event');
    };
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) { buffer += decoder.decode(); consume(true); break; }
        bytes += chunk.value.byteLength;
        if (bytes > 8*1024*1024) throw new Error('Stream too large');
        buffer += decoder.decode(chunk.value,{stream:true});
        buffer = buffer.replace(/\r\n/g,'\n');
        consume();
      }
      if (signal.aborted) throw new Error('Aborted');
      if (!done) throw new Error('Missing stream terminator');
      if (finish !== 'stop') throw new ModelError('MODEL_INCOMPLETE_REPLY','failed',usage);
      if (!content.trim()) throw new Error('Empty reply');
      return {content,usage,requestId};
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError(signal.aborted?'MODEL_TIMEOUT':'MODEL_INVALID_RESPONSE','unknown',usage);
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  }

}
