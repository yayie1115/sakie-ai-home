/** v11 view types and isolated workspace helpers; durable Chat records remain in the API. */
export type Quote = { unavailable?:boolean; id: string; author: string; text: string; source?: { conversationId: string; messageId: string; revision: number; bubbleId?: string } };
export type Message = { messageSeq?:number;versionNavigation?:import('@sakie/contracts').ChatVersionNavigation; usage?: {cacheRateApplicable?:boolean;inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null}; delivery?:'sending'|'streaming'; versionIds?:string[]; id: string; turnId: string; author: string; versions: string[]; version: number; time: number; quote?: Quote; pending?: boolean; sourceRef?: {messageId:string;revision:number} };
export type Room = { id: string; kind: 'private' | 'group'; name: string; members: string[]; remarks: Record<string,string>; activity: number; pinned: boolean; deletedAt?: number; rules: { mixed: boolean; mentions: boolean; limited: boolean } };
export type Composer = { draft: string; quote?: Quote; pending: Message[]; scroll: number };
export type Workspace = { schema: 1; rooms: Room[]; messages: Record<string,Message[]>; composers: Record<string,Composer> };
export const roles = [{id:'yan',name:'谢亦言',badge:'言'}, {id:'mu',name:'慕遥',badge:'遥'}, {id:'xing',name:'迟星',badge:'星'}, {id:'lan',name:'岚序',badge:'岚'}];
export const emptyComposer = ():Composer => ({draft:'',pending:[],scroll:0});
const room = (id:string, kind:Room['kind'], name:string, members:string[], activity:number):Room => ({id,kind,name,members,remarks:{},activity,pinned:false,rules:{mixed:true,mentions:true,limited:true}});
export function initialWorkspace(now = Date.now()):Workspace {
  const messages:Workspace['messages']={};
  const make=(id:string,author:string,text:string,index:number):Message=>({id,turnId:id,author,versions:[text],version:0,time:now-60_000*(12-index)});
  messages.privateYan=[make('intro','yan','你回来啦。今天想先做什么？',0),make('hello','me','想把我们的聊天空间慢慢做好。',1),make('agree','yan','好，我们就从这里开始。',2)];
  messages.home=[make('groupIntro','mu','早安，今天大家都在吗？',3),make('groupReply','yan','在。慢慢说，不用急。',4)];
  return {schema:1,rooms:[room('privateYan','private','谢亦言',['yan'],now-60_000),room('home','group','小家群聊',['yan','mu'],now)],messages,composers:{}};
}
export const textOf=(message:Message)=>message.versions[message.version];
export const titleOf=(r:Room,id:string)=>id==='me'?'我':id==='unattributed'?'AI（历史归属未标注）':r.remarks[id]??roles.find(a=>a.id===id)?.name??'AI';
export const sortedRooms=(state:Workspace,query='')=>state.rooms.filter(r=>r.deletedAt===undefined&&r.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.activity-a.activity||a.id.localeCompare(b.id));
export function compose(state:Workspace,id:string,patch:Partial<Composer>):Workspace {
  return {...state,composers:{...state.composers,[id]:{...(state.composers[id]??emptyComposer()),...patch}}};
}
export function stage(state:Workspace,id:string,messageId:string,now:number):Workspace {
  const c=state.composers[id]??emptyComposer(); if(!c.draft.trim())return state;
  const m:Message={id:messageId,turnId:messageId,author:'me',versions:[c.draft.trim()],version:0,time:now,pending:true,...(c.quote?{quote:c.quote}:{})};
  return compose(state,id,{draft:'',quote:undefined,pending:[...c.pending,m]});
}
export function submit(state:Workspace,id:string,now:number):Workspace {
  const c=state.composers[id]??emptyComposer(); if(!c.pending.length||c.draft.trim())return state;
  const turnId=c.pending[0].id;
  return {...compose(state,id,{draft:'',quote:undefined,pending:[]}),rooms:state.rooms.map(r=>r.id===id?{...r,activity:now}:r),
    messages:{...state.messages,[id]:[...(state.messages[id]??[]),...c.pending.map(m=>({...m,pending:false,time:now,turnId}))]}};
}
export function createRoom(state:Workspace,kind:Room['kind'],members:string[],id:string,now:number):{state:Workspace;id:string} {
  const picked=[...new Set(members)].filter(m=>roles.some(r=>r.id===m));
  if(!picked.length||(kind==='private'&&picked.length!==1))throw Error('请选择 AI');
  const existing=kind==='private'?state.rooms.find(r=>r.kind==='private'&&r.members[0]===picked[0]&&r.deletedAt===undefined):undefined;
  if(existing)return {state,id:existing.id};
  const name=kind==='private'?roles.find(r=>r.id===picked[0])!.name:'新群聊';
  return {state:{...state,rooms:[...state.rooms,room(id,kind,name,picked,now)],messages:{...state.messages,[id]:[]}},id};
}
export function changeRoom(state:Workspace,id:string,patch:Partial<Room>):Workspace {return {...state,rooms:state.rooms.map(r=>r.id===id?{...r,...patch}:r)};}
export function reviseMessage(state:Workspace,roomId:string,id:string,text:string):Workspace {
  return {...state,messages:{...state.messages,[roomId]:(state.messages[roomId]??[]).map(m=>m.id===id?{...m,versions:[...m.versions,text],version:m.versions.length}:m)}};
}
export function searchMessages(state:Workspace,id:string,query:string,date:string):Message[] {
  return (state.messages[id]??[]).filter(m=>textOf(m).toLocaleLowerCase().includes(query.toLocaleLowerCase())&&(!date||localDate(m.time)===date));
}
export function localDate(time:number){const d=new Date(time);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
export function restoreRoom(state:Workspace,id:string,now:number):Workspace {
  const r=state.rooms.find(r=>r.id===id); if(r?.deletedAt===undefined||now-r.deletedAt>=30*86400_000)return state;
  return changeRoom(state,id,{deletedAt:undefined});
}
