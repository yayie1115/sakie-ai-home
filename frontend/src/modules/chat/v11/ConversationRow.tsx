import type { Room } from './state';
import { useLongPress } from './useLongPress';
export function ConversationRow({ room, active, preview, onSelect, onMenu, showActivity = true }: {
    room: Room;
    active: boolean;
    preview: string;
    onSelect: () => void;
    onMenu: () => void;
    showActivity?: boolean;
}) {
    const press = useLongPress(onMenu);
    return <button className={`v11-conversation ${active ? 'active' : ''}`} onClick={onSelect} {...press} aria-label={`打开${room.name}`} aria-current={active ? 'page' : undefined}>
   <span className={`v11-avatar ${room.kind === 'group' ? 'group' : ''}`}>{room.kind === 'group' ? '群' : room.name.slice(-1)}</span>
   <span className="v11-conversation-copy"><span><strong>{room.name}</strong>{showActivity && <time>{new Date(room.activity).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}</span><small>{room.pinned ? '置顶 · ' : ''}{preview || '尚无消息'}</small></span>
 </button>;
}
