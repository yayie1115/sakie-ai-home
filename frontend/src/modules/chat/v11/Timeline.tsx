import { useEffect, useRef, useState } from 'react';
import { emptyComposer, textOf, titleOf, type Room, type Message, type Composer } from './state';
import { useLongPress } from './useLongPress';

type Props={room:Room;messages:Message[];composer:Composer;onCompose:(patch:Partial<Composer>)=>void;
 onStage:()=>void;onSubmit:()=>void;onMessages:(messages:Message[])=>void;onPending:(messages:Message[])=>void;
 onBack:()=>void;onDetails:()=>void;notice:(message:string)=>void;jumpId?:string;onJumped:()=>void;locked?:boolean;linked?:boolean};
function Bubble({m,room,selected,onOpen,onQuoteJump,children}:{m:Message;room:Room;selected:boolean;onOpen:()=>void;onQuoteJump:(id:string)=>void;children:React.ReactNode}){
 const press=useLongPress(onOpen);
 return <article className={`v11-message ${m.author==='me'?'mine':''} ${selected?'chosen':''}`} data-message-id={m.id}>
   <span className="v11-avatar" aria-hidden="true">{titleOf(room,m.author).slice(-1)}</span>
   <div className="v11-message-body">{room.kind==='group'&&m.author!=='me'&&<span className="v11-speaker">{titleOf(room,m.author)}</span>}
     {m.quote&&<button className="v11-quoted" onClick={()=>onQuoteJump(m.quote!.id)}>{m.quote.author}：{m.quote.text}</button>}
     <div className={`v11-bubble ${m.pending?'pending':''}`} {...press} tabIndex={0} onKeyDown={e=>{if(e.key==='F10'&&e.shiftKey){e.preventDefault();onOpen();}}}>{textOf(m)}</div>
     {children}
   </div>
 </article>;
}
export function Timeline(props:Props){
 const {room,messages,composer,onCompose}=props;
 const scroll=useRef<HTMLDivElement>(null); const oldScroll=useRef<number|null>(null);
 const [menu,setMenu]=useState<string|null>(null); const [partialQuote,setPartialQuote]=useState('');
 const [edit,setEdit]=useState<{id:string;text:string}|null>(null); const [count,setCount]=useState(30);
 const all=[...messages,...composer.pending];
 const close=()=>{setMenu(null);setEdit(null);if(oldScroll.current!==null&&scroll.current){scroll.current.scrollTop=oldScroll.current;oldScroll.current=null;}};
 useEffect(()=>{if(scroll.current)scroll.current.scrollTop=composer.scroll;},[]);
 useEffect(()=>{if(!menu)return;const frame=requestAnimationFrame(()=>{const timeline=scroll.current;const bar=timeline?.querySelector('.v11-bubblebar');if(timeline&&bar){const excess=bar.getBoundingClientRect().bottom-timeline.getBoundingClientRect().bottom+12;if(excess>0)timeline.scrollTop+=excess;}});return()=>cancelAnimationFrame(frame);},[menu,edit]);
 useEffect(()=>{if(!props.jumpId)return;setCount(messages.length);const id=props.jumpId;const frame=requestAnimationFrame(()=>{scroll.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'});props.onJumped();});return()=>cancelAnimationFrame(frame);},[props.jumpId,messages.length]);
 function open(m:Message){oldScroll.current=scroll.current?.scrollTop??null;const selection=window.getSelection()?.toString().trim()??'';setPartialQuote(textOf(m).includes(selection)?selection:'');setMenu(m.id);setEdit(null);}
 function update(id:string,change:(m:Message)=>Message){if(composer.pending.some(m=>m.id===id))props.onPending(composer.pending.map(m=>m.id===id?change(m):m));else props.onMessages(messages.map(m=>m.id===id?change(m):m));}
 function action(m:Message,name:string){
   if(props.locked&&m.pending){props.notice('提交结果尚未确认，不能改动原快照');return;}
   if(props.linked&&!m.pending&&!['copy','quote'].includes(name)){props.notice('正式消息编辑、删除和版本接口尚未接入');return;}
   if(name==='copy'){if(navigator.clipboard)navigator.clipboard.writeText(textOf(m)).then(()=>props.notice('已复制'),()=>props.notice('浏览器不允许复制，请选中文字复制'));else props.notice('浏览器不支持剪贴板，请选中文字复制');close();}
   if(name==='quote'){onCompose({quote:{id:m.id,author:titleOf(room,m.author),text:partialQuote||textOf(m),...(m.sourceRef?{source:{conversationId:room.id,...m.sourceRef,bubbleId:m.id}}:{})}});close();}
   if(name==='delete'){if(m.pending)props.onPending(composer.pending.filter(x=>x.id!==m.id));else props.onMessages(messages.filter(x=>x.id!==m.id));close();}
   if(name==='edit')setEdit({id:m.id,text:textOf(m)});
   if(name==='prev'||name==='next'){update(m.id,x=>({...x,version:Math.max(0,Math.min(x.versions.length-1,x.version+(name==='next'?1:-1)))}));}
   if(name==='regenerate'||name==='regenerateTurn'){
     props.onMessages(messages.map(x=>(name==='regenerate'?x.id===m.id:x.turnId===m.turnId&&x.author!=='me')?{...x,versions:[...x.versions,textOf(x)+'（模拟新版本）'],version:x.versions.length}:x));
     props.notice('仅生成合成版本，未调用模型');
   }
   if(name==='up'||name==='down'){const list=[...composer.pending];const i=list.findIndex(x=>x.id===m.id),j=i+(name==='up'?-1:1);if(j>=0&&j<list.length){[list[i],list[j]]=[list[j],list[i]];props.onPending(list);}}
 }
 const bottom=()=>requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;});
 function stage(){props.onStage();bottom();}
 return <>
   <header className="v11-chat-head"><button className="v11-back" onClick={props.onBack} aria-label="返回会话列表">〈 返回</button><div className="v11-chat-title"><strong>{room.name}</strong>{room.kind==='private'&&<small>模型信息未加载</small>}</div><button className="v11-icon" onClick={props.onDetails} aria-label="聊天详情">···</button></header>
   <div ref={scroll} className={`v11-timeline ${menu?'selecting':''}`} aria-label="聊天时间线" onScroll={e=>onCompose({scroll:e.currentTarget.scrollTop})} onClick={e=>{if(menu&&!(e.target as HTMLElement).closest('.chosen'))close();}}>
     {messages.length>count&&<button className="v11-text-button" onClick={()=>{const el=scroll.current;const before=el?.scrollHeight??0;setCount(n=>n+30);requestAnimationFrame(()=>{if(el)el.scrollTop+=el.scrollHeight-before;});}}>加载更早消息</button>}
     <p className="v11-date">合成数据 · 不连接真实聊天</p>
     {all.slice(Math.max(0,messages.length-count)).map((m,i,array)=><Bubble key={m.id} m={m} room={room} selected={menu===m.id} onOpen={()=>open(m)} onQuoteJump={id=>{if(!messages.some(x=>x.id===id)){props.notice('原消息已从演示会话移除');return;}setCount(messages.length);requestAnimationFrame(()=>scroll.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'}));}}>
       {menu===m.id&&<div className="v11-bubblebar" aria-label="消息操作">
         {edit?.id===m.id?<><textarea aria-label="编辑消息" value={edit.text} onChange={e=>setEdit({...edit,text:e.target.value})}/><button disabled={!edit.text.trim()} onClick={()=>{const value=edit.text.trim();update(m.id,x=>({...x,versions:[...x.versions,value],version:x.versions.length}));close();}}>保存</button><button onClick={close}>取消</button></>:<>
           {(['copy','edit','delete','quote'] as const).map((a,i)=><button key={a} onClick={()=>action(m,a)}>{['复制','编辑','删除','引用'][i]}</button>)}
           {m.author!=='me'&&!props.linked&&<><button onClick={()=>action(m,'regenerate')}>模拟单泡重生成</button><button onClick={()=>action(m,'regenerateTurn')}>模拟整回合重生成</button><button disabled={m.version===0} onClick={()=>action(m,'prev')}>上一版本</button><button disabled={m.version===m.versions.length-1} onClick={()=>action(m,'next')}>下一版本</button></>}
           {m.pending&&<><button disabled={composer.pending[0].id===m.id} onClick={()=>action(m,'up')}>上移</button><button disabled={composer.pending.at(-1)?.id===m.id} onClick={()=>action(m,'down')}>下移</button></>}
           <button onClick={close}>关闭</button>
         </>}
       </div>}
       {m.pending?<small className="v11-pending-label">待提交</small>:array[i+1]?.turnId!==m.turnId&&<small className="v11-meta">{new Date(m.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}{m.author!=='me'?' · Token / 缓存统计未提供':''}</small>}
       {m.versions.length>1&&<small className="v11-meta">版本 {m.version+1}/{m.versions.length}</small>}
     </Bubble>)}
     {!all.length&&<p className="v11-empty">还没有消息，发出第一句问候吧。</p>}
   </div>
   <form className="v11-composer" onSubmit={e=>{e.preventDefault();if(composer.draft.trim())stage();else if(composer.pending.length){props.onSubmit();bottom();}else props.notice('语音与通话尚未接入，不会启动录音');}}>
     {composer.quote&&<div className="v11-quote-preview"><div><small>引用 · {composer.quote.author}</small><p>{composer.quote.text}</p></div><button type="button" onClick={()=>onCompose({quote:undefined})} aria-label="取消引用">×</button></div>}
     <div className="v11-compose-row"><button type="button" className="v11-icon" onClick={()=>props.notice('图片、文件与语音尚未接入；不会上传文件')} aria-label="添加附件">＋</button>
       <textarea disabled={props.locked} aria-label="输入消息" rows={1} placeholder="输入消息…" value={composer.draft} onChange={e=>onCompose({draft:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(composer.draft.trim())stage();}}}/>
       <button disabled={props.locked} className="v11-primary" type="submit">{composer.draft.trim()?'暂存':composer.pending.length?'最终提交':'语音'}</button>
     </div><p className="v11-hint">{props.linked?'暂存不调用模型；最终提交仅调用隔离假模型':'文字先暂存，最终提交仅更新演示时间线，不调用 AI'}</p>
   </form>
 </>;
}
