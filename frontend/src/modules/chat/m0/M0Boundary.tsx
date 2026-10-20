import { createContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AuthenticationGate } from '../../../app/AuthenticationGate';
import './mobile-chat.css';
export const M0EnvironmentContext = createContext({ fixture: false });
export function M0Boundary({ children, live = false }: {
    live?: boolean;
    children: ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    const [fixture, setFixture] = useState(false);
    const [status, setStatus] = useState<'checking' | 'ready' | 'blocked'>('checking');
    useEffect(() => {
        document.body.classList.add('m0-page');
        let frame = 0;
        let baseline = window.innerHeight, width = window.innerWidth;
        const measure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { const viewport = window.visualViewport, h = viewport?.height ?? window.innerHeight, w = viewport?.width ?? window.innerWidth; if (Math.abs(w - width) > 80) {
            baseline = h;
            width = w;
        }
        else
            baseline = Math.max(baseline, h); const editable = document.activeElement?.matches('textarea,input:not([type=checkbox])') ?? false; const keyboard = editable && baseline - h > 120; root.current?.style.setProperty('--m0-height', h + 'px'); root.current?.style.setProperty('--m0-offset', (viewport?.offsetTop ?? 0) + 'px'); if (root.current)
            root.current.dataset.keyboard = String(keyboard); }); };
        measure();
        window.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        document.addEventListener('focusin', measure);
        document.addEventListener('focusout', measure);
        return () => { cancelAnimationFrame(frame); document.body.classList.remove('m0-page'); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure); document.removeEventListener('focusin', measure); document.removeEventListener('focusout', measure); };
    }, []);
    useEffect(() => {
        if (live) { setStatus('ready'); return; }
        let active = true;
        const controller = new AbortController();
        // A regular Vite/production page must not probe owner/session or business APIs.
        if (!document.querySelector('meta[name="sakie-m0-environment"][content="isolated-readonly"]')) {
            setStatus('blocked');
            return;
        }
        fetch('/api/m0/capabilities', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async (response) => { if (!response.ok)
            throw Error('No isolated capability'); const c = await response.json(); if (c.environment !== 'm0-isolated-readonly' || c.modelCallsEnabled !== false || c.writeEnabled !== false || c.protocol !== 'chat-v4-readonly')
            throw Error('Wrong environment'); if (active) {
            setFixture(c.fixtureData === true);
            setStatus('ready');
        } }).catch(() => { if (active)
            setStatus('blocked'); });
        return () => { active = false; controller.abort(); };
    }, [live]);
    return <div ref={root} className="m0-root">{status === 'ready' ? <M0EnvironmentContext.Provider value={{ fixture }}><AuthenticationGate presentation={live ? "chat" : "m0"}>{children}</AuthenticationGate></M0EnvironmentContext.Provider> : <main className="m0-login" role={status === 'blocked' ? 'alert' : 'status'}><p>{status === 'blocked' ? '未连接独立 M0 只读测试服务，已停止；不会请求登录或聊天数据。' : '正在核对独立测试环境…'}</p></main>}</div>;
}
