import { fetchJson, ApiError, AuthenticatedApiContext, SessionActionsContext, type AuthenticatedApi } from './api';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
export function AuthenticationGate({children,presentation='default'}:{children:ReactNode;presentation?:'default'|'m0'|'chat'}){
  const [status,setStatus]=useState<'loading'|'login'|'ready'|'error'>('loading');const[password,setPassword]=useState('');const[csrfToken,setCsrfToken]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;const controller=new AbortController();fetchJson('/api/auth/session',{signal:controller.signal}).then(({response,body})=>{
    if(!active)return;if(response.ok){if(active){setCsrfToken(body.csrfToken);setStatus('ready');}}
    else setStatus(response.status===401?'login':'error');
  }).catch(()=>{if(active)setStatus('error');});return()=>{active=false;controller.abort();};},[]);
  async function login(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{
    const {response,body}=await fetchJson('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    if(!response.ok){setError(response.status===503?'身份配置尚未完成，请联系管理员。':response.status===429?'尝试过于频繁，请稍后再试。':'登录失败，请检查密码。');return;}
    setCsrfToken(body.csrfToken);setPassword('');setStatus('ready');
  }catch{setError('连接失败，请稍后重试。');}finally{setBusy(false);}}
  async function logout(){setBusy(true);try{const {response}=await fetchJson('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrfToken}});if(response.ok||response.status===401){try{sessionStorage.removeItem('sakie-chat-pending-receipts');}catch{}setCsrfToken('');setStatus('login');}else setError('退出失败，请重试。');}catch{setError('连接失败，请重试。');}finally{setBusy(false);}}
  const api:AuthenticatedApi=useCallback(async <T,>(path:string,init:RequestInit & {timeoutMs?:number}={})=>{
    const headers=new Headers(init.headers);
    if(init.body)headers.set('Content-Type','application/json');
    if(!['GET','HEAD'].includes(init.method??'GET'))headers.set('X-CSRF-Token',csrfToken);
    const {response,body}=await fetchJson(path,{...init,headers});
    if(response.status===401){try{sessionStorage.removeItem('sakie-chat-pending-receipts');}catch{}setCsrfToken('');setStatus('login');}
    if(!response.ok)throw new ApiError(response.status,body.error??'REQUEST_FAILED');
    return body as T;
  },[csrfToken]);
  if(status==='loading')return <p role="status" className={presentation!=='default'?'m0-auth-status':undefined}>正在检查登录状态…</p>;
  if(status==='error')return <p role="alert">无法连接服务，请刷新重试。</p>;
  if(status==='login')return <main className={presentation!=='default'?'m0-login':undefined}><h1>{presentation!=='default'?'小家':'sakie-ai-home'}</h1>{presentation==='m0'&&<p>独立只读测试 · M0-2</p>}<form onSubmit={login}><label htmlFor="owner-password">访问密码</label><input id="owner-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required maxLength={256}/><button disabled={busy} type="submit">登录</button></form>{error&&<p role="alert">{error}</p>}</main>;
  return <SessionActionsContext.Provider value={{logout,busy}}>{presentation==='default'&&<button disabled={busy} onClick={logout}>退出登录</button>}{error&&<p role="alert">{error}</p>}<AuthenticatedApiContext.Provider value={api}>{children}</AuthenticatedApiContext.Provider></SessionActionsContext.Provider>;
}
