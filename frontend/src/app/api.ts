import { createContext, useContext } from 'react';
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) {super(code);} }
export type AuthenticatedApi = <T>(path: string, init?: RequestInit & {timeoutMs?:number}) => Promise<T>;
export const AuthenticatedApiContext = createContext<AuthenticatedApi | null>(null);
export function useApi() { const api=useContext(AuthenticatedApiContext); if(!api) throw new Error('Authentication required'); return api; }

export interface SessionActions {logout:()=>Promise<void>;busy:boolean;}
export const SessionActionsContext=createContext<SessionActions|null>(null);
export function useSessionActions(){const actions=useContext(SessionActionsContext);if(!actions)throw Error('Authentication required');return actions;}

/** Deadlines include reading the response body. Never automatically replay a mutation. */
export async function fetchJson(path:string, init:RequestInit & {timeoutMs?:number} = {}) {
  const {timeoutMs=15000, signal, ...options}=init;
  const controller=new AbortController(), abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(path,{...options,signal:controller.signal,credentials:'same-origin',cache:'no-store'});
    const body=response.status===204?null:await response.json().catch(()=>({error:'INVALID_RESPONSE'}));
    if(controller.signal.aborted)throw new DOMException('Request aborted','AbortError');
    if(response.ok&&body?.error==='INVALID_RESPONSE')throw new ApiError(502,'INVALID_RESPONSE');
    return {response,body};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
