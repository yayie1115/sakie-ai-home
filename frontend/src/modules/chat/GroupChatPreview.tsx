import { AuthenticationGate } from '../../app/AuthenticationGate';
import { ChatWorkspace } from './v11/ChatWorkspace';
import { LinkedChatDemo } from './v11/LinkedChatDemo';
/** Existing preview; lab mode needs server-injected marker BEFORE any owner/session request. */
export function GroupChatPreview(){
 const lab=new URLSearchParams(window.location.search).get('lab');
 if(lab!=='1'&&lab!=='data01')return <ChatWorkspace/>;
 if(!document.querySelector(lab==='data01'?'meta[name="sakie-data01-lab"][content="synthetic-only"]':'meta[name="sakie-v11-lab"][content="synthetic-only"]'))return <p role="alert">当前不是隔离联调页面，已停止；不会连接认证或聊天 API。请使用合成实验运行器给出的地址。</p>;
 return <AuthenticationGate><LinkedChatDemo data01={lab==='data01'}/></AuthenticationGate>;
}
