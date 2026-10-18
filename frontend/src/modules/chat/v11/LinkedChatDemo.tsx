import { useEffect, useMemo, useRef, useState } from 'react';
import type { V11History, V11PendingBubble, V11SubmissionReceipt } from '@sakie/contracts';
import { ApiError, useApi } from '../../../app/api';
import { Timeline } from './Timeline';
import { DefinitiveSubmissionRejection, V11SubmissionClient } from './submission';
import { compose, emptyComposer, stage, type Workspace, type Message } from './state';

/** Reuses the v11 Timeline. This component cannot target an arbitrary server or database. */
export function LinkedChatDemo({data01=false}:{data01?:boolean}){
 const base=data01?'/api/lab/chat-data01':'/api/lab/chat-v11';const storagePrefix=data01?'sakie:data01':'sakie:v11';
 const api=useApi();const [state,setState]=useState<Workspace>();const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [uncertain,setUncertain]=useState(false);const [turn,setTurn]=useState<string>();
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const storage=useMemo(()=>({read(){const raw=sessionStorage.getItem(storagePrefix+':linked-submission');return raw?JSON.parse(raw):null;},write(request:unknown){sessionStorage.setItem(storagePrefix+':linked-submission',JSON.stringify(request));},clear(){sessionStorage.removeItem(storagePrefix+':linked-submission');}}),[storagePrefix]);
  const client=useMemo(()=>new V11SubmissionClient(async request=>{
  try{return await api<V11SubmissionReceipt>(base+'/conversations/'+request.conversationId+'/submit',{method:'POST',body:JSON.stringify(request)});}
  catch(error){const rejected=['INVALID_BATCH','INVALID_BATCH_ID','DUPLICATE_BUBBLE_ID','INVALID_QUOTE','BATCH_TOO_LARGE','QUOTE_SCOPE_DENIED','LAB_CONVERSATION_DENIED','QUOTE_NOT_CURRENT','QUOTE_EVIDENCE_MISMATCH','BUBBLE_ID_CONFLICT','TURN_UNRESOLVED','CHAT_QUEUE_FULL','MODEL_NOT_CONFIGURED','CHAT_WORKER_UNAVAILABLE'];
   if(error instanceof ApiError&&[400,403,409,429,503].includes(error.status)&&rejected.includes(error.code))throw new DefinitiveSubmissionRejection('本次未入库，原气泡保留：'+error.code);
   throw error;
  }
 },storage),[api,storage]);
 function mapHistory(page:V11History):Message[]{return page.bubbles.map(b=>({id:b.id,turnId:b.turnId,author:b.role==='user'?'me':'yan',versions:[b.content],version:0,time:Date.parse(b.createdAt),sourceRef:{messageId:b.sourceMessageId,revision:b.sourceRevision},...(b.quote?{quote:{id:b.quote.bubbleId??b.quote.messageId,author:'引用',text:b.quote.selectedText,source:{conversationId:b.quote.conversationId,messageId:b.quote.messageId,revision:b.quote.revision,bubbleId:b.quote.bubbleId}}}:{})}));}
 async function history(id:string){const page=await api<V11History>(base+'/history');if(page.conversationId!==id)throw Error('会话响应不匹配');return page;}
 useEffect(()=>{let active=true;api<{synthetic:boolean;conversationId:string;capabilities:string[]}>(base+'/capabilities').then(async caps=>{
  if(caps.synthetic!==true||!caps.capabilities.includes(data01?'normalized-bubbles-v1':'text-batch-compat'))throw Error('不是已批准的合成联调服务');
  const page=await history(caps.conversationId);if(!active)return;
  const pending=client.pending();if(pending&&pending.conversationId!==caps.conversationId)throw Error('存在其他实验的待确认提交，已停止，不能混用实验身份');
  let composer=emptyComposer();try{const stored=sessionStorage.getItem(storagePrefix+':linked-composer:'+caps.conversationId);if(stored)composer=JSON.parse(stored);}catch{throw Error('演示草稿无法恢复，请保留浏览器现场');}
  if(pending)composer.pending=pending.bubbles.map(b=>({id:b.id,turnId:b.id,author:'me',versions:[b.content],version:0,time:Date.now(),pending:true,...(b.quote?{quote:{id:b.quote.bubbleId??b.quote.messageId,author:'引用',text:b.quote.selectedText,source:{conversationId:b.quote.conversationId,messageId:b.quote.messageId,revision:b.quote.revision,bubbleId:b.quote.bubbleId}}}:{})}));
  setState({schema:1,rooms:[{id:caps.conversationId,kind:'private',name:'合成 v11 联调',members:['yan'],remarks:{},activity:Date.now(),pinned:false,rules:{mixed:false,mentions:true,limited:true}}],messages:{[caps.conversationId]:mapHistory(page)},composers:{[caps.conversationId]:composer}});setUncertain(!!pending);setTurn(page.unresolvedTurn?.id);
 }).catch(e=>{if(active)setNotice(e.message??'联调服务不可用');});return()=>{active=false;};},[api,client]);
 const room=state?.rooms[0];
 useEffect(()=>{if(state&&room)try{sessionStorage.setItem(storagePrefix+':linked-composer:'+room.id,JSON.stringify(state.composers[room.id]));}catch{setNotice('草稿存储失败，不能保证刷新恢复');}},[state,room]);
 useEffect(()=>{if(!room||!turn)return;let active=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const page=await history(room.id);if(!active)return;setState(s=>s?{...s,messages:{[room.id]:mapHistory(page)}}:s);const unresolved=page.unresolvedTurn;if(!unresolved){setTurn(undefined);setNotice('假模型回复已保存');return;}if(['failed','unknown'].includes(unresolved.status)){setNotice('轮次失败或结果未知；不会自动重复调用模型');setTurn(undefined);return;}timer=setTimeout(poll,300);}catch{if(active){setNotice('历史读取中断，可刷新恢复');timer=setTimeout(poll,1500);}}};timer=setTimeout(poll,100);return()=>{active=false;clearTimeout(timer);};
 },[room?.id,turn]);
 async function finalSubmit(){if(!room||!state||busy)return;const c=state.composers[room.id]??emptyComposer();if(!c.pending.length||c.draft.trim())return;
  const bubbles:V11PendingBubble[]=c.pending.map(m=>({id:m.id,revision:m.version+1,content:m.versions[m.version],...(m.quote?{quote:{conversationId:room.id,messageId:m.quote.source?.messageId??'',revision:m.quote.source?.revision??0,bubbleId:m.quote.source?.bubbleId??m.quote.id,selectedText:m.quote.text}}:{})}));
  setBusy(true);setUncertain(true);try{const receipt=await client.submit(room.id,bubbles);if(!mounted.current)return;
   const confirmed=new Set(receipt.bubbleIds);const savedComposer={...c,pending:c.pending.filter(m=>!confirmed.has(m.id)),draft:'',quote:undefined};sessionStorage.setItem(storagePrefix+':linked-composer:'+room.id,JSON.stringify(savedComposer));client.confirm(receipt);setState(s=>s?compose(s,room.id,{pending:(s.composers[room.id]?.pending??[]).filter(m=>!confirmed.has(m.id)),draft:'',quote:undefined}):s);setUncertain(false);setTurn(receipt.turnId);setNotice('整个提交已持久化，等待假模型回复');
  }catch(e){if(mounted.current){setNotice((e as Error).message||'请求未确认；请重试同一快照');try{setUncertain(!!client.pending());}catch{setUncertain(true);}}}finally{if(mounted.current)setBusy(false);}
 }
 return <section className="v11-workspace show-chat" aria-label="v11 前后端合成联调"><aside className="v11-sidebar"><header className="v11-side-head"><h2>Chat</h2><p className="v11-disclaimer">{data01?'同库规范化气泡 · 合成数据 · 未接正式归档':'新合成 SQLite · 假模型 · 私聊批提交'}</p></header><p className="v11-disclaimer">此入口只验收批提交，不开放群聊、版本或回收站 API。</p></aside><div className="v11-chat">{state&&room?<Timeline key={room.id} room={room} messages={state.messages[room.id].filter(m=>!state.composers[room.id]?.pending.some(p=>p.id===m.id))} composer={state.composers[room.id]??emptyComposer()}
  onCompose={patch=>{if(!busy&&!uncertain)setState(s=>s?compose(s,room.id,patch):s);}} onStage={()=>{if(!busy&&!uncertain)setState(s=>s?stage(s,room.id,crypto.randomUUID(),Date.now()):s);}}
  onSubmit={finalSubmit} onPending={pending=>{if(!busy&&!uncertain)setState(s=>s?compose(s,room.id,{pending}):s);}} onMessages={()=>setNotice('已提交消息的编辑、删除和版本 API 尚未接入')}
  onBack={()=>setNotice('当前实验仅有一个私聊，不能切换到真实会话')} onDetails={()=>setNotice('联调仅支持暂存与最终提交；详情仍在独立合成 UI 验收')}
  notice={setNotice} onJumped={()=>{}} locked={busy||uncertain} linked/>:<p role="status">{notice||'正在验证合成联调服务…'}</p>}
  {(busy||uncertain)&&<div className="v11-link-status" role="status">{busy?'提交确认中，保留原气泡快照':'结果未确认，保留原提交编号'}{!busy&&<button onClick={finalSubmit}>重试同一提交</button>}</div>}
 </div>{notice&&<div className="v11-toast" role="status">{notice}<button onClick={()=>setNotice('')}>×</button></div>}</section>;
}
