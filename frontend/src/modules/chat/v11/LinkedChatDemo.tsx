import {useNotice} from '../../../app/useNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { V11History, V11PendingBubble, V11SubmissionReceipt, OpsHistory, GenerationView, BubbleOperation } from '@sakie/contracts';
import { ApiError, useApi } from '../../../app/api';
import { Timeline } from './Timeline';
import { OperationClient, type OperationAck } from './operations';
type HistoryPage=V11History & {ops?:OpsHistory};
import { DefinitiveSubmissionRejection, V11SubmissionClient } from './submission';
import { compose, emptyComposer, stage, type Workspace, type Message } from './state';

/** Reuses the v11 Timeline. This component cannot target an arbitrary server or database. */
export function LinkedChatDemo({data01=false}:{data01?:boolean}){
 const base=data01?'/api/lab/chat-data01':'/api/lab/chat-v11';const storagePrefix=data01?'sakie:data01':'sakie:v11';
 const api=useApi();const [state,setState]=useState<Workspace>();const [notice,setNotice]=useNotice();const [busy,setBusy]=useState(false);const [uncertain,setUncertain]=useState(false);const [turn,setTurn]=useState<string>();
 const [jobs,setJobs]=useState<GenerationView[]>([]);const [opBusy,setOpBusy]=useState(false);const [opUncertain,setOpUncertain]=useState(false);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const storage=useMemo(()=>({read(){const raw=sessionStorage.getItem(storagePrefix+':linked-submission');return raw?JSON.parse(raw):null;},write(request:unknown){sessionStorage.setItem(storagePrefix+':linked-submission',JSON.stringify(request));},clear(){sessionStorage.removeItem(storagePrefix+':linked-submission');}}),[storagePrefix]);
  const client=useMemo(()=>new V11SubmissionClient(async request=>{
  try{return await api<V11SubmissionReceipt>(base+'/conversations/'+request.conversationId+'/submit',{method:'POST',body:JSON.stringify(request)});}
  catch(error){const rejected=['INVALID_BATCH','INVALID_BATCH_ID','DUPLICATE_BUBBLE_ID','INVALID_QUOTE','BATCH_TOO_LARGE','QUOTE_SCOPE_DENIED','LAB_CONVERSATION_DENIED','QUOTE_NOT_CURRENT','QUOTE_EVIDENCE_MISMATCH','BUBBLE_ID_CONFLICT','TURN_UNRESOLVED','CHAT_QUEUE_FULL','MODEL_NOT_CONFIGURED','CHAT_WORKER_UNAVAILABLE'];
   if(error instanceof ApiError&&[400,403,409,429,503].includes(error.status)&&rejected.includes(error.code))throw new DefinitiveSubmissionRejection('本次未入库，原气泡保留：'+error.code);
   throw error;
  }
 },storage),[api,storage]);
 const operations=useMemo(()=>new OperationClient(p=>api<OperationAck>(base+p.path,{method:'POST',body:JSON.stringify(p.body)}),{
  read(){const v=sessionStorage.getItem(storagePrefix+':operation');return v?JSON.parse(v):null;},write(p){sessionStorage.setItem(storagePrefix+':operation',JSON.stringify(p));},clear(){sessionStorage.removeItem(storagePrefix+':operation');}
 }),[api,base,storagePrefix]);
 function mapHistory(page:HistoryPage):Message[]{
  if(data01&&page.ops)return page.ops.items.map(b=>({id:b.id,turnId:b.turnId,author:b.role==='user'?'me':'yan',versions:b.versions.map(v=>v.content),version:b.versions.findIndex(v=>v.id===b.activeVersionId),versionIds:b.versions.map(v=>v.id),time:Date.parse(b.createdAt),sourceRef:{messageId:b.id,revision:b.revision},...(b.quote?{quote:b.quote.available?{id:b.quote.bubbleId,author:'引用',text:b.quote.selectedText,source:{conversationId:b.quote.conversationId,messageId:b.quote.bubbleId,bubbleId:b.quote.bubbleId,revision:b.quote.revision}}:{id:b.quote.bubbleId,author:'引用',text:'引用来源已失效',unavailable:true}}:{})}));
  return page.bubbles.map(b=>({id:b.id,turnId:b.turnId,author:b.role==='user'?'me':'yan',versions:[b.content],version:0,time:Date.parse(b.createdAt),sourceRef:{messageId:b.sourceMessageId,revision:b.sourceRevision},...(b.quote?{quote:{id:b.quote.bubbleId??b.quote.messageId,author:'引用',text:b.quote.selectedText,source:{conversationId:b.quote.conversationId,messageId:b.quote.messageId,revision:b.quote.revision,bubbleId:b.quote.bubbleId}}}:{})}));
 }
 async function history(id:string){try{const page=await api<HistoryPage>(base+'/history');if(page.conversationId!==id||data01&&!page.ops)throw Error('会话响应不匹配');return page;}catch(error){if(data01&&error instanceof ApiError&&[401,403].includes(error.status)){setState(undefined);setJobs([]);setTurn(undefined);setNotice('访问权限已失效，已隐藏聊天内容');}throw error;}}
 function apply(page:HistoryPage){setState(s=>s?{...s,messages:{[page.conversationId]:mapHistory(page)}}:s);setJobs(page.ops?.jobs??[]);setTurn(page.unresolvedTurn?.id);}
 async function refresh(id:string){const page=await history(id);apply(page);return page;}
 async function perform(path:string,body:Record<string,unknown>&{requestId:string}){
  if(!room||!data01)throw Error('不是隔离操作入口');setOpBusy(true);setOpUncertain(true);
  try{const ack=await operations.send(path,body);await refresh(room.id);operations.confirm(ack);setOpUncertain(false);setNotice('操作已持久化');}
  catch(error){const known=error instanceof ApiError&&[400,409].includes(error.status)&&['INVALID_OPERATION','INVALID_TEXT','INVALID_VERSION','INVALID_REVISION','REVISION_CONFLICT','VERSION_SCOPE_DENIED','TURN_NOT_COMPLETE','REGENERATION_TARGET_DENIED','JOB_ALREADY_SUCCEEDED','JOB_NOT_RETRYABLE','UNKNOWN_ACK_REQUIRED','GENERATION_BUSY','SOURCE_CHANGED','JOB_NOT_CANCELLABLE'].includes(error.code);
   if(known){try{await refresh(room.id);operations.reject();setOpUncertain(false);}catch{/* Keep original operation until history can be verified. */}}
   setNotice((error as Error).message);throw error;
  }finally{setOpBusy(false);}
 }
 async function operate(m:Message,action:string,value?:string){
  if(!m.sourceRef)throw Error('缺少服务端版本');let op:BubbleOperation;
  const common={requestId:crypto.randomUUID(),expectedRevision:m.sourceRef.revision};
  if(action==='edit')op={...common,kind:'edit',content:value??''};
  else if(action==='delete')op={...common,kind:'delete'};
  else if(action==='prev'||action==='next'){const index=m.version+(action==='prev'?-1:1),versionId=m.versionIds?.[index];if(!versionId)throw Error('没有该版本');op={...common,kind:'switch',versionId};}
  else if(action==='regenerate'||action==='regenerateTurn')op={...common,kind:action==='regenerate'?'regenerate':'regenerate-turn'};
  else throw Error('操作未接入');
  await perform('/bubbles/'+m.id+'/operations',op);
 }
 async function readCurrent(m:Message){try{const row=await api<{content:string}>(base+'/bubbles/'+m.id+'/current?revision='+m.sourceRef?.revision);return row.content;}catch(e){if(room)await refresh(room.id);throw e;}}
 useEffect(()=>{let active=true;api<{synthetic:boolean;conversationId:string;capabilities:string[]}>(base+'/capabilities').then(async caps=>{
  if(caps.synthetic!==true||!caps.capabilities.includes(data01?'normalized-bubbles-v1':'text-batch-compat'))throw Error('不是已批准的合成联调服务');
  const page=await history(caps.conversationId);if(!active)return;
  const pending=client.pending();if(pending&&pending.conversationId!==caps.conversationId)throw Error('存在其他实验的待确认提交，已停止，不能混用实验身份');
  let composer=emptyComposer();try{const stored=sessionStorage.getItem(storagePrefix+':linked-composer:'+caps.conversationId);if(stored)composer=JSON.parse(stored);}catch{throw Error('演示草稿无法恢复，请保留浏览器现场');}
  if(pending)composer.pending=pending.bubbles.map(b=>({id:b.id,turnId:b.id,author:'me',versions:[b.content],version:0,time:Date.now(),pending:true,...(b.quote?{quote:{id:b.quote.bubbleId??b.quote.messageId,author:'引用',text:b.quote.selectedText,source:{conversationId:b.quote.conversationId,messageId:b.quote.messageId,revision:b.quote.revision,bubbleId:b.quote.bubbleId}}}:{})}));
  setState({schema:1,rooms:[{id:caps.conversationId,kind:'private',name:'合成 v11 联调',members:['yan'],remarks:{},activity:Date.now(),pinned:false,rules:{mixed:false,mentions:true,limited:true}}],messages:{[caps.conversationId]:mapHistory(page)},composers:{[caps.conversationId]:composer}});setUncertain(!!pending);setTurn(page.unresolvedTurn?.id);setJobs(page.ops?.jobs??[]);if(data01)setOpUncertain(!!operations.pending());
 }).catch(e=>{if(active)setNotice(e.message??'联调服务不可用');});return()=>{active=false;};},[api,client]);
 const room=state?.rooms[0];
 const safeComposer=state&&room?(()=>{const c=state.composers[room.id]??emptyComposer();if(!data01)return c;
  const safe=(q:typeof c.quote)=>{if(!q)return q;const source=state.messages[room.id].find(m=>m.id===q.id);return source&&source.sourceRef?.revision===q.source?.revision&&source.versions[source.version].includes(q.text)?q:{...q,text:'引用来源已失效',unavailable:true};};
  return {...c,quote:safe(c.quote),pending:c.pending.map(m=>({...m,quote:safe(m.quote)}))};})():emptyComposer();
 const jobKey=jobs.filter(j=>['queued','running'].includes(j.status)).map(j=>j.id+':'+j.status+':'+j.attempt).join('|');
 useEffect(()=>{if(state&&room)try{sessionStorage.setItem(storagePrefix+':linked-composer:'+room.id,JSON.stringify(state.composers[room.id]));}catch{setNotice('草稿存储失败，不能保证刷新恢复');}},[state,room]);
 useEffect(()=>{if(!room||!turn&&!jobKey)return;let active=true;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const page=await history(room.id);if(!active)return;apply(page);const unresolved=page.unresolvedTurn;const activeJob=page.ops?.jobs.some(j=>['queued','running'].includes(j.status));if(!unresolved&&!activeJob){setTurn(undefined);setNotice(data01?'任务已完成或停止，请查看服务端状态':'假模型回复已保存');return;}if(unresolved&&['failed','unknown'].includes(unresolved.status)&&!activeJob){setNotice('轮次失败或结果未知；不会自动重复调用模型');setTurn(undefined);return;}timer=setTimeout(poll,300);}catch{if(active){setNotice('历史读取中断，可刷新恢复');timer=setTimeout(poll,1500);}}};timer=setTimeout(poll,100);return()=>{active=false;clearTimeout(timer);};
 },[room?.id,turn,jobKey]);
 async function finalSubmit(){if(!room||!state||busy)return;const c=state.composers[room.id]??emptyComposer();if(!c.pending.length||c.draft.trim())return;
  if(data01&&!client.pending()&&safeComposer.pending.some(m=>m.quote?.unavailable)){setNotice('引用来源已失效，请移除该引用后重新暂存');return;}
  const bubbles:V11PendingBubble[]=c.pending.map(m=>({id:m.id,revision:m.version+1,content:m.versions[m.version],...(m.quote?{quote:{conversationId:room.id,messageId:m.quote.source?.messageId??'',revision:m.quote.source?.revision??0,bubbleId:m.quote.source?.bubbleId??m.quote.id,selectedText:m.quote.text}}:{})}));
  setBusy(true);setUncertain(true);try{const receipt=await client.submit(room.id,bubbles);if(!mounted.current)return;
   const confirmed=new Set(receipt.bubbleIds);const savedComposer={...c,pending:c.pending.filter(m=>!confirmed.has(m.id)),draft:'',quote:undefined};sessionStorage.setItem(storagePrefix+':linked-composer:'+room.id,JSON.stringify(savedComposer));client.confirm(receipt);setState(s=>s?compose(s,room.id,{pending:(s.composers[room.id]?.pending??[]).filter(m=>!confirmed.has(m.id)),draft:'',quote:undefined}):s);setUncertain(false);setTurn(receipt.turnId);setNotice('整个提交已持久化，等待假模型回复');
  }catch(e){if(mounted.current){setNotice((e as Error).message||'请求未确认；请重试同一快照');try{setUncertain(!!client.pending());}catch{setUncertain(true);}}}finally{if(mounted.current)setBusy(false);}
 }
 return <section className="v11-workspace show-chat" aria-label="v11 前后端合成联调"><aside className="v11-sidebar"><header className="v11-side-head"><h2>Chat</h2><p className="v11-disclaimer">{data01?'同库规范化气泡 · 合成数据 · 未接正式归档':'新合成 SQLite · 假模型 · 私聊批提交'}</p></header><p className="v11-disclaimer">{data01?'隔离持久操作：编辑、版本、软删除及假模型重生成；未接群聊或正式归档。':'此入口只验收批提交，不开放群聊、版本或回收站 API。'}</p></aside><div className="v11-chat">{state&&room?<Timeline key={room.id} room={room} messages={state.messages[room.id].filter(m=>!state.composers[room.id]?.pending.some(p=>p.id===m.id))} composer={safeComposer}
  onCompose={patch=>{if(!busy&&!uncertain)setState(s=>s?compose(s,room.id,patch):s);}} onStage={()=>{if(!busy&&!uncertain)setState(s=>s?stage(s,room.id,crypto.randomUUID(),Date.now()):s);}}
  onSubmit={finalSubmit} onPending={pending=>{if(!busy&&!uncertain)setState(s=>s?compose(s,room.id,{pending}):s);}} onOperate={data01?operate:undefined} onRead={data01?readCurrent:undefined} onMessages={()=>setNotice('已提交消息的编辑、删除和版本 API 尚未接入')}
  onBack={()=>setNotice('当前实验仅有一个私聊，不能切换到真实会话')} onDetails={()=>setNotice(data01?'整回合重生成只更新所选回合内未删除的助手气泡，不改变用户消息或后续回合。':'联调仅支持暂存与最终提交；详情仍在独立合成 UI 验收')}
  notice={setNotice} onJumped={()=>{}} locked={busy||uncertain||opBusy||opUncertain} linked/>:<p role="status">{notice||'正在验证合成联调服务…'}</p>}
  {(busy||uncertain)&&<div className="v11-link-status" role="status">{busy?'提交确认中，保留原气泡快照':'结果未确认，保留原提交编号'}{!busy&&<button onClick={finalSubmit}>重试同一提交</button>}</div>}
  {data01&&opUncertain&&<div role="status" className="v11-link-status">{opBusy?'操作确认中':'操作结果未确认'}{!opBusy&&<button onClick={()=>{const p=operations.pending();if(p)void perform(p.path,p.body).catch(()=>{});}}>重试原操作</button>}</div>}
  {data01&&<div className="v11-job-list">{jobs.filter(j=>j.status!=='succeeded').map(j=><section className="v11-job-panel" key={j.id} aria-label="生成任务" data-job-id={j.id}><p>假模型任务 · {j.status}{!j.evidenceAvailable?' · 来源失效，部分文本已隐藏':''}</p>
   {j.partials.map(p=><div key={p.attempt}><small>尝试 {p.attempt} · 未作为有效版本发布</small>{p.outputs.map(o=><pre key={o.bubbleId}>{o.text}</pre>)}</div>)}
   {['queued','running','unknown'].includes(j.status)&&<button disabled={opBusy||opUncertain} onClick={()=>void perform('/jobs/'+j.id+'/cancel',{requestId:crypto.randomUUID()}).catch(()=>{})}>取消生成</button>}
   {['failed','unknown','cancelled'].includes(j.status)&&<button disabled={opBusy||opUncertain||!j.evidenceAvailable} onClick={()=>void perform('/jobs/'+j.id+'/retry',{requestId:crypto.randomUUID(),acknowledgeUnknown:j.status==='unknown'}).catch(()=>{})}>{!j.evidenceAvailable?'来源变更，请重新发起':j.status==='unknown'?'确认未知结果并重试':'重试生成'}</button>}
  </section>)}</div>}
 </div>{notice&&<div className="v11-toast" role="status">{notice}</div>}</section>;
}
