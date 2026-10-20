export interface ChatConfig {
  apiKey: string; baseUrl: string; model: string; timeoutMs: number; maxOutputTokens: number;
  contextTurns: number; contextChars: number; maxMessageChars: number; maxQueued: number; systemPrompt: string;
}
export function parseChatConfig(env: NodeJS.ProcessEnv): ChatConfig {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid ' + name);
    return n;
  };
  const url = new URL(env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('DEEPSEEK_BASE_URL must be a credential-free HTTPS URL');
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? '';
  const model = env.DEEPSEEK_MODEL?.trim() ?? '';
  if (/[\r\n]/.test(apiKey) || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Invalid DeepSeek configuration');
  const systemPrompt = env.CHAT_SYSTEM_PROMPT ?? '';
  if (systemPrompt.length > 16000) throw new Error('CHAT_SYSTEM_PROMPT is too long');
  const maxMessageChars = number('CHAT_MAX_MESSAGE_CHARS', 12000, 1, 64000);
  const contextChars = number('CHAT_CONTEXT_MAX_CHARS', 48000, 1000, 200000);
  if (contextChars < maxMessageChars) throw new Error('CHAT_CONTEXT_MAX_CHARS must cover CHAT_MAX_MESSAGE_CHARS');
  return { apiKey, model, baseUrl: url.href.replace(/\/$/, ''), systemPrompt,
    timeoutMs: number('MODEL_TIMEOUT_MS', 60000, 100, 300000),
    maxOutputTokens: number('CHAT_MAX_OUTPUT_TOKENS', 1024, 1, 8192),
    contextTurns: number('CHAT_CONTEXT_TURNS', 12, 1, 100), contextChars, maxMessageChars,
    maxQueued: number('CHAT_MAX_QUEUED_TURNS', 16, 1, 100) };
}
