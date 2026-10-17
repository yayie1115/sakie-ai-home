import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatConversation, ChatConversationPage, ChatHistoryPage, ChatMessage, ChatTurn, DurableMessageReceipt } from '@sakie/contracts';
import { ApiError, useApi } from '../../app/api';
const root='/api/chat';
function message(error:unknown){
  if(error instanceof ApiError){const labels:Record<string,string>={MODEL_NOT_CONFIGURED:'后端尚未配置模型。',CHAT_WORKER_UNAVAILABLE:'聊天处理已暂停，请管理员检查存储并重启后端。',TURN_UNRESOLVED:'上一条消息尚未完成，请先查看或重试。',CHAT_QUEUE_FULL:'处理队列已满，请稍后再试。',MESSAGE_ID_CONFLICT:'消息编号冲突，已停止发送。',INVALID_REQUEST:'请求不符合要求。'};return labels[error.code]??('请求失败：'+error.code);}
  return '连接中断，发送结果尚未确认。请保留当前页面并查询或重发同一请求。';
}
const labels:Record<ChatTurn['status'],string>={queued:'已保存，等待处理',running:'已保存，正在回复',succeeded:'回复已保存',failed:'调用失败，用户消息已保存',unknown:'结果未知，用户消息已保存'};
export function ChatPage(){
  const api=useApi();const[conversations,setConversations]=useState<ChatConversation[]>([]);const[selected,setSelected]=useState<ChatConversation|null>(null);
  const[before,setBefore]=useState<number|null>(null);const[error,setError]=useState('');const[busy,setBusy]=useState(false);
  const pendingCreate=useRef<string|null>(null);
  useEffect(()=>{let active=true;api<ChatConversationPage>(root+'/conversations').then(page=>{if(active){setConversations(page.items);setBefore(page.nextBefore);setSelected(page.items[0]??null);}}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[api]);
  async function create(){if(selected&&!window.confirm('新建对话会离开当前页面，未确认入库的草稿会丢失。确定继续？'))return;setBusy(true);setError('');pendingCreate.current??=crypto.randomUUID();try{
    const conversation=await api<ChatConversation>(root+'/conversations',{method:'POST',body:JSON.stringify({id:pendingCreate.current,title:'新对话'})});
    pendingCreate.current=null;setConversations(list=>[conversation,...list.filter(item=>item.id!==conversation.id)]);setSelected(conversation);
  }catch(e){setError(message(e));}finally{setBusy(false);}}
  async function more(){if(!before)return;setBusy(true);try{const page=await api<ChatConversationPage>(root+'/conversations?before='+before);setConversations(list=>[...list,...page.items]);setBefore(page.nextBefore);}catch(e){setError(message(e));}finally{setBusy(false);}}
  return <section><h2>聊天</h2><p>仅使用近期对话；长期记忆暂不可用。发送后，文本会交给后端配置的模型服务处理。</p>
    <button onClick={create} disabled={busy}>新建对话</button>
    <label> 选择对话 <select value={selected?.id??''} onChange={e=>{if(window.confirm('切换对话会丢弃未确认发送的本页草稿。确定继续？'))setSelected(conversations.find(c=>c.id===e.target.value)??null);}}><option value="" disabled>请选择</option>{conversations.map(c=><option key={c.id} value={c.id}>{c.title} · {new Date(c.createdAt).toLocaleString()}</option>)}</select></label>
    {before&&<button onClick={more} disabled={busy}>更多对话</button>}{error&&<p role="alert">{error}</p>}
    {selected?<ChatPanel key={selected.id} conversationId={selected.id}/>:<p>新建一个对话后即可发送消息。</p>}
  </section>;
}
export function ChatPanel({conversationId}:{conversationId:string}){
  const api=useApi();const[messages,setMessages]=useState<ChatMessage[]>([]);const[turn,setTurn]=useState<ChatTurn|null>(null);
  const[before,setBefore]=useState<number|null>(null);const[content,setContent]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
  const[settings,setSettings]=useState<{configured:boolean;maxMessageChars:number}|null>(null);const[loaded,setLoaded]=useState(false);
  const pending=useRef<{clientMessageId:string;content:string}|null>(null);const retry=useRef<string|null>(null);
  const[pendingSend,setPendingSend]=useState(false);
  const base=root+'/conversations/'+conversationId;
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(content||pendingSend){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[content,pendingSend]);
  const merge=useCallback((items:ChatMessage[])=>setMessages(old=>[...new Map([...old,...items].map(m=>[m.id,m])).values()].sort((a,b)=>a.messageSeq-b.messageSeq)),[]);
  useEffect(()=>{let active=true;Promise.all([api<ChatHistoryPage>(base+'/messages'),api<{configured:boolean;maxMessageChars:number}>(root+'/config')]).then(([page,config])=>{if(active){setMessages(page.items);setBefore(page.nextBefore);setTurn(page.unresolvedTurn);setSettings(config);setLoaded(true);}}).catch(e=>{if(active)setError(message(e));});return()=>{active=false;};},[api,base]);
  useEffect(()=>{if(!turn||!['queued','running'].includes(turn.status))return;let active=true;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const result=await api<{turn:ChatTurn;messages:ChatMessage[]}>(root+'/turns/'+turn.id);if(!active)return;merge(result.messages);setTurn(result.turn);setError('');if(['queued','running'].includes(result.turn.status))timer=setTimeout(poll,1200);}catch(e){if(active){setError(message(e));timer=setTimeout(poll,3000);}}};
    timer=setTimeout(poll,500);return()=>{active=false;clearTimeout(timer);};
  },[api,turn?.id,turn?.status,merge]);
  async function refresh(){setBusy(true);try{const page=await api<ChatHistoryPage>(base+'/messages');merge(page.items);setTurn(page.unresolvedTurn);setBefore(page.nextBefore);setError('');setLoaded(true);setSettings(await api(root+'/config'));}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function older(){if(!before)return;setBusy(true);try{const page=await api<ChatHistoryPage>(base+'/messages?before='+before);merge(page.items);setBefore(page.nextBefore);}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function send(event?:FormEvent){event?.preventDefault();if(!pending.current){if(!content.trim())return;pending.current={clientMessageId:crypto.randomUUID(),content};setPendingSend(true);}setBusy(true);setError('');try{
    const result=await api<DurableMessageReceipt&{turn:ChatTurn}>(base+'/messages',{method:'POST',body:JSON.stringify(pending.current)});
    pending.current=null;setPendingSend(false);setContent('');setTurn(result.turn);
    const page=await api<ChatHistoryPage>(base+'/messages');merge(page.items);setBefore(page.nextBefore);setTurn(page.unresolvedTurn??result.turn);
  }catch(e){setError(message(e));}finally{setBusy(false);}}
  async function retryTurn(){if(!turn)return;const ack=turn.status==='unknown';if(ack&&!window.confirm('上一次调用可能已经计费。重新调用可能再次计费，是否继续？'))return;
    retry.current??=crypto.randomUUID();setBusy(true);setError('');try{const result=await api<{turn:ChatTurn}>(root+'/turns/'+turn.id+'/retry',{method:'POST',body:JSON.stringify({retryId:retry.current,acknowledgeUnknown:ack})});retry.current=null;setTurn(result.turn);}catch(e){setError(message(e));}finally{setBusy(false);}}
  const unresolved=turn&&turn.status!=='succeeded';
  return <div>{!settings?.configured&&<p>模型尚未配置，已有聊天仍可读取。</p>}<button onClick={refresh} disabled={busy}>刷新状态</button>{before&&<button onClick={older} disabled={busy}>更早消息</button>}
    <ol aria-label="聊天历史">{messages.map(m=><li key={m.id}><strong>{m.role==='user'?'你':'sakie'}</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{m.content}</p></li>)}</ol>
    {turn&&<p role="status">{labels[turn.status]}{turn.errorCode?'（'+turn.errorCode+'）':''}</p>}
    {turn&&['failed','unknown'].includes(turn.status)&&<button onClick={retryTurn} disabled={busy||!settings?.configured}>重试回复{turn.status==='unknown'?'（可能再次计费）':''}</button>}
    {error&&<p role="alert">{error}</p>}
    <form onSubmit={send}><label htmlFor="chat-message">消息</label><br/><textarea id="chat-message" value={content} onChange={e=>setContent(e.target.value)} maxLength={settings?.maxMessageChars??12000} rows={4} style={{width:'100%',boxSizing:'border-box'}} disabled={busy||pendingSend||!!unresolved}/><br/>
    <button type="submit" disabled={busy||!loaded||!settings?.configured||(!pendingSend&&(!content.trim()||!!unresolved))}>{pendingSend?'确认或重发同一条消息':'发送'}</button></form>
    {pendingSend&&<p>尚未确认入库；重发会复用同一消息编号。刷新或关闭页面会丢弃尚未入库的草稿。</p>}
  </div>;
}
