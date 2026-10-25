import {lazy,Suspense} from 'react';
import {Route,Routes} from 'react-router';
import {SiteShell} from './SiteShell';
import {MobileChatPreview} from '../modules/chat/MobileChatPreview';
const SingleTimelineChat=lazy(()=>import('../modules/chat/SingleTimelineChat').then(m=>({default:m.SingleTimelineChat})));
const GroupChatPreview=lazy(()=>import('../modules/chat/GroupChatPreview').then(m=>({default:m.GroupChatPreview})));
export function AppRouter(){return <Suspense fallback={<p role="status">正在加载页面…</p>}><Routes><Route path="m0/chat" element={<MobileChatPreview/>}/><Route path="demo/chat" element={<SingleTimelineChat/>}/><Route path="demo/chat-group" element={<GroupChatPreview/>}/><Route path="*" element={<SiteShell/>}/></Routes></Suspense>;}
