import {useNotice} from '../../app/useNotice';
import {V11SubmissionClient,DefinitiveSubmissionRejection} from './v11/submission';
import type {V11Submission,V11SubmissionReceipt,V11PendingBubble} from '@sakie/contracts';
import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ChatConversation, ChatConversationPage, ChatHistoryPage, ChatMessage, ChatTurn, DurableMessageReceipt, ChatParticipant, ChatConversationProfile } from '@sakie/contracts';
import { ApiError, useApi, useSessionActions } from '../../app/api';
import { ConversationRow } from './v11/ConversationRow';
import { Timeline } from './v11/Timeline';
import { emptyComposer, type Composer, type Message, type Room } from './v11/state';
import { M0EnvironmentContext } from './m0/M0Boundary';
import './group-chat-preview.css';
import './m0/mobile-chat.css';
import {ConversationCreator} from './v11/ConversationCreator';
const ConversationDetailsFrame=lazy(()=>import('./v11/ConversationDetailsFrame').then(m=>({default:m.ConversationDetailsFrame})));
const MemoryPanel=lazy(()=>import('./v11/MemoryPanel').then(m=>({default:m.MemoryPanel})));
const base = '/api/chat';
type Settings={configured:boolean;maxMessageChars:number;model?:string;participants?:ChatParticipant[];conversationProfilesEnabled?:boolean;batchEnabled?:boolean;operationsEnabled?:boolean;versionsEnabled?:boolean};
import type {LiveChatGeneration as Generation,LiveMessageVersions as Versions} from '@sakie/contracts';
type PendingSend={batch?:V11PendingBubble[];clientMessageId:string;content?:string;time:number;replyToMemberId?:string};
const receiptKey='sakie-chat-pending-receipts';
function readPending():Map<string,PendingSend>{
    try { const rows=JSON.parse(sessionStorage.getItem(receiptKey)??'[]');
        if(!Array.isArray(rows))return new Map();
        return new Map(rows.slice(0,64).filter(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&uuid.test(row[0])&&row[1]&&typeof row[1].clientMessageId==='string'&&uuid.test(row[1].clientMessageId)&&Number.isFinite(row[1].time)).map(([id,p])=>[id,{clientMessageId:p.clientMessageId,time:p.time,...(Array.isArray(p.batch)&&p.batch.length<=16&&p.batch.every((b:V11PendingBubble)=>b&&uuid.test(b.id)&&typeof b.content==='string'&&b.content.length<=12000&&Number.isSafeInteger(b.revision))?{batch:p.batch}:{}),replyToMemberId:typeof p.replyToMemberId==='string'?p.replyToMemberId:undefined}]));
    }catch{return new Map();}
}
function rememberPending(pending:Map<string,PendingSend>,strict=false){
    // Legacy receipts store IDs only; explicit batch recovery keeps unsent text in this tab, cleared on logout/401. Never store credentials/model output.
    try { if(!pending.size)sessionStorage.removeItem(receiptKey);else sessionStorage.setItem(receiptKey,JSON.stringify([...pending].map(([id,p])=>[id,{clientMessageId:p.clientMessageId,time:p.time,replyToMemberId:p.replyToMemberId,...(p.batch?{batch:p.batch}:{})}]))); }catch(e){if(strict)throw e;}
}
const draftsKey='sakie-chat-composers';
function readComposers():Record<string,Composer>{try{const value=JSON.parse(sessionStorage.getItem(draftsKey)??'{}');if(!value||typeof value!=='object'||Array.isArray(value))return {};return Object.fromEntries(Object.entries(value).slice(0,64).filter(([id,c])=>uuid.test(id)&&c&&typeof c==='object').map(([id,c])=>{const v=c as Composer;return [id,{...emptyComposer(),draft:typeof v.draft==='string'?v.draft.slice(0,12000):'',pending:Array.isArray(v.pending)?v.pending.filter(m=>m&&uuid.test(m.id)&&m.pending&&m.author==='me'&&Number.isInteger(m.version)&&m.version>=0&&m.version<m.versions?.length&&Number.isFinite(m.time)&&Array.isArray(m.versions)&&m.versions.every(t=>typeof t==='string'&&t.length<=12000)).slice(0,16):[],scroll:Number.isFinite(v.scroll)?v.scroll:0}];}));}catch{return {};}}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const describe = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status) ? '没有访问权限，请重新登录。' : '记录暂时无法加载，请检查连接后重试。';
function roomOf(c: ChatConversation, participants:readonly ChatParticipant[]): Room { return { id: c.id, kind: c.profile?.kind??'private', name: c.title, members: c.profile?.members??[], remarks: Object.fromEntries((c.profile?.members??[]).map(id=>[id,participants.find(a=>a.id===id)?.name??'未命名 AI'])), activity: Date.parse(c.createdAt), pinned: false, rules: { mixed: false, mentions: false, limited: true } }; }
export function MobileChatPreview({ live = false,embedded=false,uiReady=false }: { live?: boolean;embedded?:boolean;uiReady?:boolean }) {
    const route = live ? '/chat' : '/m0/chat';
    const api = useApi(), session = useSessionActions(), environment = useContext(M0EnvironmentContext);
    const navigate = useNavigate(), location = useLocation();
    const [params] = useSearchParams();
    const chatParams=useRef(params);if(!embedded||location.pathname==='/chat')chatParams.current=params;
    const selected = chatParams.current.get('conversation'), details = chatParams.current.get('view') === 'details';
    const [rooms, setRooms] = useState<ChatConversation[]>([]), [next, setNext] = useState<number | null>(null), [listLoading, setListLoading] = useState(true), [listError, setListError] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([]), [loadedFor, setLoadedFor] = useState<string | null>(null), [before, setBefore] = useState<number | null>(null), [historyError, setHistoryError] = useState(''), [historyBusy, setHistoryBusy] = useState(false);
    const [roomMenu,setRoomMenu]=useState<string|null>(null),[pinned,setPinned]=useState<Record<string,boolean>>({});

    const [query, setQuery] = useState(''),[searchQuery,setSearchQuery]=useState(''), [notice, setNotice] = useNotice(), [drawer, setDrawer] = useState(false), [dark, setDark] = useState(false);
    const [composers, setComposers] = useState<Record<string, Composer>>(readComposers), [scrolled, setScrolled] = useState<Record<string, boolean>>({});
    const composersRef=useRef(composers);composersRef.current=composers;
    useEffect(()=>{if(!live)return;const timer=setTimeout(()=>{try{sessionStorage.setItem(draftsKey,JSON.stringify(composers));}catch{setNotice('暂存无法保存在本标签页，请勿刷新；正式提交前会再次检查。');}},300);return()=>clearTimeout(timer);},[live,composers]);
    const [settings, setSettings] = useState<Settings>({configured:false,maxMessageChars:12000});
    const [turns,setTurns] = useState<Record<string,ChatTurn|null>>({});
    const [memoryOpen,setMemoryOpen]=useState(false);
    const [creating,setCreating]=useState(false),[configuring,setConfiguring]=useState<string|null>(null);
    const [responders,setResponders]=useState<Record<string,string>>({});
    const [versions,setVersions]=useState<Versions|null>(null),[operationsBusy,setOperationsBusy]=useState(false),[generations,setGenerations]=useState<Generation[]>([]),[groupMembers,setGroupMembers]=useState<string[]|null>(null);
    const completedGenerations=useRef(new Set<string>());
    const operationIds=useRef(new Map<string,string>());
    const opId=(key:string)=>{if(!operationIds.current.has(key))operationIds.current.set(key,crypto.randomUUID());return operationIds.current.get(key)!;};
    const [progress,setProgress]=useState<Record<string,string>>({});
    const [writeBusy,setWriteBusy] = useState(false);
    const sending = useRef(false), pendingCreate = useRef(new Map<string,string>());
    const pending = useRef<Map<string,PendingSend>|null>(null);
    if(!pending.current)pending.current=live?readPending():new Map();
    const pendingRequests=pending.current;
    const [online,setOnline]=useState(navigator.onLine),[visible,setVisible]=useState(!document.hidden);
    const [refreshToken,setRefreshToken]=useState(0);
    const listSerial=useRef(0);
    const listFlight=useRef<Promise<void>|null>(null),configCache=useRef<Settings|null>(null);
    const historyController=useRef<AbortController|null>(null),historyFlight=useRef<Promise<void>|null>(null);
    const retries = useRef(new Map<string,string>());
    const intentHistory=useRef(new Map<string,Promise<ChatHistoryPage>>());
    function prepareHistory(id:string){
        if(cache.current.has(id)||intentHistory.current.has(id))return;
        if(intentHistory.current.size>=4)intentHistory.current.delete(intentHistory.current.keys().next().value!);
        const request=api<ChatHistoryPage>(base+'/conversations/'+id+'/messages');
        intentHistory.current.set(id,request);
        void request.catch(()=>{if(intentHistory.current.get(id)===request)intentHistory.current.delete(id);});
    }

    const cache = useRef(new Map<string, {
        items: ChatMessage[];
        before: number | null;
    }>());
    const roomsRef=useRef(rooms);roomsRef.current=rooms;
    const generation = useRef(0), selectedRef = useRef(selected);
    selectedRef.current = selected;
    const listScroll = useRef<HTMLDivElement>(null), listTop = useRef(0), navigation = useRef<HTMLButtonElement>(null);
    function restoreNavigationFocus() { requestAnimationFrame(() => { const button = selected ? document.querySelector<HTMLButtonElement>('.v11-chat-head [aria-label="打开主导航"]') : navigation.current; button?.focus(); }); }
    const loadRooms = useCallback((beforeCursor?: number):Promise<void> => {
        const serial=++listSerial.current;
        const run=async()=>{setListLoading(true);setListError('');try{
            const path=base+'/conversations?limit=50'+(beforeCursor?'&before='+beforeCursor:'')+(searchQuery?'&q='+encodeURIComponent(searchQuery):'');
            const configRequest=configCache.current?Promise.resolve(configCache.current):api<Settings>(base+'/config');
            const [config,page]=live?await Promise.all([configRequest,api<ChatConversationPage>(path)]):await(async()=>{
                const config=await configRequest;if(config.configured!==false)throw Error('M0 model boundary mismatch');
                return [config,await api<ChatConversationPage>(path)] as const;
            })();
            if(serial!==listSerial.current)return;
            configCache.current=config;setSettings(config);
            setPinned(old=>({...old,...Object.fromEntries(page.items.map(c=>[c.id,!!c.pinned]))}));
            setRooms(old=>beforeCursor?[...old,...page.items.filter(c=>!old.some(r=>r.id===c.id))]:[...page.items,...old.filter(c=>!searchQuery&&c.id===selectedRef.current&&!page.items.some(r=>r.id===c.id))]);
            setNext(page.nextBefore);
        }catch(e){if(serial===listSerial.current)setListError(describe(e));}finally{if(serial===listSerial.current)setListLoading(false);}};
        listFlight.current=run().finally(()=>{listFlight.current=null;});return listFlight.current;
    },[api,live,searchQuery]);
    useEffect(()=>{const timer=setTimeout(()=>setSearchQuery(query),250);return()=>clearTimeout(timer);},[query]);
    useEffect(()=>{void loadRooms();},[loadRooms]);

    const mergeMessages=useCallback((id:string,rows:ChatMessage[])=>{
        const saved=cache.current.get(id)??{items:[],before:null};
        const items=[...new Map([...saved.items,...rows].map(m=>[m.id,m])).values()].sort((a,b)=>a.messageSeq-b.messageSeq);
        const same=items.length===saved.items.length&&items.every((m,i)=>m.id===saved.items[i].id&&m.content===saved.items[i].content&&m.revision===saved.items[i].revision&&m.speakerId===saved.items[i].speakerId);
        const nextItems=same?saved.items:items;cache.current.set(id,{...saved,items:nextItems});
        if(selectedRef.current===id)setMessages(nextItems);
    },[]);
    const reconcilePending=useCallback(async(id:string,signal?:AbortSignal)=>{
        const p=pendingRequests.get(id);if(!p)return;
        try{
            const result=await api<{turn:ChatTurn;messages:ChatMessage[]}>(base+'/conversations/'+id+(p.batch?'/batch-receipts/':'/receipts/')+p.clientMessageId,{signal});
            if(signal?.aborted)return;
            if(pendingRequests.get(id)?.clientMessageId!==p.clientMessageId)return;
            mergeMessages(id,result.messages);setTurns(old=>({...old,[id]:result.turn}));
            const c=composersRef.current[id];if(c){const next={...composersRef.current,[id]:{...c,...(p.batch?{pending:c.pending.filter(m=>!p.batch!.some(b=>b.id===m.id))}:p.content===c.draft?{draft:''}:{})}};sessionStorage.setItem(draftsKey,JSON.stringify(next));setComposers(next);}
            const remaining=new Map(pendingRequests);remaining.delete(id);rememberPending(remaining,!!p.batch);pendingRequests.delete(id);
            if(selectedRef.current===id)setNotice('');
        }catch(e){
            if(signal?.aborted)return;
            if(e instanceof ApiError&&e.code==='RECEIPT_NOT_FOUND'){
                if(selectedRef.current===id)setNotice(p.batch?'尚未查到批次回执，暂存已保留，可用相同编号重试。':p.content?'尚未查到保存回执；可用同一编号重试发送。':'上次发送尚未查到回执；请重新输入原消息后重试，将沿用原编号。');
            }else if(e instanceof ApiError&&[401,403].includes(e.status))throw e;
        }
    },[api,mergeMessages,pendingRequests]);
    useEffect(()=>{
        const serial=++generation.current,controller=new AbortController();
        historyController.current?.abort();historyController.current=controller;
        historyFlight.current=null;
        const saved=selected?cache.current.get(selected):undefined;
        setMessages(saved?.items??[]);setBefore(saved?.before??null);setLoadedFor(saved&&selected?selected:null);
        setHistoryError('');setHistoryBusy(!!selected);
        if(!selected){setHistoryBusy(false);return;}
        if(!uuid.test(selected)){setHistoryError('会话编号无效；未读取数据。');setHistoryBusy(false);return;}
        const id=selected;
        const roomRequest=roomsRef.current.some(r=>r.id===id)?Promise.resolve(null):api<ChatConversation>(base+'/conversations/'+id,{signal:controller.signal});
        const prepared=intentHistory.current.get(id);intentHistory.current.delete(id);
        const job=Promise.all([prepared??api<ChatHistoryPage>(base+'/conversations/'+id+'/messages',{signal:controller.signal}),roomRequest]).then(async([page,conversation])=>{
            if(conversation&&!controller.signal.aborted)setRooms(old=>old.some(r=>r.id===id)?old:[conversation,...old]);
            if(controller.signal.aborted||generation.current!==serial)return;
            const current=cache.current.get(id),earliest=page.items[0]?.messageSeq??Infinity;
            const retained=page.items.length?current?.items.filter(m=>m.messageSeq<earliest)??[]:[];
            const arrived=current!==saved?(current?.items.filter(m=>m.messageSeq>(page.items.at(-1)?.messageSeq??0))??[]):[];
            const items=[...retained,...page.items,...arrived];
            const cursor=retained.length?current!.before:page.nextBefore;
            cache.current.set(id,{items,before:cursor});setMessages(items);setBefore(cursor);setLoadedFor(id);
            if(live){setTurns(old=>({...old,[id]:page.unresolvedTurn}));await reconcilePending(id,controller.signal);}
        }).catch(e=>{if(!controller.signal.aborted&&generation.current===serial){
            if(e instanceof ApiError&&[401,403,404].includes(e.status)){cache.current.delete(id);setMessages([]);setLoadedFor(null);}
            setHistoryError(describe(e));
        }}).finally(()=>{if(generation.current===serial)setHistoryBusy(false);if(historyFlight.current===job)historyFlight.current=null;});
        historyFlight.current=job;return()=>controller.abort();
    },[api,selected,live,refreshToken,reconcilePending]);
    useEffect(()=>{
        const resume=()=>{setVisible(!document.hidden);setOnline(navigator.onLine);if(!navigator.onLine||document.hidden)return;setRefreshToken(n=>n+1);void loadRooms();};
        const offline=()=>{setOnline(false);};
        window.addEventListener('sakie:conversations-changed',resume);window.addEventListener('online',resume);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',resume);
        return()=>{window.removeEventListener('sakie:conversations-changed',resume);window.removeEventListener('online',resume);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',resume);};
    },[loadRooms]);
    useEffect(() => { if (!selected && listScroll.current)
        listScroll.current.scrollTop = listTop.current; }, [selected]);
    useEffect(() => { if (!drawer)
        return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') {
        setDrawer(false);
        restoreNavigationFocus();
    } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [drawer, selected]);
    async function historyPage(older=false){
        if(!selected||historyFlight.current||older&&before===null)return;
        if(!older){setRefreshToken(n=>n+1);return;}
        const id=selected,serial=generation.current,controller=new AbortController();historyController.current?.abort();historyController.current=controller;
        setHistoryBusy(true);setHistoryError('');
        const job=api<ChatHistoryPage>(base+'/conversations/'+id+'/messages?before='+before,{signal:controller.signal}).then(page=>{
            if(controller.signal.aborted||serial!==generation.current||selectedRef.current!==id)return;
            const saved=cache.current.get(id);cache.current.set(id,{items:saved?.items??[],before:page.nextBefore});
            mergeMessages(id,page.items);setBefore(page.nextBefore);
        }).catch(e=>{if(!controller.signal.aborted&&serial===generation.current)setHistoryError(describe(e));})
        .finally(()=>{if(serial===generation.current)setHistoryBusy(false);if(historyFlight.current===job)historyFlight.current=null;});
        historyFlight.current=job;await job;
    }
    const selectedConversation=rooms.find(r=>r.id===selected);
    const replyMemberId=selectedConversation?.profile?.kind==='private'?selectedConversation.profile.members[0]:(selected?responders[selected]??pendingRequests.get(selected)?.replyToMemberId??(turns[selected]?.status!=='succeeded'?turns[selected]?.replyToMemberId??'':''):'');
    const turn = selected ? turns[selected] : null;
    const pendingSend = selected ? pendingRequests.has(selected) : false;
    const composer = selected ? composers[selected] ?? emptyComposer() : emptyComposer();
    const unresolved = !!turn && turn.status !== 'succeeded';
    const statusText = !online ? '网络已断开；已保存消息不受影响，恢复连接后会重新核对状态。' : pendingSend ? '发送结果未确认；重试将使用同一消息编号。请勿关闭页面。' : turn ? ({queued:'消息已保存，等待回复',running:'消息已保存，正在回复',succeeded:'回复已保存',failed:'回复失败；用户消息已保存',unknown:'上次调用结果未知；用户消息已保存'}[turn.status]+(turn.errorCode?'（'+turn.errorCode+'）':'')) : settings.configured ? '' : '后端模型未配置；历史可读取，发送已禁用。';
    useEffect(()=>{
        if(!live||!online||!selected||!turn||!['queued','running'].includes(turn.status)||!visible)return;
        const id=selected,turnId=turn.id,controller=new AbortController();let active=true,cursor:string|undefined,failures=0;
        let timer:ReturnType<typeof setTimeout>;
        const poll=async()=>{try{
            const result=await api<{turn:ChatTurn;messages:ChatMessage[];updateCursor?:string;progress?:{content:string}|null}>(base+'/turns/'+turnId+(cursor?'?after='+encodeURIComponent(cursor):''),{signal:controller.signal,timeoutMs:30000});
            if(!active||selectedRef.current!==id)return;
            failures=0;setTurns(old=>old[id]?.status===result.turn.status?old:{...old,[id]:result.turn});
            setProgress(old=>{const text=result.turn.status==='running'?result.progress?.content??'':'';return old[id]===text?old:{...old,[id]:text};});
            if(result.messages.length)mergeMessages(id,result.messages);
            cursor=result.updateCursor;
            if(['queued','running'].includes(result.turn.status))timer=setTimeout(poll,cursor?100:500);
        }catch(e){if(active&&!controller.signal.aborted){setNotice(describe(e));
            if(e instanceof ApiError&&[401,403].includes(e.status)){cache.current.clear();setProgress({});setMessages([]);setLoadedFor(null);return;}
            timer=setTimeout(poll,Math.min(1000*2**failures++,10000));
        }}};
        void poll();return()=>{active=false;controller.abort();clearTimeout(timer);};
    },[api,live,online,visible,selected,turn?.id,turn?.status,refreshToken,mergeMessages]);
    useEffect(()=>{if(!live)return;const warn=(event:BeforeUnloadEvent)=>{try{sessionStorage.setItem(draftsKey,JSON.stringify(composersRef.current));}catch{}if(pendingRequests.size||Object.values(composers).some(c=>c.draft||c.pending.length)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[live,composers]);
    function writeError(e:unknown){return e instanceof ApiError ? '请求未完成：'+e.code+'。请刷新状态后重试。' : '连接中断，结果未知。保留页面，重试会复用同一编号。';}
    async function createConversation(kind:ChatConversationProfile['kind'],members:string[],title:string){
        if(!live||sending.current||!settings.conversationProfilesEnabled)return;
        sending.current=true;setWriteBusy(true);
        const key=JSON.stringify({configuring,kind,members,title});
        if(!pendingCreate.current.has(key))pendingCreate.current.set(key,crypto.randomUUID());
        try{
            const c=await api<ChatConversation>(configuring?base+'/conversations/'+configuring+'/profile':base+'/conversations',{
                method:configuring?'PUT':'POST',body:JSON.stringify({id:pendingCreate.current.get(key),title,kind,members})});
            pendingCreate.current.delete(key);setRooms(old=>[c,...old.filter(r=>r.id!==c.id)]);open(c.id);
        }catch(e){throw Error(writeError(e));}finally{sending.current=false;setWriteBusy(false);}
    }
    function stageLive(){if(!selected||sending.current||pendingRequests.has(selected)||!composer.draft.trim())return;if(composer.pending.length>=16){setNotice('每批最多暂存16段，请先提交当前批次。');return;}if(composer.pending.reduce((n,m)=>n+m.versions[m.version].length,0)+composer.draft.length+2*composer.pending.length>settings.maxMessageChars){setNotice('这批文字已超过消息长度限制，请分批提交。');return;}const id=crypto.randomUUID();setComposers(old=>({...old,[selected]:{...(old[selected]??emptyComposer()),draft:'',quote:undefined,pending:[...(old[selected]?.pending??[]),{id,turnId:id,author:'me',versions:[composer.draft],version:0,time:Date.now(),pending:true,...(composer.quote?{quote:composer.quote}:{})}]}}));}
    async function sendBatch(){if(!selected||sending.current||unresolved||!online||!settings.configured||!settings.batchEnabled||!replyMemberId)return;const id=selected,previous=pendingRequests.get(id);const bubbles:V11PendingBubble[]=previous?.batch??composer.pending.map(m=>({id:m.id,revision:m.versions.length,content:m.versions[m.version],...(m.quote?.source?{quote:{...m.quote.source,selectedText:m.quote.text}}:{})}));if(!bubbles.length)return;sending.current=true;setWriteBusy(true);
      const client=new V11SubmissionClient(async request=>{try{return await api<V11SubmissionReceipt>(base+'/conversations/'+id+'/batches',{method:'POST',body:JSON.stringify({submissionId:request.submissionId,segments:request.bubbles,replyToMemberId:previous?.replyToMemberId??replyMemberId})});}catch(e){if(e instanceof ApiError&&([400,413,429].includes(e.status)||['QUOTE_NOT_CURRENT','QUOTE_SCOPE_DENIED'].includes(e.code)))throw new DefinitiveSubmissionRejection('本批尚未保存，内容仍在暂存区，请检查长度或稍后重试。');throw e;}},{
       read:()=>{const p=pendingRequests.get(id);return p?.batch?{schemaVersion:1,conversationId:id,submissionId:p.clientMessageId,bubbles:p.batch}:null;},
       write:request=>{pendingRequests.set(id,{clientMessageId:request.submissionId,batch:request.bubbles,time:previous?.time??Date.now(),replyToMemberId:previous?.replyToMemberId??replyMemberId});rememberPending(pendingRequests,true);},
       clear:()=>{const next=new Map(pendingRequests);next.delete(id);rememberPending(next,true);pendingRequests.delete(id);}
      });
      try{sessionStorage.setItem(draftsKey,JSON.stringify(composersRef.current));const receipt=await client.submit(id,bubbles);const current=composersRef.current[id]??emptyComposer(),next={...composersRef.current,[id]:{...current,pending:current.pending.filter(m=>!receipt.bubbleIds.includes(m.id))}};sessionStorage.setItem(draftsKey,JSON.stringify(next));setComposers(next);client.confirm(receipt);const saved=(receipt as V11SubmissionReceipt&{messages?:ChatMessage[]}).messages;if(saved)mergeMessages(id,saved);setTurns(old=>({...old,[id]:receipt.turn}));setNotice('');}catch(e){setNotice(e instanceof DefinitiveSubmissionRejection||e instanceof Error&&/^(无法持久|服务端持久|待确认)/.test(e.message)?e.message:writeError(e));await reconcilePending(id).catch(()=>{});}finally{sending.current=false;setWriteBusy(false);}
    }
    async function send(){
        if(composer.pending.length||pendingRequests.get(selected??'')?.batch){await sendBatch();return;}
        if(!live||!online||historyBusy||!selected||loadedFor!==selected||sending.current||!settings.configured||!selectedConversation||(!!selectedConversation.profile&&!replyMemberId))return;
        const id=selected;let request=pendingRequests.get(id);
        if(!request){if(unresolved||!composer.draft.trim())return;request={clientMessageId:crypto.randomUUID(),content:composer.draft,time:Date.now(),replyToMemberId:replyMemberId||undefined};pendingRequests.set(id,request);}
        if(!request.content){if(!composer.draft.trim())return;request={...request,content:composer.draft};pendingRequests.set(id,request);}
        rememberPending(pendingRequests);
        sending.current=true;setWriteBusy(true);
        try{
            const receipt=await api<DurableMessageReceipt&{turn:ChatTurn;message?:ChatMessage|null}>(base+'/conversations/'+id+'/messages',{method:'POST',body:JSON.stringify({clientMessageId:request.clientMessageId,content:request.content,replyToMemberId:request.replyToMemberId})});
            pendingRequests.delete(id);rememberPending(pendingRequests);setComposers(old=>({...old,[id]:{...(old[id]??emptyComposer()),draft:old[id]?.draft===request!.content?'':old[id]?.draft??''}}));setTurns(old=>({...old,[id]:receipt.turn}));
            if(receipt.message)mergeMessages(id,[receipt.message]);
            if(receipt.turn.status==='succeeded'){
                const result=await api<{turn:ChatTurn;messages:ChatMessage[]}>(base+'/turns/'+receipt.turnId);
                mergeMessages(id,result.messages);
            }

        }catch(e){setNotice(writeError(e));if(pendingRequests.has(id)&&!(e instanceof ApiError&&[401,403].includes(e.status)))await reconcilePending(id).catch(()=>{});if(e instanceof ApiError&&[400,409,413,429].includes(e.status)&&pendingRequests.has(id)){pendingRequests.set(id,{...request,content:undefined});rememberPending(pendingRequests);}if(e instanceof ApiError&&e.code==='TURN_UNRESOLVED')setRefreshToken(n=>n+1);}finally{sending.current=false;setWriteBusy(false);}
    }
    useEffect(()=>{setVersions(null);setGroupMembers(null);setGenerations([]);if(!selected||!live||!settings.operationsEnabled)return;const id=selected,c=new AbortController();let timer:ReturnType<typeof setTimeout>;
      const poll=async()=>{try{const page=await api<{items:Generation[]}>(base+'/conversations/'+id+'/generations',{signal:c.signal});if(c.signal.aborted||selectedRef.current!==id)return;setGenerations(page.items);const completed=page.items.filter(g=>g.status==='succeeded'&&!completedGenerations.current.has(g.id));if(completed.length){completed.forEach(g=>completedGenerations.current.add(g.id));setRefreshToken(n=>n+1);}if(page.items.some(g=>['pending','running'].includes(g.status)))timer=setTimeout(poll,1000);}catch{if(!c.signal.aborted){setGenerations([]);setNotice('无法读取重生成任务，请重新进入会话恢复状态。');}}};void poll();return()=>{c.abort();clearTimeout(timer);};
    },[api,selected,live,settings.operationsEnabled,refreshToken]);
    async function operateMessage(m:Message,action:string,value?:string){
      if(!selected||unresolved||operationsBusy)throw Error('请等待当前操作结束');const id=selected,revision=m.sourceRef?.revision??1,key=[m.id,revision,action,value??''].join(':');setOperationsBusy(true);
      try{
        if(action==='versions'){setVersions(await api<Versions>(base+'/messages/'+m.id+'/versions'));return;}
        if(action==='regenerate'||action==='regenerateTurn'){
          if(!settings.operationsEnabled)throw Error('正式重生成尚未启用');
          if(!confirm(action==='regenerateTurn'?'重新生成本轮全部 AI 回复？当前正式结构每轮一条 AI 回复；用户分段和后续回合不变。此次会调用真实模型。':'重新生成这条 AI 消息？其他消息不变，此次会调用真实模型。'))return;
          const job=await api<Generation>(base+'/messages/'+m.id+'/regenerations',{method:'POST',body:JSON.stringify({requestId:opId(key),baseRevision:revision,scope:action==='regenerateTurn'?'turn':'bubble'})});setGenerations(old=>[job,...old.filter(g=>g.id!==job.id)]);setRefreshToken(n=>n+1);return;
        }
        if(!['edit','delete'].includes(action))throw Error('此操作尚未开放');if(action==='delete'&&!confirm('删除这条消息？原始记录保留，相关记忆来源将失效。'))return;
        await api(base+'/messages/'+m.id,{method:action==='edit'?'PATCH':'DELETE',body:JSON.stringify({baseRevision:revision,requestId:opId(key),...(action==='edit'?{content:value}:{})})});operationIds.current.delete(key);setRefreshToken(n=>n+1);
      }catch(e){if(e instanceof ApiError&&e.status===409||action==='regenerate'||action==='regenerateTurn')setRefreshToken(n=>n+1);throw Error(writeError(e));}finally{setOperationsBusy(false);}
    }
    async function selectVersion(revision:number){if(!versions||operationsBusy)return;const v=versions;setOperationsBusy(true);try{await api(base+'/messages/'+v.id+'/versions/select',{method:'POST',body:JSON.stringify({requestId:opId([v.id,v.currentRevision,'switch',revision].join(':')),baseRevision:v.currentRevision,revision})});setVersions(null);setRefreshToken(n=>n+1);}catch(e){setNotice(writeError(e));if(e instanceof ApiError&&e.status===409){setVersions(null);setRefreshToken(n=>n+1);}}finally{setOperationsBusy(false);}}
    async function jumpToSource(id:string){if(!selected)throw Error('会话不可用');const roomId=selected;const result=await api<{item:ChatMessage}>(base+'/conversations/'+roomId+'/messages/'+id);if(selectedRef.current!==roomId||!result.item)throw Error('来源不可用');mergeMessages(roomId,[result.item]);}
    async function retryReply(){
        if(!live||!online||!turn||sending.current||!settings.configured)return;
        if(turn.status==='unknown'&&!window.confirm('上一次调用可能已经计费。重试可能再次计费，是否继续？'))return;
        const id=turn.conversationId;retries.current.set(turn.id,retries.current.get(turn.id)??crypto.randomUUID());sending.current=true;setWriteBusy(true);
        try{const result=await api<{turn:ChatTurn}>(base+'/turns/'+turn.id+'/retry',{method:'POST',body:JSON.stringify({retryId:retries.current.get(turn.id),acknowledgeUnknown:turn.status==='unknown'})});retries.current.delete(turn.id);setTurns(old=>({...old,[id]:result.turn}));}
        catch(e){setNotice(writeError(e));}finally{sending.current=false;setWriteBusy(false);}
    }
    function open(id: string) {const saved=cache.current.get(id);setMessages(saved?.items??[]);setBefore(saved?.before??null);setLoadedFor(saved?id:null);setHistoryError('');setCreating(false);setConfiguring(null); listTop.current = listScroll.current?.scrollTop ?? 0; setNotice(''); setDrawer(false); navigate(route + '?conversation=' + encodeURIComponent(id), { state: { m0FromList: true } }); }
    function back() {if(creating){setCreating(false);setConfiguring(null);return;} setDrawer(false); setNotice(''); if (details) {
        navigate(route + '?conversation=' + encodeURIComponent(selected ?? ''), { replace: true, state: { m0FromList: true } });
        return;
    } if (location.state?.m0FromList)
        navigate(-1);
    else
        navigate(route, { replace: true }); }
    const conversation = rooms.find(r => r.id === selected), room = useMemo(()=>conversation?roomOf(conversation,settings.participants??[]):undefined,[conversation,settings.participants]);
    const savedDisplay=useMemo(()=>messages.map(m => ({ id: m.id, turnId: m.turnId, author: m.role === 'user' ? 'me' : m.speakerId??'unattributed', versions: [m.content], version: 0, time: Date.parse(m.createdAt), usage:m.usage,...(m.quote?{quote:{id:m.quote.messageId,author:'引用消息',text:m.quote.unavailable?'来源已变化或不可用':m.quote.selectedText,unavailable:m.quote.unavailable,source:{conversationId:m.quote.conversationId,messageId:m.quote.messageId,revision:m.quote.revision,bubbleId:m.quote.bubbleId}}}:{}),sourceRef: { messageId: m.id, revision: m.revision ?? 1 } })),[messages]);
    const display:Message[]=[...savedDisplay];
    if(live&&selected){
        const waiting=pendingRequests.get(selected);
        if(waiting?.content&&turn?.clientMessageId!==waiting.clientMessageId)display.push({id:waiting.clientMessageId,turnId:waiting.clientMessageId,author:'me',versions:[waiting.content],version:0,time:waiting.time,delivery:'sending'});
        if(turn?.status==='running'&&progress[selected])display.push({id:'stream-'+turn.id,turnId:turn.id,author:turn.replyToMemberId??'unattributed',versions:[progress[selected]],version:0,time:Date.parse(turn.createdAt),delivery:'streaming'});
    }
    async function copySource(m: Message) { if (!selected || selectedRef.current !== selected)
        throw Error('会话已切换'); const source = messages.find(row => row.id === m.id); if (!source)
        throw Error('来源已失效'); const page = await api<ChatHistoryPage>(base + '/conversations/' + selected + '/messages?limit=1&before=' + (source.messageSeq + 1)); const current = page.items.find(row => row.id === m.id); if (!current || (current.revision ?? 1) !== m.sourceRef?.revision)
        throw Error('来源已变更，请刷新后复制'); if(selectedRef.current!==selected)throw Error('会话已切换'); return current.content; }
    return <div className={(embedded?'embedded ':'')+'m0-shell ' + (dark ? 'dark' : '') + (drawer ? ' nav-open' : '')}>
  <aside className="m0-drawer" aria-label="主导航侧栏" aria-hidden={!drawer} inert={!drawer}><button onClick={() => { setDrawer(false); restoreNavigationFocus(); }} aria-label="关闭主导航">关闭 ‹</button><nav aria-label="侧栏导航"><button disabled title="尚未接通">Home · 未开放</button><button aria-current="page" onClick={() => { setDrawer(false); navigate(route); }}>Chat</button><button disabled title="尚未接通">World · 未开放</button></nav><button onClick={() => setDark(d => !d)}>{dark ? '浅色外观' : '深色外观'}</button><button disabled={session.busy} onClick={() => void session.logout()}>退出登录</button><small>{live ? '正式聊天 · 同源认证\n记忆按来源授权使用' : '独立测试 · 只读\n模型调用关闭'}</small></aside>
  <div className="m0-content"><section className={'v11-workspace m0-workspace ' + (dark ? 'dark ' : '') + (selected ? 'show-chat' : 'show-list')} aria-label={live ? "小家聊天" : "小家 M0 独立测试聊天"}>
   {creating&&<ConversationCreator participants={settings.participants??[]} busy={writeBusy} heading={configuring?'设置会话成员':'新建会话'} onCreate={createConversation} onClose={()=>{setCreating(false);setConfiguring(null);}}/>}
   <aside className="v11-sidebar" aria-label="会话列表"><header className="v11-side-head"><div><button ref={navigation} className="v11-icon" aria-label="打开主导航" aria-expanded={drawer} onClick={() => setDrawer(d => !d)}>☰</button><h2>聊天</h2><div><button className="v11-icon" disabled={!live||writeBusy||!settings.conversationProfilesEnabled} onClick={() => {setCreating(true);setConfiguring(null);}} title={live?"新建会话":"新建会话待后续授权"} aria-label={live?"新建会话":"新建会话未开放"}>＋</button></div></div><input aria-label="搜索会话" placeholder="搜索会话与聊天记录" value={query} onChange={e => setQuery(e.target.value)}/></header>
    <div ref={listScroll} className="v11-room-list" onScroll={e => { if (e.currentTarget.clientHeight > 0)
        listTop.current = e.currentTarget.scrollTop; }}>{rooms.map(c => <ConversationRow key={c.id} room={{...roomOf(c,settings.participants??[]),pinned:!!pinned[c.id]}} active={c.id === selected} preview={c.profile?.kind==='group'?'群聊 · '+c.profile.members.length+' 位 AI':c.profile?'私聊 · 查看已保存记录':'历史会话 · 成员待设置'} showActivity={false} onIntent={()=>prepareHistory(c.id)} onSelect={() => open(c.id)} onMenu={() => setRoomMenu(c.id)}/>)}
     {listLoading && <p role="status">正在读取会话…</p>}{listError && <p role="alert">{listError}<button onClick={() => void loadRooms()}>重试读取会话</button></p>}{!listLoading && !listError && !rooms.length && <p className="v11-empty">{live ? '还没有会话，点击右上角 ＋ 开始聊天。' : '独立测试库暂无会话。新建与发送尚未开放，不会填充演示消息。'}</p>}{false && <p className="v11-empty">没有匹配的已加载会话</p>}{next && <button className="v11-text-button" disabled={listLoading} onClick={() => void loadRooms(next)}>加载更多会话</button>}
    </div><footer>{live ? settings.conversationProfilesEnabled?'已保存会话':'会话成员功能待数据库扩展升级' : environment.fixture ? '自动化测试夹具 · 合成记录' : 'M0-2 独立只读测试'}<button onClick={() => void loadRooms()} disabled={listLoading}>刷新列表</button></footer>
   </aside>
   <div className="v11-chat">{room && !historyError ? <Timeline key={room.id} room={room} messages={loadedFor===room.id?display:[]} composer={composers[room.id] ?? emptyComposer()} onCompose={patch => { setComposers(old => ({ ...old, [room.id]: { ...(old[room.id] ?? emptyComposer()), ...patch } })); if ('scroll' in patch)
        setScrolled(old => ({ ...old, [room.id]: true })); }} onStage={stageLive} onSubmit={() => live ? void send() : setNotice('发送尚未开放')} onPending={pending=>{if(selected&&!pendingRequests.has(selected))setComposers(old=>({...old,[selected]:{...(old[selected]??emptyComposer()),pending}}));}} onMessages={() => setNotice('消息修改尚未接通')} onBack={back} onDetails={() => navigate(location.pathname + location.search + '&view=details')} notice={setNotice} active={!embedded||location.pathname==='/chat'&&!details&&!memoryOpen} onOperate={live?operateMessage:undefined} onQuoteJump={live?jumpToSource:undefined} onJumped={() => { }} linked locked={live&&(writeBusy||!!pendingRequests.get(selected??'')?.content)} live={live?{disabled:writeBusy||generations.some(g=>['pending','running'].includes(g.status))||(historyBusy&&loadedFor!==room?.id)||!online||!settings.configured||!selectedConversation||(!!selectedConversation.profile&&!replyMemberId)||(!pendingSend&&(!composer.draft.trim()&&!composer.pending.length||unresolved))||(pendingSend&&!pendingRequests.get(selected??'')?.content&&!pendingRequests.get(selected??'')?.batch&&!composer.draft.trim()),batchEnabled:settings.batchEnabled,operationsEnabled:settings.operationsEnabled,versionsEnabled:settings.versionsEnabled,generationView:generations.length?<section className="live-chat-status" aria-label="重新生成任务">{generations.slice(0,3).map(g=><details key={g.id} open={['pending','running'].includes(g.status)}><summary>{g.scope==='turn'?'整轮':'单条'}重新生成 · {{pending:'等待处理',running:'生成中',succeeded:'已保存新版本',failed:'失败，原版本保留',cancelled:'已取消，原版本保留',unknown:'调用结果未知，原版本保留'}[g.status]}</summary>{g.partial&&<p style={{whiteSpace:'pre-wrap'}}>{g.partial}</p>}{g.errorCode&&<p>{g.errorCode==='SOURCES_CHANGED'?'来源已变化，不显示旧任务内容。':'任务未完成，可检查来源及网络后手动重试。'}</p>}{['pending','running'].includes(g.status)&&<button onClick={async()=>{try{await api(base+'/generations/'+g.id+'/cancel',{method:'POST'});setRefreshToken(n=>n+1);}catch(e){setNotice(writeError(e));}}}>取消生成</button>}{['failed','cancelled','unknown'].includes(g.status)&&<button disabled={operationsBusy} onClick={async()=>{const m=display.find(m=>m.id===g.messageId);if(!m)return setNotice('请先加载原消息');if(g.status==='unknown'&&!confirm('上次调用可能已计费，重试可能再次计费。继续？'))return;operationIds.current.delete([m.id,m.sourceRef?.revision??1,g.scope==='turn'?'regenerateTurn':'regenerate',''].join(':'));await operateMessage(m,g.scope==='turn'?'regenerateTurn':'regenerate').catch(e=>setNotice((e as Error).message));}}>手动重试</button>}</details>)}</section>:undefined,maxLength:settings.maxMessageChars,status:statusText,replyPicker:room.kind==='group'?<div className="v11-setting"><label>本次回复成员 <select aria-label="本次回复成员" disabled={writeBusy||pendingSend||unresolved} value={replyMemberId} onChange={e=>setResponders(old=>({...old,[room.id]:e.target.value}))}><option value="">请选择成员</option>{room.members.map(id=><option key={id} value={id}>{room.remarks[id]}</option>)}</select><small>手动单次回复 · 共用模型 · 自主调度及角色人格未配置</small></label></div>:undefined}:undefined} onRead={copySource} m0={{ modelLabel: live?(settings.model||'模型未配置'):'模型未启用', onNavigation: () => setDrawer(d => !d), initialLatest: !scrolled[room.id], loading:loadedFor!==room.id, hasEarlier: before !== null, loadEarlier: () => historyPage(true), loadingEarlier: historyBusy }}/> : <div className="m0-history-state">{selected && <button className="v11-text-button" onClick={back}>〈 返回会话列表</button>}<p role="status">{!selected ? '选择一个会话查看已保存记录' : historyError || (!room ? '正在查找会话；可返回列表加载更多' : '正在读取聊天记录…')}</p>{historyError && <button onClick={() => void historyPage()}>重试读取记录</button>}</div>}

    {live&&selected&&loadedFor===selected&&(pendingSend||!!turn&&turn.status!=='succeeded'||!!historyError)&&<div className="live-chat-status" role="status">{statusText}{pendingSend&&<button disabled={writeBusy||historyBusy||!online||(!pendingRequests.get(selected??'')?.content&&!pendingRequests.get(selected??'')?.batch&&!composer.draft.trim())} onClick={()=>void send()}>确认或重发同一请求</button>}{turn&&['failed','unknown'].includes(turn.status)&&<button disabled={writeBusy||!online||!settings.configured} onClick={()=>void retryReply()}>重试回复{turn.status==='unknown'?'（可能再次计费）':''}</button>}<button disabled={historyBusy||writeBusy||!online} onClick={()=>void historyPage()}>刷新状态</button></div>}
    {historyError && loadedFor === room?.id && !details && <p role="alert" className="m0-history-error">{historyError}</p>}

    {live&&room&&memoryOpen&&<Suspense fallback={<p role="status">正在打开记忆…</p>}><MemoryPanel key={room.id} conversationId={room.id} participants={settings.participants??[]} onClose={()=>setMemoryOpen(false)}/></Suspense>}
    {live&&room&&!conversation?.profile&&<div className="live-chat-status" role="status">历史会话沿用原聊天配置；成员归属未标注，不影响继续聊天。<button disabled={!settings.conversationProfilesEnabled||writeBusy||unresolved} onClick={()=>{setConfiguring(room.id);setCreating(true);}}>设置会话成员</button></div>}
{roomMenu&&<div className="v11-overlay"><section className="v11-modal" aria-label="会话操作"><h3>会话操作</h3>{!uiReady&&<p>置顶与删除需要先启用正式 UI 数据扩展。</p>}<button disabled={!uiReady||writeBusy} onClick={async()=>{setWriteBusy(true);try{await api('/api/ui/conversations/'+roomMenu,{method:'PUT',body:JSON.stringify({pinned:!pinned[roomMenu]})});setPinned(old=>({...old,[roomMenu]:!old[roomMenu]}));setRoomMenu(null);await loadRooms();}catch(e){setNotice(writeError(e));}finally{setWriteBusy(false);}}}>{pinned[roomMenu]?'取消置顶':'置顶会话'}</button><button className="v11-danger" disabled={!uiReady||writeBusy} onClick={async()=>{if(!confirm('删除会话并停用其记忆来源？原始消息保留，可从设置中的会话回收站恢复。'))return;setWriteBusy(true);try{await api('/api/ui/conversations/'+roomMenu,{method:'DELETE'});cache.current.delete(roomMenu);setRooms(old=>old.filter(r=>r.id!==roomMenu));if(selected===roomMenu)navigate(route);setRoomMenu(null);}catch(e){setNotice(writeError(e));}finally{setWriteBusy(false);}}}>删除会话</button><button onClick={()=>setRoomMenu(null)}>取消</button></section></div>}

    {versions&&<section className="v11-panel" aria-label="消息版本记录"><header className="v11-panel-head"><button onClick={()=>setVersions(null)}>〈 返回</button><strong>消息版本</strong><span/></header><div className="v11-panel-body"><p>切换只更新这条消息，不自动重新生成后续回复；原始版本保留。</p>{versions.items.map(v=><article key={v.revision}><small>版本 {v.revision}{v.revision===versions.currentRevision?' · 当前有效':''}</small><p style={{whiteSpace:'pre-wrap'}}>{v.content}</p><button disabled={operationsBusy||v.revision===versions.currentRevision} onClick={()=>void selectVersion(v.revision)}>使用此版本</button></article>)}</div></section>}
    {details&&room&&!creating&&<Suspense fallback={<p role="status">正在加载会话详情…</p>}><ConversationDetailsFrame kind={room.kind} onBack={back}>
      <h3>{room.kind==='group'?'群聊信息':'私聊信息'}</h3><div className="v11-setting"><span>{room.kind==='group'?'群名称':'私聊名称'}<small>{room.name}</small></span><button aria-label="刷新聊天记录" disabled={historyBusy||writeBusy} onClick={()=>void historyPage()}>刷新记录</button></div>
      <h3>{room.kind==='group'?'群成员与配置':'私聊 AI'}</h3>{room.members.map(id=><div className="v11-setting" key={id}><span>{room.remarks[id]}<small>角色人格未配置</small></span><span>{id}</span></div>)}{!room.members.length&&<p>成员尚未设置，历史回复归属保持未标注。</p>}
      <div className="v11-setting"><span>当前模型<small>{live?'成员使用现有共用模型服务':'模型未启用'}</small></span><span>{live?(settings.model||'未配置'):'未启用'}</span></div>
      {room.kind==='group'&&<><div className="v11-setting"><span>成员管理</span><button disabled={!settings.operationsEnabled||writeBusy||unresolved} onClick={()=>setGroupMembers([...room.members])}>{settings.operationsEnabled?'添加成员':'待正式操作扩展启用'}</button></div><div className="v11-setting"><span>群内自主发言</span><button disabled title="当前仅用户指定成员的单次回复">未接通</button></div></>}
      {groupMembers&&room.kind==='group'&&<section><p>新成员可以查看本群完整有效历史，不会获得其他私聊或其他群的权限。既有记忆撤权不会自动重置；本批只支持添加，不移除有历史记录的成员。</p>{(settings.participants??[]).map(p=><label className="v11-member-choice" key={p.id}>{p.name}<input type="checkbox" disabled={room.members.includes(p.id)} checked={groupMembers.includes(p.id)} onChange={e=>setGroupMembers(old=>e.target.checked?[...(old??[]),p.id]:(old??[]).filter(id=>id!==p.id))}/></label>)}<button disabled={writeBusy||!groupMembers.length} onClick={async()=>{setWriteBusy(true);try{const updated=await api<ChatConversation>(base+'/conversations/'+room.id+'/members',{method:'PUT',body:JSON.stringify({expectedMembers:room.members,members:groupMembers})});setRooms(old=>old.map(c=>c.id===room.id?updated:c));setGroupMembers(null);setRefreshToken(n=>n+1);}catch(e){setNotice(writeError(e));}finally{setWriteBusy(false);}}}>保存成员</button><button onClick={()=>setGroupMembers(null)}>取消</button></section>}
      <div className="memory-actions"><button onClick={()=>{navigate(route+'?conversation='+encodeURIComponent(room.id));setMemoryOpen(true);}}>长期记忆 · 查看、纠正与事件脉络</button></div><h3>聊天内容</h3>{historyError&&<p className="m0-history-error" role="alert">{historyError}</p>}<p>创建时间：{new Date(conversation!.createdAt).toLocaleString()}</p>{['修改备注','搜索全部历史','图片与文件','默认音色','编辑与重生成'].map(label=><div className="v11-setting" key={label}><span>{label}</span><button disabled>未开放</button></div>)}
      <p className="v11-disclaimer">{live?'消息来自真实聊天服务。成员选择与回复归属已保存；长期记忆按授权使用；独立人格、多 AI 自主调度尚未接通。':'独立只读测试，不写入、不调用模型。'}</p>
    </ConversationDetailsFrame></Suspense>}

   </div>{notice && <div role="status" className="v11-toast">{notice}</div>}
  </section>{!embedded&&<nav className="m0-main-nav" aria-label="主导航"><button disabled title="Home尚未开放">Home</button><button aria-current="page" onClick={() => { setDrawer(false); navigate(route); }}>Chat</button><button disabled title="World尚未开放">World</button></nav>}</div>
 </div>;
}
