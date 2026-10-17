import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HttpSyncTransport,TransportError} from '../../local-agent/src/transport.js';

function transport(response:()=>Response){return new HttpSyncTransport('http://127.0.0.1:3100','synthetic',async()=>response());}
const request={archive:{archiveId:'synthetic-archive',restoreGeneration:'synthetic-generation'},lastArchived:null};
test('409 retries only an explicit RESUME_REQUIRED response; permanent or unknown conflicts stop',async()=>{
 for(const [body,retryable] of [[{error:'RESUME_REQUIRED'},true],[{error:'EVENT_GAP'},false],[{error:'ARCHIVE_RECONCILIATION_REQUIRED'},false],[{error:'ACK_NOT_DELIVERED_OR_INVALID'},false],[{},false]] as const){
  await assert.rejects(transport(()=>Response.json(body,{status:409})).resume(request),(e:unknown)=>e instanceof TransportError&&e.code==='SYNC_HTTP_409'&&e.retryable===retryable);
 }
});
test('malformed and oversized 409 bodies fail closed without logging or retrying their contents',async()=>{
 for(const body of ['not-json','null','x'.repeat(20000)]){
  await assert.rejects(transport(()=>new Response(body,{status:409})).resume(request),(e:unknown)=>e instanceof TransportError&&e.code==='SYNC_HTTP_409'&&!e.retryable&&!e.message.includes(body));
 }
});
test('ordinary transient server failures retry while authentication failures stop',async()=>{
 for(const [status,retryable] of [[429,true],[503,true],[401,false],[403,false]] as const){
  await assert.rejects(transport(()=>new Response('',{status})).resume(request),(e:unknown)=>e instanceof TransportError&&e.retryable===retryable);
 }
});

test('non-object successful responses are permanent protocol errors rather than endless network retries',async()=>{
 for(const body of ['null','[]','false','"invalid"']){
  await assert.rejects(transport(()=>new Response(body,{status:200})).resume(request),(e:unknown)=>e instanceof TransportError&&e.code==='SYNC_RESPONSE_INVALID'&&!e.retryable);
 }
});
