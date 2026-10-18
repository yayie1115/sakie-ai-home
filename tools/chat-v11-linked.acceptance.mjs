import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertSyntheticDatabase } from '../backend/dist/modules/chat/v11-lab/routes.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startV11Lab, labDirectory, labPassword } from './chat-v11-lab.mjs';
import { DefinitiveSubmissionRejection, V11SubmissionClient } from '../frontend/src/modules/chat/v11/submission.ts';
import { decodeSubmission } from '../backend/dist/modules/chat/v11-lab/codec.js';
import { wireEvent, streamId } from '../backend/dist/modules/sync/events.js';
import { reviseMessage } from '../backend/dist/modules/sync/mutations.js';
import { LocalArchive } from '../local-agent/src/archive.ts';
const root=resolve(import.meta.dirname,'..');
mkdirSync(join(root,'.phase1-work'),{recursive:true});
const bubble=content=>({id:randomUUID(),revision:1,content});
const submission=(lab,contents=['first bubble','second bubble'])=>({schemaVersion:1,submissionId:randomUUID(),conversationId:lab.conversationId,bubbles:contents.map(bubble)});
async function login(lab){const response=await fetch(lab.origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:labPassword})});assert.equal(response.status,200);const {csrfToken}=await response.json();const cookie=response.headers.get('set-cookie').split(';')[0];return (path,body,extra={})=>fetch(lab.origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrfToken,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const endpoint=lab=>'/api/lab/chat-v11/conversations/'+lab.conversationId+'/submit';
async function withLab(fn){const lab=await startV11Lab();try{await fn(lab,await login(lab));}finally{await lab.close();}}
const count=(lab,table)=>Number(lab.db.prepare('SELECT count(*) AS n FROM '+table).get().n);

test('v11 lab rejects production paths and existing ordinary database names',()=>{for(const value of ['cloud','../cloud','E:\\sakie-ai-home-data\\cloud','chat-demo-abc'])assert.throws(()=>labDirectory(value));});

test('lab router database guard refuses an ordinary freshly-created synthetic filename',()=>{
 const directory=mkdtempSync(join(root,'.phase1-work','v11-guard-'));const db=new DatabaseSync(join(directory,'ordinary-synthetic.db'));
 try{assert.throws(()=>assertSyntheticDatabase(db),/SYNTHETIC_DATABASE_REQUIRED/);}finally{db.close();}
});
test('v11 lab preserves owner login, CSRF, Origin and exact conversation boundary',async()=>withLab(async(lab,request)=>{
 assert.equal((await fetch(lab.origin+'/api/lab/chat-v11/capabilities')).status,401);
 const s=submission(lab);assert.equal((await request(endpoint(lab),s,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await request(endpoint(lab),s,{Origin:'https://untrusted.invalid'})).status,403);
 assert.equal((await request('/api/lab/chat-v11/conversations/'+randomUUID()+'/submit',s)).status,403);
 assert.equal(lab.calls,0);assert.equal(count(lab,'chat_turns'),0);
}));
test('one atomic batch makes one legacy turn, two messages/outbox events; history restores bubble IDs and order',async()=>withLab(async(lab,request)=>{
 const s=submission(lab);const response=await request(endpoint(lab),s);assert.equal(response.status,202);const receipt=await response.json();assert.equal(receipt.durable,true);assert.deepEqual(receipt.bubbleIds,s.bubbles.map(b=>b.id));await lab.chat.idle();
 assert.equal(lab.calls,1);assert.equal(count(lab,'chat_turns'),1);assert.equal(count(lab,'chat_messages'),2);assert.equal(count(lab,'chat_outbox'),2);assert.equal(count(lab,'chat_attempts'),1);
 const original=lab.db.prepare("SELECT content FROM chat_messages WHERE role='user'").get().content;assert.deepEqual(decodeSubmission(original),s);
 const history=await(await request('/api/lab/chat-v11/history')).json();assert.deepEqual(history.bubbles.slice(0,2).map(b=>[b.id,b.content,b.position]),s.bubbles.map((b,i)=>[b.id,b.content,i]));assert.equal(new Set(history.bubbles.slice(0,2).map(b=>b.turnId)).size,1);
 const archive=new LocalArchive(':memory:');try{archive.bindStream(streamId(lab.db));const events=lab.db.prepare('SELECT * FROM chat_outbox ORDER BY stream_seq').all().map(wireEvent);const cursor=await archive.commitBatch(events);assert.equal(cursor.contiguousSeq,2);assert.equal(archive.db.prepare("SELECT content FROM archive_messages WHERE role='user'").get().content,original);assert.deepEqual(decodeSubmission(original).bubbles,s.bubbles);assert.equal(count(lab,'chat_outbox'),2);}finally{archive.close();}
}));
test('duplicate concurrent final submits and replay after lost receipt do not call twice; changed order conflicts',async()=>withLab(async(lab,request)=>{
 const s=submission(lab);const replies=await Promise.all([request(endpoint(lab),s),request(endpoint(lab),s)]);assert.deepEqual(replies.map(r=>r.status),[202,202]);const results=await Promise.all(replies.map(r=>r.json()));assert.equal(results[0].turnId,results[1].turnId);await lab.chat.idle();assert.equal(lab.calls,1);
 const replay=await(await request(endpoint(lab),s)).json();assert.equal(replay.turnId,results[0].turnId);assert.equal(lab.calls,1);
 assert.equal((await request(endpoint(lab),{...s,bubbles:[...s.bubbles].reverse()})).status,409);assert.equal(count(lab,'chat_turns'),1);
 const different={...s,submissionId:randomUUID()};assert.equal((await request(endpoint(lab),different)).status,409);assert.equal(lab.calls,1);
}));

test('a bubble cannot reuse an existing legacy message UUID',async()=>withLab(async(lab,request)=>{
 const original=await(await request('/api/chat/conversations/'+lab.conversationId+'/messages',{clientMessageId:randomUUID(),content:'legacy'})).json();await lab.chat.idle();
 const s=submission(lab);s.bubbles[0].id=original.messageId;assert.equal((await request(endpoint(lab),s)).status,409);assert.equal(count(lab,'chat_turns'),1);assert.equal(lab.calls,1);
}));
test('invalid batch shapes, UUIDs, duplicate IDs, oversized content and empty submit produce no task',async()=>withLab(async(lab,request)=>{
 const s=submission(lab);for(const invalid of [{...s,bubbles:[]},{...s,extra:true},{...s,submissionId:'not-uuid'},{...s,bubbles:[s.bubbles[0],s.bubbles[0]]},{...s,bubbles:[bubble('x'.repeat(13000))]},{...s,bubbles:[{...s.bubbles[0],revision:0}]}])assert.equal((await request(endpoint(lab),invalid)).status,400);
 assert.equal(lab.calls,0);assert.equal(count(lab,'chat_turns'),0);assert.equal(count(lab,'chat_outbox'),0);
}));
test('outbox write failure rolls back the entire batch, sequence and turn; same submission can retry',async()=>withLab(async(lab,request)=>{
 lab.db.exec("CREATE TRIGGER lab_fail_outbox BEFORE INSERT ON chat_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const s=submission(lab);assert.equal((await request(endpoint(lab),s)).status,500);
 for(const table of ['chat_messages','chat_turns','chat_outbox','chat_attempts'])assert.equal(count(lab,table),0);assert.equal(lab.calls,0);
 assert.equal(lab.db.prepare('SELECT next_turn_seq FROM chat_conversations WHERE id=?').get(lab.conversationId).next_turn_seq,1);
 lab.db.exec('DROP TRIGGER lab_fail_outbox');assert.equal((await request(endpoint(lab),s)).status,202);await lab.chat.idle();assert.equal(lab.calls,1);
}));
test('quote source current revision and evidence are checked inside admission; cross-room and stale quotes fail',async()=>withLab(async(lab,request)=>{
 const original=submission(lab);const receipt=await(await request(endpoint(lab),original)).json();await lab.chat.idle();
 const quote={conversationId:lab.conversationId,messageId:receipt.messageId,revision:1,bubbleId:original.bubbles[0].id,selectedText:'first bubble'};
 for(const [patch,status] of [[{conversationId:randomUUID()},403],[{revision:2},409],[{selectedText:'fabricated evidence'},409],[{bubbleId:randomUUID()},409]]){
  const s=submission(lab,['quote']);s.bubbles[0].quote={...quote,...patch};assert.equal((await request(endpoint(lab),s)).status,status);
 }
 assert.equal(lab.calls,1);const valid=submission(lab,['valid quoted message']);valid.bubbles[0].quote=quote;assert.equal((await request(endpoint(lab),valid)).status,202);await lab.chat.idle();assert.equal(lab.calls,2);
 reviseMessage(lab.db,receipt.messageId,1,randomUUID(),'new current content');const stale=submission(lab,['stale']);stale.bubbles[0].quote=quote;assert.equal((await request(endpoint(lab),stale)).status,409);
 // Original accepted submission stays idempotently accepted after its quote changed.
 assert.equal((await request(endpoint(lab),valid)).status,202);assert.equal(lab.calls,2);
}));
test('synthetic restart preserves IDs, canonical content and replay idempotence; old single-message API still works',async()=>{
 let lab=await startV11Lab();let closed=false;try{let request=await login(lab);const s=submission(lab);const receipt=await(await request(endpoint(lab),s)).json();await lab.chat.idle();const run=basename(lab.dir);await lab.close();closed=true;
 lab=await startV11Lab({resume:run});closed=false;request=await login(lab);assert.equal(lab.conversationId,s.conversationId);const replay=await(await request(endpoint(lab),s)).json();assert.equal(replay.turnId,receipt.turnId);assert.equal(lab.calls,0);
 const old=await request('/api/chat/conversations/'+lab.conversationId+'/messages',{clientMessageId:randomUUID(),content:'legacy text'});assert.equal(old.status,202);await lab.chat.idle();assert.equal(lab.calls,1);assert.equal(count(lab,'chat_turns'),2);
 }finally{if(!closed)await lab.close();}
});
function memoryStorage(){let snapshot=null;return{read:()=>snapshot&&structuredClone(snapshot),write:r=>{snapshot=structuredClone(r);},clear:()=>{snapshot=null;}};}
function receipt(r){const turnId=randomUUID();return{submissionId:r.submissionId,conversationId:r.conversationId,bubbleIds:r.bubbles.map(b=>b.id),messageId:randomUUID(),turnId,turnSeq:1,durable:true,turn:{id:turnId,conversationId:r.conversationId,clientMessageId:r.submissionId,status:'queued'}};}
test('submission client keeps immutable UUID snapshot across failure, reload and durable-before-local-clear window',async()=>{
 const store=memoryStorage(),id=randomUUID(),bubbles=[bubble('one'),bubble('two')];let firstId;
 let client=new V11SubmissionClient(async r=>{firstId=r.submissionId;throw Error('synthetic lost response');},store);
 await assert.rejects(client.submit(id,bubbles));assert.equal(store.read().submissionId,firstId);
 client=new V11SubmissionClient(async r=>receipt(r),store);const ack=await client.submit(id,bubbles);assert.equal(ack.submissionId,firstId);assert.ok(store.read(),'receipt alone cannot release original request before composer save');
 client=new V11SubmissionClient(async r=>receipt(r),store);const replay=await client.submit(id,bubbles);assert.equal(replay.submissionId,firstId);client.confirm(replay);assert.equal(store.read(),null);
});
test('submission client rejects changed snapshot or false durable receipt, storage failure prevents any HTTP',async()=>{
 const store=memoryStorage();let calls=0;const client=new V11SubmissionClient(async r=>{calls++;return{...receipt(r),durable:false};},store);const id=randomUUID(),bubbles=[bubble('one')];
 await assert.rejects(client.submit(id,bubbles),/回执不匹配/);await assert.rejects(client.submit(id,[bubble('changed')]),/原快照/);assert.equal(calls,1);assert.ok(store.read());
 const failed=new V11SubmissionClient(async r=>{calls++;return receipt(r);},{read:()=>null,write(){throw Error('disk full');},clear(){}});await assert.rejects(failed.submit(id,bubbles),/停止发送/);assert.equal(calls,1);
});


test('concurrent client final-submit clicks share one request until the composer is durably acknowledged',async()=>{
 const store=memoryStorage();let calls=0;const client=new V11SubmissionClient(async r=>{calls++;await delay(10);return receipt(r);},store);
 const id=randomUUID(),bubbles=[bubble('one')];const [a,b]=await Promise.all([client.submit(id,bubbles),client.submit(id,bubbles)]);assert.equal(calls,1);assert.equal(a.submissionId,b.submissionId);assert.ok(client.pending());client.confirm(a);assert.equal(client.pending(),null);
});
test('only definitive rejection releases submission ID; invalid turn receipts stay recoverable',async()=>{
 const store=memoryStorage();const bubbles=[bubble('kept pending')];const id=randomUUID();
 const rejected=new V11SubmissionClient(async()=>{throw new DefinitiveSubmissionRejection('known not admitted');},store);
 await assert.rejects(rejected.submit(id,bubbles),/known not admitted/);assert.equal(store.read(),null);
 const invalid=new V11SubmissionClient(async r=>({...receipt(r),turn:{id:randomUUID()}}),store);
 await assert.rejects(invalid.submit(id,bubbles),/回执不匹配/);assert.ok(store.read());
});
async function until(fn,label){for(let i=0;i<140;i++){try{const r=await fn();if(r)return r;}catch{}await delay(50);}throw Error('Timed out: '+label);}
test('real Edge linked v11: stage without calling, durable multi-bubble submit, false network outcome and refresh replay',{timeout:60000},async()=>{
 const lab=await startV11Lab();let browser,ws;try{
  const dir=mkdtempSync(join(root,'.phase1-work','v11-linked-browser-')),profile=join(dir,'edge-profile');mkdirSync(profile);
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';assert.ok(existsSync(edge));browser=spawn(edge,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  const port=await until(()=>{const p=join(profile,'DevToolsActivePort');return existsSync(p)&&Number(readFileSync(p,'utf8').split('\n')[0]);},'browser');const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  let seq=0;const waiting=new Map();ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.id){const w=waiting.get(r.id);if(w){waiting.delete(r.id);r.error?w.reject(Error(r.error.message)):w.resolve(r.result);}}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??'Browser error');return r.result.value;};
  const input=async(selector,value)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(40);};
  const clickText=async label=>{await js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.click()`);await delay(40);};
  await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['https://*']});await cdp('Page.navigate',{url:lab.origin+'/demo/chat-group?lab=1'});await until(()=>js("!!document.querySelector('#owner-password')"),'login');
  await cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await input('#owner-password',labPassword);await js("document.querySelector('#owner-password').closest('form').requestSubmit()");await until(()=>js("!!document.querySelector('[aria-label=\"输入消息\"]')"),'linked timeline');assert.equal(await js("getComputedStyle(document.querySelector('.v11-sidebar')).display"),'none');
  for(const value of ['browser first','browser second']){await input('[aria-label="输入消息"]',value);await clickText('暂存');}
  assert.equal(lab.calls,0);assert.equal(count(lab,'chat_turns'),0);assert.equal(count(lab,'chat_outbox'),0);
  await cdp('Page.reload');await until(()=>js("document.querySelectorAll('.pending').length===2"),'staged reload');await clickText('最终提交');await until(()=>js("document.querySelector('.v11-timeline').textContent.includes('[假模型')"),'fake reply');
  assert.equal(lab.calls,1);assert.equal(count(lab,'chat_turns'),1);assert.equal(count(lab,'chat_messages'),2);assert.equal(count(lab,'chat_outbox'),2);assert.equal(await js("document.querySelectorAll('.pending').length"),0);assert.equal(await js("document.querySelector('[aria-label=\"输入消息\"]').value"),'');
  await js("(()=>{const original=window.fetch;let drop=true;window.fetch=async(...args)=>{const response=await original(...args);if(drop&&String(args[0]).endsWith('/submit')){drop=false;throw new TypeError('synthetic lost durable response');}return response;};})()");
  await input('[aria-label="输入消息"]','lost response bubble');await clickText('暂存');await clickText('最终提交');await until(()=>js("document.querySelector('.v11-link-status')?.textContent.includes('结果未确认')"),'unknown outcome');await lab.chat.idle();
  assert.equal(lab.calls,2);assert.equal(await js("document.querySelectorAll('.pending').length"),1);
  const savedId=await js("JSON.parse(sessionStorage.getItem('sakie:v11:linked-submission')).submissionId");
  await cdp('Page.reload');await until(()=>js("!![...document.querySelectorAll('button')].find(e=>e.textContent==='重试同一提交')"),'restored uncertain snapshot');
  assert.equal(await js("JSON.parse(sessionStorage.getItem('sakie:v11:linked-submission')).submissionId"),savedId);await clickText('重试同一提交');await until(()=>js("document.querySelectorAll('.pending').length===0&&!sessionStorage.getItem('sakie:v11:linked-submission')"),'durable replay');
  assert.equal(lab.calls,2);assert.equal(count(lab,'chat_turns'),2);assert.equal(count(lab,'chat_outbox'),4);
  // A regular built/Vite-like page with ?lab=1 must not even probe auth against another backend.
  const accidental=[];const plain=createServer((req,res)=>{accidental.push(req.url);const file=req.url.startsWith('/assets/')?join(root,'frontend/dist',new URL(req.url,'http://local').pathname):join(root,'frontend/dist/index.html');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(file));});
  await new Promise(r=>plain.listen(0,'127.0.0.1',r));
  try{await cdp('Page.navigate',{url:'http://127.0.0.1:'+plain.address().port+'/demo/chat-group?lab=1'});await until(()=>js("document.querySelector('[role=alert]')?.textContent.includes('当前不是隔离联调页面')"),'wrong-origin stop');assert.deepEqual(accidental.filter(p=>p.startsWith('/api')),[]);}finally{plain.closeAllConnections();await new Promise(r=>plain.close(r));}
 }finally{if(ws?.readyState===WebSocket.OPEN)ws.close();browser?.kill();await lab.close();}
});
