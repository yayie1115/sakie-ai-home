import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
export function AuthenticationGate({children}:{children:ReactNode}){
  const [status,setStatus]=useState<'loading'|'login'|'ready'|'error'>('loading');const[password,setPassword]=useState('');const[csrfToken,setCsrfToken]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'}).then(async response=>{
    if(!active)return;if(response.ok){const body=await response.json();if(active){setCsrfToken(body.csrfToken);setStatus('ready');}}
    else setStatus(response.status===401?'login':'error');
  }).catch(()=>{if(active)setStatus('error');});return()=>{active=false;};},[]);
  async function login(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{
    const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
    if(!response.ok){setError(response.status===503?'身份配置尚未完成，请联系管理员。':response.status===429?'尝试过于频繁，请稍后再试。':'登录失败，请检查密码。');return;}
    const body=await response.json();setCsrfToken(body.csrfToken);setPassword('');setStatus('ready');
  }catch{setError('连接失败，请稍后重试。');}finally{setBusy(false);}}
  async function logout(){setBusy(true);try{const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrfToken}});if(response.ok||response.status===401){setCsrfToken('');setStatus('login');}else setError('退出失败，请重试。');}catch{setError('连接失败，请重试。');}finally{setBusy(false);}}
  if(status==='loading')return <p>正在检查登录状态…</p>;
  if(status==='error')return <p role="alert">无法连接服务，请刷新重试。</p>;
  if(status==='login')return <main><h1>sakie-ai-home</h1><form onSubmit={login}><label htmlFor="owner-password">访问密码</label><input id="owner-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required maxLength={256}/><button disabled={busy} type="submit">登录</button></form>{error&&<p role="alert">{error}</p>}</main>;
  return <><button disabled={busy} onClick={logout}>退出登录</button>{error&&<p role="alert">{error}</p>}{children}</>;
}
