import type {ReactNode} from 'react';
export function ConversationDetailsFrame({kind,onBack,children}:{kind:'private'|'group';onBack:()=>void;children:ReactNode}){
 return <section className="v11-panel" aria-label={kind==='group'?'群聊详情页':'聊天详情页'}><header className="v11-panel-head"><button onClick={onBack}>〈 返回聊天</button><strong>{kind==='group'?'群聊详情':'聊天详情'}</strong><span/></header><div className="v11-panel-body">{children}</div></section>;
}
