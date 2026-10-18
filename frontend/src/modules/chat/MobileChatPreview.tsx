import { useEffect, useState } from 'react';
import type { ChatConversation, ChatConversationPage, ChatHistoryPage, ChatMessage } from '@sakie/contracts';
import { useApi } from '../../app/api';
import './group-chat-preview.css';

/** M0-2: authenticated, read-only real chat history in the existing v11 visual shell.
 * Sending, editing, creating and model calls remain disabled until their own acceptance steps.
 */
export function MobileChatPreview() {
  const api = useApi();
  const [rooms, setRooms] = useState<ChatConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api<ChatConversationPage>('/api/chat/conversations')
      .then(page => { if (active) setRooms(page.items); })
      .catch(() => { if (active) setError('无法读取会话，请检查测试服务。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    let active = true;
    setError('');
    api<ChatHistoryPage>('/api/chat/conversations/' + encodeURIComponent(selected) + '/messages')
      .then(page => { if (active) setMessages(page.items); })
      .catch(() => { if (active) setError('聊天记录暂时无法加载。'); });
    return () => { active = false; };
  }, [api, selected]);
  const room = rooms.find(r => r.id === selected);
  return <section className={`v11-workspace ${selected ? 'show-chat' : 'show-list'}`} aria-label="小家 Chat 测试版">
    <aside className="v11-sidebar" aria-label="会话列表">
      <header className="v11-side-head"><div><h2>Chat</h2></div>
        <input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={e => setQuery(e.target.value)} />
      </header>
      <div className="v11-room-list">{rooms.filter(r => r.title.toLowerCase().includes(query.toLowerCase())).map(r =>
        <button key={r.id} className={`v11-conversation ${selected === r.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
          <span className="v11-avatar">{r.title.slice(-1)}</span>
          <span className="v11-conversation-copy"><span><strong>{r.title}</strong></span><small>打开已有聊天记录</small></span>
        </button>)}
        {!loading && rooms.length === 0 && <p className="v11-empty">暂无会话；新建会话将在后续步骤接通。</p>}
      </div>
      <footer>小家 M0 测试版 · 暂不支持发送</footer>
    </aside>
    <div className="v11-chat">
      {room ? <>
        <header className="v11-chat-head">
          <button className="v11-back" onClick={() => setSelected(null)} aria-label="返回会话列表">〈 返回</button>
          <div className="v11-chat-title"><strong>{room.title}</strong><small>模型信息尚未接入</small></div>
          <span className="v11-icon" aria-label="聊天详情暂不可用">···</span>
        </header>
        <div className="v11-timeline" aria-label="聊天时间线">
          {messages.map(m => <article key={m.id} className={`v11-message ${m.role === 'user' ? 'mine' : ''}`}>
            <span className="v11-avatar" aria-hidden="true">{m.role === 'user' ? '我' : '言'}</span>
            <div className="v11-message-body"><div className="v11-bubble">{m.content}</div></div>
          </article>)}
          {messages.length === 0 && <p className="v11-empty">暂无可显示的聊天记录</p>}
        </div>
        <div className="v11-composer"><textarea aria-label="聊天输入框（暂未开放）" placeholder="M0-3 接通真实 AI 后开放发送" disabled /><button disabled>发送（未接通）</button></div>
      </> : <div className="v11-empty-state"><p>选择一个会话</p><small>这里展示独立测试库的已有记录，不使用合成演示数据</small></div>}
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
