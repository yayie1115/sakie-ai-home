import {authorizeOrigin,cloudUrl,defaultTestPolicy,type RuntimeNetworkPolicy} from './network-policy.js';
export {cloudUrl} from './network-policy.js';
import type {SyncTransport,SyncResumeRequest,SyncResumeResponse,SyncBatch,SyncProofCursor} from '@sakie/contracts';
export class TransportError extends Error {constructor(readonly code:string,readonly retryable:boolean=true){super(code);}}
export class HttpSyncTransport implements SyncTransport {
 private origin:string;
 constructor(origin:string,private token:string,private transport:typeof fetch=fetch,private timeoutMs=15000,private policy:RuntimeNetworkPolicy=defaultTestPolicy){this.origin=authorizeOrigin(origin,policy);}
 async request<T>(path:string,body:unknown):Promise<T>{
  authorizeOrigin(this.origin,this.policy);
  try{
   const response=await this.transport(this.origin+'/api/sync/'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!response.ok){
    const retryable=response.status===409?await isResumeConflict(response):response.status===429||response.status>=500;
    if(response.status!==409)await response.body?.cancel();
    throw new TransportError('SYNC_HTTP_'+response.status,retryable);
   }
   const reader=response.body?.getReader();if(!reader)throw new TransportError('SYNC_RESPONSE_INVALID',false);
   const chunks:Uint8Array[]=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4*1024*1024){await reader.cancel();throw new TransportError('SYNC_RESPONSE_TOO_LARGE',false);}chunks.push(part.value);}}finally{reader.releaseLock();}
   try{const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body===null||typeof body!=='object'||Array.isArray(body))throw new Error();return body as T;}catch{throw new TransportError('SYNC_RESPONSE_INVALID',false);}
  }catch(error){if(error instanceof TransportError)throw error;throw new TransportError('SYNC_NETWORK_UNAVAILABLE');}
 }
 resume(request:SyncResumeRequest){return this.request<SyncResumeResponse>('resume',request);}
 pull(afterSeq:number,limit:number){return this.request<SyncBatch>('pull',{afterSeq,limit});}
 acknowledge(cursor:SyncProofCursor){return this.request<{ackSeq:number}>('ack',cursor);}
}
/** Only stale-page races can resolve by resuming. Corrupt streams and bad ACKs need review. */
async function isResumeConflict(response:Response):Promise<boolean>{
 const reader=response.body?.getReader();if(!reader)return false;
 const chunks:Uint8Array[]=[];let bytes=0;
 try{
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
   if(bytes>16*1024){await reader.cancel();return false;}chunks.push(part.value);
  }
  const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return body!==null&&typeof body==='object'&&!Array.isArray(body)&&(body as {error?:unknown}).error==='RESUME_REQUIRED';
 }catch{return false;}finally{reader.releaseLock();}
}
