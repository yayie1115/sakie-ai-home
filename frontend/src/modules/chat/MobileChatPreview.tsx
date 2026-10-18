import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ChatConversation, ChatConversationPage, ChatHistoryPage, ChatMessage } from '@sakie/contracts';
import { ApiError, useApi, useSessionActions } from '../../app/api';
import { ConversationRow } from './v11/ConversationRow';
import { Timeline } from './v11/Timeline';
import { emptyComposer, type Composer, type Message, type Room } from './v11/state';
import { M0EnvironmentContext } from './m0/M0Boundary';
import './group-chat-preview.css';
import './m0/mobile-chat.css';
const base = '/api/chat';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const describe = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status) ? '没有访问权限，请重新登录。' : '记录暂时无法加载，请检查连接后重试。';
function roomOf(c: ChatConversation): Room { return { id: c.id, kind: 'private', name: c.title, members: ['yan'], remarks: {}, activity: Date.parse(c.createdAt), pinned: false, rules: { mixed: false, mentions: false, limited: true } }; }
export function MobileChatPreview() {
    const api = useApi(), session = useSessionActions(), environment = useContext(M0EnvironmentContext);
    const navigate = useNavigate(), location = useLocation();
    const [params] = useSearchParams();
    const selected = params.get('conversation'), details = params.get('view') === 'details';
    const [rooms, setRooms] = useState<ChatConversation[]>([]), [next, setNext] = useState<number | null>(null), [listLoading, setListLoading] = useState(true), [listError, setListError] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([]), [loadedFor, setLoadedFor] = useState<string | null>(null), [before, setBefore] = useState<number | null>(null), [historyError, setHistoryError] = useState(''), [historyBusy, setHistoryBusy] = useState(false);
    const [query, setQuery] = useState(''), [notice, setNotice] = useState(''), [drawer, setDrawer] = useState(false), [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [composers, setComposers] = useState<Record<string, Composer>>({}), [scrolled, setScrolled] = useState<Record<string, boolean>>({});
    const cache = useRef(new Map<string, {
        items: ChatMessage[];
        before: number | null;
    }>());
    const generation = useRef(0), selectedRef = useRef(selected);
    selectedRef.current = selected;
    const listScroll = useRef<HTMLDivElement>(null), listTop = useRef(0), navigation = useRef<HTMLButtonElement>(null);
    function restoreNavigationFocus() { requestAnimationFrame(() => { const button = selected ? document.querySelector<HTMLButtonElement>('.v11-chat-head [aria-label="打开主导航"]') : navigation.current; button?.focus(); }); }
    const loadRooms = useCallback(async (beforeCursor?: number) => { setListLoading(true); setListError(''); try {
        const config = await api<{
            configured: boolean;
        }>(base + '/config');
        if (config.configured !== false)
            throw Error('M0 model boundary mismatch');
        const page = await api<ChatConversationPage>(base + '/conversations?limit=50' + (beforeCursor ? '&before=' + beforeCursor : ''));
        setRooms(old => beforeCursor ? [...old, ...page.items.filter(c => !old.some(r => r.id === c.id))] : page.items);
        setNext(page.nextBefore);
    }
    catch (e) {
        setListError(describe(e));
    }
    finally {
        setListLoading(false);
    } }, [api]);
    useEffect(() => { void loadRooms(); }, [loadRooms]);
    useEffect(() => {
        const serial = ++generation.current, controller = new AbortController();
        setLoadedFor(null);
        setMessages([]);
        setBefore(null);
        setHistoryError('');
        setHistoryBusy(false);
        if (!selected)
            return;
        if (!uuid.test(selected)) {
            setHistoryError('会话编号无效；未读取数据。');
            return;
        }
        api<ChatHistoryPage>(base + '/conversations/' + selected + '/messages', { signal: controller.signal }).then(page => { if (generation.current === serial) {
            const saved = cache.current.get(selected), earliest = page.items[0]?.messageSeq ?? Infinity, retained = page.items.length ? (saved?.items.filter(m => m.messageSeq < earliest) ?? []) : [];
            const items = [...retained, ...page.items];
            const cursor = retained.length ? saved!.before : page.nextBefore;
            cache.current.set(selected, { items, before: cursor });
            setMessages(items);
            setBefore(cursor);
            setLoadedFor(selected);
        } }).catch(e => { if (!controller.signal.aborted && generation.current === serial)
            setHistoryError(describe(e)); });
        return () => controller.abort();
    }, [api, selected]);
    useEffect(() => { if (!selected && listScroll.current)
        listScroll.current.scrollTop = listTop.current; }, [selected]);
    useEffect(() => { if (!drawer)
        return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') {
        setDrawer(false);
        restoreNavigationFocus();
    } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [drawer, selected]);
    async function historyPage(older = false) {
        if (!selected || historyBusy || older && before === null)
            return;
        const id = selected, serial = generation.current;
        setHistoryBusy(true);
        setHistoryError('');
        try {
            const page = await api<ChatHistoryPage>(base + '/conversations/' + id + '/messages' + (older ? '?before=' + before : ''));
            if (serial !== generation.current || selectedRef.current !== id)
                return;
            const saved = cache.current.get(id);
            const old = saved?.items ?? messages, earliest = page.items[0]?.messageSeq ?? Infinity, retained = older ? old : page.items.length ? old.filter(m => m.messageSeq < earliest) : [];
            const items = [...new Map([...retained, ...page.items].map(m => [m.id, m])).values()].sort((a, b) => a.messageSeq - b.messageSeq), cursor = older || loadedFor !== id ? page.nextBefore : before;
            cache.current.set(id, { items, before: cursor });
            setMessages(items);
            setBefore(cursor);
            setLoadedFor(id);
        }
        catch (e) {
            if (serial === generation.current) {
                if (e instanceof ApiError && [401, 403].includes(e.status)) {
                    cache.current.delete(id);
                    setMessages([]);
                    setLoadedFor(null);
                }
                setHistoryError(describe(e));
            }
        }
        finally {
            if (serial === generation.current)
                setHistoryBusy(false);
        }
    }
    function open(id: string) { listTop.current = listScroll.current?.scrollTop ?? 0; setNotice(''); setDrawer(false); navigate('/m0/chat?conversation=' + encodeURIComponent(id), { state: { m0FromList: true } }); }
    function back() { setDrawer(false); setNotice(''); if (details) {
        navigate('/m0/chat?conversation=' + encodeURIComponent(selected ?? ''), { replace: true, state: { m0FromList: true } });
        return;
    } if (location.state?.m0FromList)
        navigate(-1);
    else
        navigate('/m0/chat', { replace: true }); }
    const conversation = rooms.find(r => r.id === selected), room = conversation ? roomOf(conversation) : undefined;
    const display: Message[] = messages.map(m => ({ id: m.id, turnId: m.turnId, author: m.role === 'user' ? 'me' : 'yan', versions: [m.content], version: 0, time: Date.parse(m.createdAt), sourceRef: { messageId: m.id, revision: m.revision ?? 1 } }));
    async function copySource(m: Message) { if (!selected || selectedRef.current !== selected)
        throw Error('会话已切换'); const source = messages.find(row => row.id === m.id); if (!source)
        throw Error('来源已失效'); const page = await api<ChatHistoryPage>(base + '/conversations/' + selected + '/messages?limit=1&before=' + (source.messageSeq + 1)); const current = page.items.find(row => row.id === m.id); if (!current || (current.revision ?? 1) !== m.sourceRef?.revision)
        throw Error('来源已变更，请刷新后复制'); return current.content; }
    return <div className={'m0-shell ' + (dark ? 'dark' : '') + (drawer ? ' nav-open' : '')}>
  <aside className="m0-drawer" aria-label="主导航侧栏" aria-hidden={!drawer} inert={!drawer}><button onClick={() => { setDrawer(false); restoreNavigationFocus(); }} aria-label="关闭主导航">关闭 ‹</button><nav aria-label="侧栏导航"><button disabled title="尚未接通">Home · 未开放</button><button aria-current="page" onClick={() => { setDrawer(false); navigate('/m0/chat'); }}>Chat</button><button disabled title="尚未接通">World · 未开放</button></nav><button onClick={() => setDark(d => !d)}>{dark ? '浅色外观' : '深色外观'}</button><button disabled={session.busy} onClick={() => void session.logout()}>退出登录</button><small>独立测试 · 只读<br />模型调用关闭</small></aside>
  <div className="m0-content"><section className={'v11-workspace m0-workspace ' + (dark ? 'dark ' : '') + (selected ? 'show-chat' : 'show-list')} aria-label="小家 M0 独立测试聊天">
   <aside className="v11-sidebar" aria-label="会话列表"><header className="v11-side-head"><div><button ref={navigation} className="v11-icon" aria-label="打开主导航" aria-expanded={drawer} onClick={() => setDrawer(d => !d)}>☰</button><h2>Chat</h2><div><button className="v11-icon" disabled title="会话回收站尚未接通" aria-label="会话回收站未开放">♲</button><button className="v11-icon" disabled title="新建会话待后续授权" aria-label="新建会话未开放">＋</button></div></div><input aria-label="搜索会话" placeholder="搜索已加载会话" value={query} onChange={e => setQuery(e.target.value)}/></header>
    <div ref={listScroll} className="v11-room-list" onScroll={e => { if (e.currentTarget.clientHeight > 0)
        listTop.current = e.currentTarget.scrollTop; }}>{rooms.filter(c => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(c => <ConversationRow key={c.id} room={roomOf(c)} active={c.id === selected} preview="查看已保存记录" showActivity={false} onSelect={() => open(c.id)} onMenu={() => setNotice('会话修改尚未接通，不会更改记录')}/>)}
     {listLoading && <p role="status">正在读取会话…</p>}{listError && <p role="alert">{listError}<button onClick={() => void loadRooms()}>重试读取会话</button></p>}{!listLoading && !listError && !rooms.length && <p className="v11-empty">独立测试库暂无会话。新建与发送尚未开放，不会填充演示消息。</p>}{rooms.length > 0 && !rooms.some(c => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="v11-empty">没有匹配的已加载会话</p>}{next && <button className="v11-text-button" disabled={listLoading} onClick={() => void loadRooms(next)}>加载更多会话</button>}
    </div><footer>{environment.fixture ? '自动化测试夹具 · 合成记录' : 'M0-2 独立只读测试'}<button onClick={() => void loadRooms()} disabled={listLoading}>刷新列表</button></footer>
   </aside>
   <div className="v11-chat">{room && loadedFor === room.id ? <Timeline key={room.id} room={room} messages={display} composer={composers[room.id] ?? emptyComposer()} onCompose={patch => { setComposers(old => ({ ...old, [room.id]: { ...(old[room.id] ?? emptyComposer()), ...patch } })); if ('scroll' in patch)
        setScrolled(old => ({ ...old, [room.id]: true })); }} onStage={() => setNotice('暂存与发送尚未开放')} onSubmit={() => setNotice('发送尚未开放')} onPending={() => { }} onMessages={() => setNotice('消息修改尚未接通')} onBack={back} onDetails={() => navigate(location.pathname + location.search + '&view=details')} notice={setNotice} onJumped={() => { }} linked onRead={copySource} m0={{ modelLabel: '模型未启用', onNavigation: () => setDrawer(d => !d), initialLatest: !scrolled[room.id], hasEarlier: before !== null, loadEarlier: () => historyPage(true), loadingEarlier: historyBusy }}/> : <div className="m0-history-state">{selected && <button className="v11-text-button" onClick={back}>〈 返回会话列表</button>}<p role="status">{!selected ? '选择一个会话查看已保存记录' : historyError || (!room ? '正在查找会话；可返回列表加载更多' : '正在读取聊天记录…')}</p>{historyError && <button onClick={() => void historyPage()}>重试读取记录</button>}</div>}

    {historyError && loadedFor === room?.id && !details && <p role="alert" className="m0-history-error">{historyError}</p>}
    {details && room && <section className="v11-panel" aria-label="聊天详情页"><header className="v11-panel-head"><button onClick={back}>〈 返回聊天</button><strong>聊天详情</strong><span /></header><div className="v11-panel-body"><h3>{room.name}</h3><div className="v11-setting"><span>已保存记录</span><button disabled={historyBusy} onClick={() => void historyPage()} aria-label="刷新聊天记录">刷新记录</button></div>{historyError && <p role="alert" className="m0-history-error">{historyError}</p>}<div className="v11-setting"><span>当前模型<small>模型调用未启用；不使用虚构模型名</small></span><span>未启用</span></div><p>创建时间：{new Date(conversation!.createdAt).toLocaleString()}</p>{['修改备注', '搜索全部历史', '图片与文件', '默认音色', '编辑与重生成'].map(label => <div className="v11-setting" key={label}><span>{label}</span><button disabled title="M0-2尚未接通">未开放</button></div>)}<p className="v11-disclaimer">只读取独立测试库。长期记忆、真实模型、写入与同步未在此启用。</p></div></section>}
   </div>{notice && <div role="status" className="v11-toast">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
  </section><nav className="m0-main-nav" aria-label="主导航"><button disabled title="Home尚未开放">Home</button><button aria-current="page" onClick={() => { setDrawer(false); navigate('/m0/chat'); }}>Chat</button><button disabled title="World尚未开放">World</button></nav></div>
 </div>;
}
