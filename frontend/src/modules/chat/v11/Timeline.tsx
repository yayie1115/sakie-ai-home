import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { emptyComposer, textOf, titleOf, type Room, type Message, type Composer } from './state';
import { useLongPress } from './useLongPress';

type Props={room:Room;messages:Message[];composer:Composer;onCompose:(patch:Partial<Composer>)=>void;
 onStage:()=>void;onSubmit:()=>void;onMessages:(messages:Message[])=>void;onPending:(messages:Message[])=>void;
 onBack:()=>void;onDetails:()=>void;notice:(message:string)=>void;jumpId?:string;onJumped:()=>void;locked?:boolean;linked?:boolean;onOperate?:(m:Message,action:string,value?:string)=>Promise<void>;onRead?:(m:Message)=>Promise<string>;live?:{disabled:boolean;maxLength:number;status:string;replyPicker?:React.ReactNode};m0?:{modelLabel:string;onNavigation:()=>void;initialLatest:boolean;hasEarlier:boolean;loadEarlier:()=>Promise<void>;loadingEarlier:boolean}};
function Bubble({m,room,selected,onOpen,onQuoteJump,children}:{m:Message;room:Room;selected:boolean;onOpen:()=>void;onQuoteJump:(id:string)=>void;children:React.ReactNode}){
 const press=useLongPress(onOpen);
 return <article className={`v11-message ${m.author==='me'?'mine':''} ${selected?'chosen':''}`} data-message-id={m.id}>
   <span className="v11-avatar" aria-hidden="true">{m.author==='unattributed'?'AI':titleOf(room,m.author).slice(-1)}</span>
   <div className="v11-message-body">{room.kind==='group'&&m.author!=='me'&&<span className="v11-speaker">{titleOf(room,m.author)}</span>}
     {m.quote&&<button className="v11-quoted" disabled={m.quote.unavailable} onClick={()=>onQuoteJump(m.quote!.id)}>{m.quote.author}：{m.quote.text}</button>}
     <div className={`v11-bubble ${m.pending||m.delivery?'pending':''}`} {...press} tabIndex={0} onKeyDown={e=>{if(e.key==='F10'&&e.shiftKey){e.preventDefault();onOpen();}}}>{textOf(m)}</div>
     {children}
   </div>
 </article>;
}
export function Timeline(props:Props){
 const {room,messages,composer,onCompose}=props;const readOnly=!!props.m0&&!props.live;const pinned=useRef(props.m0?.initialLatest??false);const input=useRef<HTMLTextAreaElement>(null);const earlierAnchor=useRef<{id:string;offset:number}|null>(null);
 const scrollSave=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),composeRef=useRef(onCompose);composeRef.current=onCompose;
 useEffect(()=>()=>{if(scrollSave.current)clearTimeout(scrollSave.current);},[]);
 const scroll=useRef<HTMLDivElement>(null); const oldScroll=useRef<number|null>(null);
 const [menu,setMenu]=useState<string|null>(null); const [partialQuote,setPartialQuote]=useState('');
 const [edit,setEdit]=useState<{id:string;text:string}|null>(null); const [count,setCount]=useState(props.m0?Number.MAX_SAFE_INTEGER:30);
 const all=[...messages,...composer.pending];
 const close=()=>{setMenu(null);setEdit(null);if(oldScroll.current!==null&&scroll.current){scroll.current.scrollTop=oldScroll.current;oldScroll.current=null;}};
 useEffect(()=>{const el=scroll.current;if(!el)return;el.scrollTop=props.m0?.initialLatest?el.scrollHeight:composer.scroll;
  if(!props.m0)return;const observer=new ResizeObserver(()=>{if(pinned.current)el.scrollTop=el.scrollHeight;});observer.observe(el);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(props.m0&&input.current){input.current.style.height='auto';input.current.style.height=Math.min(input.current.scrollHeight,120)+'px';}},[readOnly,composer.draft]);
 useLayoutEffect(()=>{if(props.live&&pinned.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[messages.length,messages.at(-1)?.versions[0],props.live?.status]);
 useLayoutEffect(()=>{const el=scroll.current,anchor=earlierAnchor.current;if(!el||!anchor)return;const node=el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);if(node){el.scrollTop+=node.getBoundingClientRect().top-el.getBoundingClientRect().top-anchor.offset;earlierAnchor.current=null;}},[messages[0]?.id,messages.length]);
 async function earlier(){const el=scroll.current;if(!el||!props.m0||props.m0.loadingEarlier)return;const bounds=el.getBoundingClientRect(),node=[...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(n=>n.getBoundingClientRect().bottom>bounds.top+1);if(node)earlierAnchor.current={id:node.dataset.messageId!,offset:node.getBoundingClientRect().top-bounds.top};pinned.current=false;await props.m0.loadEarlier();}
 useEffect(()=>{if(!menu)return;const frame=requestAnimationFrame(()=>{const timeline=scroll.current;const bar=timeline?.querySelector('.v11-bubblebar');if(timeline&&bar){const excess=bar.getBoundingClientRect().bottom-timeline.getBoundingClientRect().bottom+12;if(excess>0)timeline.scrollTop+=excess;}});return()=>cancelAnimationFrame(frame);},[menu,edit]);
 useEffect(()=>{if(!props.jumpId)return;setCount(messages.length);const id=props.jumpId;const frame=requestAnimationFrame(()=>{scroll.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'});props.onJumped();});return()=>cancelAnimationFrame(frame);},[props.jumpId,messages.length]);
 function open(m:Message){if(m.delivery)return;oldScroll.current=scroll.current?.scrollTop??null;const selection=window.getSelection()?.toString().trim()??'';setPartialQuote(textOf(m).includes(selection)?selection:'');setMenu(m.id);setEdit(null);}
 function update(id:string,change:(m:Message)=>Message){if(composer.pending.some(m=>m.id===id))props.onPending(composer.pending.map(m=>m.id===id?change(m):m));else props.onMessages(messages.map(m=>m.id===id?change(m):m));}
 function action(m:Message,name:string){
   if((readOnly||props.live)&&name!=='copy'){props.notice('此操作尚未接通，不会修改已保存消息');return;}
   if(props.locked&&(m.pending||props.onOperate)){props.notice('提交结果尚未确认，不能改动原快照');return;}
   if(props.linked&&!m.pending&&!props.onOperate&&!['copy','quote'].includes(name)){props.notice('正式消息编辑、删除和版本接口尚未接入');return;}
   if(props.linked&&props.onOperate&&m.pending&&name==='quote'){props.notice('待提交气泡尚无可核验的服务端来源，请先提交');return;}
   if(name==='copy'||name==='quote'){
     const selected=partialQuote;void (async()=>{const current=props.onRead&&!m.pending?await props.onRead(m):textOf(m);
      if(name==='copy'){if(navigator.clipboard)await navigator.clipboard.writeText(current);else throw Error('浏览器不支持剪贴板，请选中文字复制');props.notice('已复制');}
      else onCompose({quote:{id:m.id,author:titleOf(room,m.author),text:selected&&current.includes(selected)?selected:current,...(m.sourceRef?{source:{conversationId:room.id,...m.sourceRef,bubbleId:m.id}}:{})}});
      close();})().catch(e=>props.notice((e as Error).message));return;
   }
   if(props.linked&&props.onOperate&&!m.pending){
    if(name==='edit'){setEdit({id:m.id,text:textOf(m)});return;}
    void props.onOperate(m,name).then(close).catch(e=>props.notice((e as Error).message));return;
   }
   if(name==='delete'){if(m.pending)props.onPending(composer.pending.filter(x=>x.id!==m.id));else props.onMessages(messages.filter(x=>x.id!==m.id));close();}
   if(name==='edit')setEdit({id:m.id,text:textOf(m)});
   if(name==='prev'||name==='next'){update(m.id,x=>({...x,version:Math.max(0,Math.min(x.versions.length-1,x.version+(name==='next'?1:-1)))}));}
   if(name==='regenerate'||name==='regenerateTurn'){
     props.onMessages(messages.map(x=>(name==='regenerate'?x.id===m.id:x.turnId===m.turnId&&x.author!=='me')?{...x,versions:[...x.versions,textOf(x)+'（模拟新版本）'],version:x.versions.length}:x));
     props.notice('仅生成合成版本，未调用模型');
   }
   if(name==='up'||name==='down'){const list=[...composer.pending];const i=list.findIndex(x=>x.id===m.id),j=i+(name==='up'?-1:1);if(j>=0&&j<list.length){[list[i],list[j]]=[list[j],list[i]];props.onPending(list);}}
 }
 const bottom=()=>requestAnimationFrame(()=>{pinned.current=true;if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;});
 function stage(){props.onStage();bottom();}
 return <>
   <header className="v11-chat-head">{props.m0&&<div className="m0-header-actions"><button className="v11-icon" onClick={props.m0.onNavigation} aria-label="打开主导航">☰</button><button className="v11-back" onClick={props.onBack} aria-label="返回会话列表">‹</button></div>}{!props.m0&&<button className="v11-back" onClick={props.onBack} aria-label="返回会话列表">〈 返回</button>}<div className="v11-chat-title"><strong>{room.name}</strong>{room.kind==='private'&&<small>{props.m0?.modelLabel??'模型信息未加载'}</small>}</div><button className="v11-icon" onClick={props.onDetails} aria-label="聊天详情">···</button></header>
   <div ref={scroll} className={`v11-timeline ${menu?'selecting':''}`} aria-label="聊天时间线" onScroll={e=>{const el=e.currentTarget;if(readOnly&&el.clientHeight===0)return;pinned.current=el.scrollHeight-el.scrollTop-el.clientHeight<48;const top=el.scrollTop;if(scrollSave.current)clearTimeout(scrollSave.current);scrollSave.current=setTimeout(()=>composeRef.current({scroll:top}),120);}} onClick={e=>{if(menu&&!(e.target as HTMLElement).closest('.chosen'))close();}}>
     {props.m0?.hasEarlier&&<button className="v11-text-button" disabled={props.m0.loadingEarlier} onClick={()=>void earlier()}>{props.m0.loadingEarlier?'正在读取更早记录…':'加载更早消息'}</button>}
     {messages.length>count&&<button className="v11-text-button" onClick={()=>{const el=scroll.current;const before=el?.scrollHeight??0;setCount(n=>n+30);requestAnimationFrame(()=>{if(el)el.scrollTop+=el.scrollHeight-before;});}}>加载更早消息</button>}
     <p className="v11-date">{props.live?'已保存聊天':readOnly?'独立测试库 · 已保存记录':'合成数据 · 不连接真实聊天'}</p>
     {all.slice(Math.max(0,messages.length-count)).map((m,i,array)=><Bubble key={m.id} m={m} room={room} selected={menu===m.id} onOpen={()=>open(m)} onQuoteJump={id=>{if(!messages.some(x=>x.id===id)){props.notice('原消息不可用，请刷新后重试');return;}const target=messages.find(x=>x.id===id)!;void (async()=>{if(props.onRead)await props.onRead(target);setCount(messages.length);requestAnimationFrame(()=>scroll.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'}));})().catch(e=>props.notice((e as Error).message));}}>
       {menu===m.id&&<div className="v11-bubblebar" aria-label="消息操作">
         {edit?.id===m.id?<><textarea aria-label="编辑消息" value={edit.text} onChange={e=>setEdit({...edit,text:e.target.value})}/><button disabled={!edit.text.trim()} onClick={()=>{const value=props.onOperate?edit.text:edit.text.trim();if(props.linked&&props.onOperate&&!m.pending){void props.onOperate(m,'edit',value).then(close).catch(e=>props.notice((e as Error).message));return;}update(m.id,x=>({...x,versions:[...x.versions,value],version:x.versions.length}));close();}}>保存</button><button onClick={close}>取消</button></>:<>
           {(['copy','edit','delete','quote'] as const).map((a,i)=><button key={a} disabled={(readOnly||!!props.live)&&a!=='copy'} title={readOnly&&a!=='copy'?'M0-2尚未接通':undefined} onClick={()=>action(m,a)}>{['复制','编辑','删除','引用'][i]}</button>)}
           {m.author!=='me'&&(!props.linked||props.onOperate)&&<><button onClick={()=>action(m,'regenerate')}>{props.onOperate?'单泡重生成':'模拟单泡重生成'}</button><button onClick={()=>action(m,'regenerateTurn')}>{props.onOperate?'整回合重生成':'模拟整回合重生成'}</button><button disabled={m.version===0} onClick={()=>action(m,'prev')}>上一版本</button><button disabled={m.version===m.versions.length-1} onClick={()=>action(m,'next')}>下一版本</button></>}
           {props.onOperate&&m.author==='me'&&!m.pending&&m.versions.length>1&&<><button disabled={m.version===0} onClick={()=>action(m,'prev')}>上一版本</button><button disabled={m.version===m.versions.length-1} onClick={()=>action(m,'next')}>下一版本</button></>}
           {m.pending&&<><button disabled={composer.pending[0].id===m.id} onClick={()=>action(m,'up')}>上移</button><button disabled={composer.pending.at(-1)?.id===m.id} onClick={()=>action(m,'down')}>下移</button></>}
           <button onClick={close}>关闭</button>
         </>}
       </div>}
       {m.delivery?<small className="v11-pending-label">{m.delivery==='sending'?'正在发送 · 尚未确认保存':'正在生成 · 尚未保存'}</small>:m.pending?<small className="v11-pending-label">待提交</small>:array[i+1]?.turnId!==m.turnId&&<small className="v11-meta">{new Date(m.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}{m.author!=='me'&&!readOnly&&!props.live?' · Token / 缓存统计未提供':''}</small>}
       {m.versions.length>1&&<small className="v11-meta">版本 {m.version+1}/{m.versions.length}</small>}
     </Bubble>)}
     {!all.length&&<p className="v11-empty">{readOnly?'此测试会话暂无已保存消息':'还没有消息，发出第一句问候吧。'}</p>}
   </div>
   <form className="v11-composer" onSubmit={e=>{e.preventDefault();if(props.live){if(!props.live.disabled)props.onSubmit();bottom();return;}if(readOnly){props.notice('发送待M0-3授权，本轮不会调用模型');return;}if(composer.draft.trim())stage();else if(composer.pending.length){props.onSubmit();bottom();}else props.notice('语音与通话尚未接入，不会启动录音');}}>
     {props.live?.replyPicker}
     {composer.quote&&<div className="v11-quote-preview"><div><small>引用 · {composer.quote.author}</small><p>{composer.quote.text}</p></div><button type="button" onClick={()=>onCompose({quote:undefined})} aria-label="取消引用">×</button></div>}
     <div className="v11-compose-row"><button type="button" className="v11-icon" disabled={readOnly||!!props.live} title={readOnly?'附件尚未接通':undefined} onClick={()=>props.notice('图片、文件与语音尚未接入；不会上传文件')} aria-label="添加附件">＋</button>
       <textarea ref={input} disabled={props.locked} maxLength={props.live?.maxLength} aria-label="输入消息" enterKeyHint={props.m0?'enter':undefined} rows={1} placeholder={readOnly?'输入草稿，发送尚未接通':'输入消息…'} value={composer.draft} onChange={e=>onCompose({draft:e.target.value})} onKeyDown={e=>{if(!readOnly&&!props.live&&e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(composer.draft.trim())stage();}}}/>
       <button disabled={props.locked||readOnly||props.live?.disabled} title={readOnly?'发送与模型调用未开放':undefined} className="v11-primary" type="submit">{props.live?'发送':readOnly?'发送 · 未接通':composer.draft.trim()?'暂存':composer.pending.length?'最终提交':'语音'}</button>
     </div><p className="v11-hint">{props.live?props.live.status:readOnly?'草稿只保留在本页；本轮不发送、不调用模型':props.linked?'暂存不调用模型；最终提交仅调用隔离假模型':'文字先暂存，最终提交仅更新演示时间线，不调用 AI'}</p>
   </form>
 </>;
}
