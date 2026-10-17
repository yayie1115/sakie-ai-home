import { useEffect, useState } from 'react';
import type { ChatConversationPage } from '@sakie/contracts';
import { useApi } from '../../app/api';
import { ChatPanel } from './ChatPage';

/** One existing timeline; creating a conversation remains an explicit user action. */
export function SingleTimelineChat() {
  const api = useApi();
  const [id, setId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<ChatConversationPage>('/api/chat/conversations').then(page => {
      if (active) { setId(page.items[0]?.id ?? null); setLoaded(true); }
    }).catch(() => { if (active) setError('无法读取聊天，请刷新重试。'); });
    return () => { active = false; };
  }, [api]);
  return <section><h2>聊天</h2><p>仅使用近期上下文；长期记忆暂不可用。</p>
    {error && <p role="alert">{error}</p>}
    {id ? <ChatPanel conversationId={id} /> : loaded && <p>尚无对话，请从原聊天页创建。</p>}
  </section>;
}
