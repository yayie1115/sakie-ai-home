import { Route, Routes } from 'react-router';
import { Layout } from './Layout';
import { modules } from '../modules';
import { ChatPage } from '../modules/chat/ChatPage';
import { MobileChatPreview } from '../modules/chat/MobileChatPreview';
import { SingleTimelineChat } from '../modules/chat/SingleTimelineChat';
import { GroupChatPreview } from '../modules/chat/GroupChatPreview';

export function AppRouter() {
  return <Routes><Route path="m0/chat" element={<MobileChatPreview />} /><Route element={<Layout />}>
    <Route index element={<><h2>个人 AI 系统</h2><p>基础工程已就绪，各模块尚未实现。</p></>} />
    <Route path="chat" element={<ChatPage />} />
    <Route path="demo/chat" element={<SingleTimelineChat />} />
    <Route path="demo/chat-group" element={<GroupChatPreview />} />
    {modules.filter(module => module.name !== 'chat').map(({ name, label }) => <Route key={name} path={name} element={<><h2>{label}</h2><p>模块预留，尚未开发。</p></>} />)}
    <Route path="*" element={<h2>404：页面不存在</h2>} />
  </Route></Routes>;
}
