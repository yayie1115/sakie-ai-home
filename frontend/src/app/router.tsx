import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './Layout';
import { modules } from '../modules';
import { MobileChatPreview } from '../modules/chat/MobileChatPreview';
const SingleTimelineChat=lazy(()=>import('../modules/chat/SingleTimelineChat').then(m=>({default:m.SingleTimelineChat})));
const GroupChatPreview=lazy(()=>import('../modules/chat/GroupChatPreview').then(m=>({default:m.GroupChatPreview})));

export function AppRouter() {
  return <Suspense fallback={<p role="status">正在加载页面…</p>}><Routes><Route path="/" element={<Navigate to="/chat" replace />} /><Route path="chat" element={<MobileChatPreview live />} /><Route path="m0/chat" element={<MobileChatPreview />} /><Route element={<Layout />}>
    <Route path="demo/chat" element={<SingleTimelineChat />} />
    <Route path="demo/chat-group" element={<GroupChatPreview />} />
    {modules.filter(module => module.name !== 'chat').map(({ name, label }) => <Route key={name} path={name} element={<><h2>{label}</h2><p>模块预留，尚未开发。</p></>} />)}
    <Route path="*" element={<h2>404：页面不存在</h2>} />
  </Route></Routes></Suspense>;
}
