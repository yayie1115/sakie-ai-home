import {migrateLiveChat} from '../src/modules/chat/live-schema.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database/index.js';
import { migrate, migrations, schemaVersion, latestVersion } from '../src/database/migrations.js';
import { databaseFingerprint } from '../src/database/fingerprint.js';
import { upgradeDatabase } from '../src/database/upgrade.js';
import { createBackup, restoreBackup } from '../src/database/backup.js';
import { parseChatConfig } from '../src/modules/chat/config.js';
import { DeepSeekProvider } from '../src/modules/chat/deepseek.js';
import { ChatStore, hashContent } from '../src/modules/chat/store.js';
import { ChatService } from '../src/modules/chat/service.js';
import { assembleContext } from '../src/modules/chat/context.js';
import { ModelError, type ModelProvider, type ModelMessage, type ModelReply } from '../src/modules/chat/provider.js';
import { AuthService } from '../src/modules/auth/service.js';
import { authenticatedFetch, testCredential, temporaryDirectory } from './helpers.js';
const settings = () => parseChatConfig({DEEPSEEK_MODEL:'fake-test-model',DEEPSEEK_API_KEY:'test-only-not-a-real-key'});
const reply = (content='测试回复'):ModelReply => ({content,requestId:'fake-response',usage:{inputTokens:30,outputTokens:10,cacheReadTokens:20,cacheWriteTokens:null,cacheMissTokens:10}});
function fake(complete:ModelProvider['complete']=async()=>reply()):ModelProvider{return{name:'fake',model:'fake-test-model',complete};}
function conversation(store:ChatStore){const id=randomUUID();store.createConversation(id,'test');return id;}
const input=(conversationId:string,content='测试消息')=>({conversationId,content,clientMessageId:randomUUID()});
async function harness(provider:ModelProvider|null=fake()){
 const db=openDatabase(':memory:');migrateLiveChat(db);const store=new ChatStore(db),chat=new ChatService(store,provider,settings());chat.start();
 const auth=new AuthService(db,{loadCredential:()=>testCredential,publicOrigin:'http://127.0.0.1:5173',secureCookies:false});
 const server=createApp(db,{auth,chat}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 const base='http://127.0.0.1:'+address.port;const authorized=await authenticatedFetch(()=>base);const request:typeof fetch=(url,init={})=>{const headers=new Headers(init.headers);if(init.body)headers.set('Content-Type','application/json');return authorized(url,{...init,headers});};
 return {db,store,chat,base,request,async close(){await chat.stop();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}};
}
test('chat HTTP flow is authenticated, CSRF protected, idempotent, ordered and paginated',async()=>{
 let calls=0;const app=await harness(fake(async()=>{calls++;return reply();}));try{
  const route=app.base+'/api/chat';
  for(const path of ['/config','/conversations','/conversations/'+randomUUID()+'/messages','/turns/'+randomUUID()])assert.equal((await fetch(route+path)).status,401);
  const login=await app.request(app.base+'/api/auth/session');const cookie=login.headers.get('set-cookie');void cookie;
  // A valid cookie without CSRF cannot create conversations.
  const anonymous=await fetch(app.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'phase1-test-password-only'})});
  assert.equal((await fetch(route+'/conversations',{method:'POST',headers:{Cookie:anonymous.headers.get('set-cookie')!.split(';')[0],'Content-Type':'application/json'},body:'{}'})).status,403);
  const id=randomUUID();const create=()=>app.request(route+'/conversations',{method:'POST',body:JSON.stringify({id,title:'test',kind:'private',members:['mu']})});assert.equal((await create()).status,201);await create();
  const message=input(id,'  保留原文空白  '),url=route+'/conversations/'+id+'/messages';
  const send=()=>app.request(url,{method:'POST',body:JSON.stringify(message)});const accepted=await send();assert.equal(accepted.status,202);const receipt=await accepted.json();assert.equal(receipt.durable,true);
  await app.chat.idle();for(let i=0;i<10;i++)assert.equal((await (await send()).json()).turnId,receipt.turnId);
  assert.equal(calls,1);assert.equal((await app.request(url,{method:'POST',body:JSON.stringify({...message,content:'different'})})).status,409);
  const history=await (await app.request(url+'?limit=1')).json();assert.equal(history.items.length,1);assert.equal(history.items[0].role,'assistant');assert.equal(history.nextBefore,2);
  const earlier=await (await app.request(url+'?limit=1&before=2')).json();assert.equal(earlier.items[0].content,message.content);assert.equal(earlier.nextBefore,null);
  assert.equal((await (await app.request(route+'/turns/'+receipt.turnId)).json()).turn.status,'succeeded');
  assert.equal((await app.request(url+'?before=abc')).status,400);
  assert.equal((await app.request(url,{method:'POST',body:JSON.stringify({...input(id),content:' '.repeat(2)})})).status,400);
  assert.equal((await app.request(url,{method:'POST',body:JSON.stringify({...input(id),content:'x'.repeat(12001)})})).status,400);
  const attempts=app.db.prepare('SELECT * FROM chat_attempts').all();assert.equal(attempts.length,1);assert.equal(attempts[0].input_tokens,30);assert.equal(attempts[0].cache_read_tokens,20);assert.equal(attempts[0].cache_write_tokens,null);assert.equal(attempts[0].cost_micros,null);
  const outbox=app.db.prepare('SELECT * FROM chat_outbox ORDER BY stream_seq').all();assert.equal(outbox.length,2);
  for(const event of outbox)assert.equal(event.payload_hash,hashContent(String(event.payload)));
  assert.equal(JSON.parse(String(outbox[0].payload)).id,receipt.messageId);
  assert.deepEqual((await (await app.request(route+'/conversations')).json()).items[0].profile,{kind:'private',members:['mu']});
  assert.equal(history.items[0].speakerId,'mu');
  const groupId=randomUUID();
  assert.equal((await app.request(route+'/conversations',{method:'POST',body:JSON.stringify({id:groupId,title:'真实结构的隔离群',kind:'group',members:[]})})).status,400);
  assert.equal((await app.request(route+'/conversations',{method:'POST',body:JSON.stringify({id:groupId,title:'真实结构的隔离群',kind:'group',members:['mu','xing']})})).status,201);
  const groupInput={...input(groupId),replyToMemberId:'xing'},groupUrl=route+'/conversations/'+groupId+'/messages';
  assert.equal((await app.request(groupUrl,{method:'POST',body:JSON.stringify({...groupInput,replyToMemberId:'yan'})})).status,403);
  const groupReceipt=await (await app.request(groupUrl,{method:'POST',body:JSON.stringify(groupInput)})).json();await app.chat.idle();
  const groupHistory=await (await app.request(groupUrl)).json();assert.equal(groupHistory.items[1].speakerId,'xing');
  assert.equal((await (await app.request(route+'/turns/'+groupReceipt.turnId)).json()).turn.replyToMemberId,'xing');
  assert.equal((await app.request(groupUrl,{method:'POST',body:JSON.stringify({...groupInput,replyToMemberId:'mu'})})).status,409);

 }finally{await app.close();}
});
test('unconfigured provider permits history but rejects a new call without storing misleading accepted messages',async()=>{
 const app=await harness(null);try{const id=conversation(app.store);assert.equal((await app.request(app.base+'/api/chat/conversations/'+id+'/messages',{method:'POST',body:JSON.stringify(input(id))})).status,503);assert.equal(app.store.messages(id,100,10).length,0);assert.equal((await app.request(app.base+'/api/chat/conversations/'+id+'/messages')).status,200);}finally{await app.close();}
});
test('overlapping requests cannot duplicate a call or advance the conversation past an unresolved turn',async()=>{
 let release!:(value:ModelReply)=>void;let calls=0;
 const db=openDatabase(':memory:'),store=new ChatStore(db),service=new ChatService(store,fake(()=>{calls++;return new Promise(resolve=>{release=resolve;});}),settings());
 try{const id=conversation(store),message=input(id);const first=await service.send(message);const repeated=await service.send(message);assert.equal(first.turnId,repeated.turnId);assert.equal(calls,1);
  await assert.rejects(service.send(input(id)),/TURN_UNRESOLVED/);release(reply());await service.idle();assert.equal(store.messages(id,100,10).length,2);
 }finally{await service.stop();db.close();}
});
test('known failures retain the original user message and explicit retry requests are durably deduplicated',async()=>{
 let calls=0;const db=openDatabase(':memory:'),store=new ChatStore(db),service=new ChatService(store,fake(async()=>{if(++calls===1)throw new ModelError('MODEL_HTTP_429','failed');return reply();}),settings());
 try{const id=conversation(store),message=input(id),first=await service.send(message);await service.idle();assert.equal(store.turn(first.turnId).status,'failed');assert.equal(store.messages(id,100,10).length,1);
  await service.send(message);await service.idle();assert.equal(calls,1);
  const retryId=randomUUID();service.retry(first.turnId,retryId,false);service.retry(first.turnId,retryId,false);await service.idle();service.retry(first.turnId,retryId,false);await service.idle();assert.equal(calls,2);assert.equal(store.messages(id,100,10).length,2);assert.equal(db.prepare('SELECT count(*) AS n FROM chat_attempts').get()!.n,2);
  assert.throws(()=>service.retry(randomUUID(),retryId,false),/RETRY_ID_CONFLICT/);
 }finally{await service.stop();db.close();}
});
test('timeout is unknown, late replies are ignored, and no automatic supplier retry occurs',async()=>{
 let release!:(value:ModelReply)=>void;let calls=0;const db=openDatabase(':memory:'),store=new ChatStore(db),config={...settings(),timeoutMs:30};
 const service=new ChatService(store,fake(()=>{calls++;return new Promise(resolve=>{release=resolve;});}),config);
 try{const id=conversation(store),receipt=await service.send(input(id));await service.idle();assert.equal(store.turn(receipt.turnId).status,'unknown');assert.equal(calls,1);release(reply('late'));await new Promise(resolve=>setImmediate(resolve));assert.equal(store.messages(id,100,10).length,1);
  assert.throws(()=>service.retry(receipt.turnId,randomUUID(),false),/ACKNOWLEDGEMENT/);assert.equal(db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n,1);
 }finally{await service.stop();db.close();}
});
test('recent context keeps complete pairs within configurable bounds and never truncates raw history',async()=>{
 const calls:readonly ModelMessage[][]=[];const captured=calls as ModelMessage[][];const db=openDatabase(':memory:'),store=new ChatStore(db),config={...settings(),contextTurns:2,contextChars:1000};
 const service=new ChatService(store,fake(async messages=>{captured.push([...messages]);return reply('response');}),config);
 try{const id=conversation(store);for(let i=0;i<5;i++){await service.send(input(id,'message-'+i));await service.idle();}
  assert.deepEqual(captured[4].filter(m=>m.role==='user').map(m=>m.content),['message-2','message-3','message-4']);assert.equal(captured[4][0].role,'system');
  const last=db.prepare('SELECT id FROM chat_turns ORDER BY turn_seq DESC LIMIT 1').get()!;const reduced=assembleContext(store,String(last.id),{...config,contextChars:10});assert.equal(reduced.filter(m=>m.role!=='system').length,1);assert.equal(store.messages(id,100,100).length,10);
 }finally{await service.stop();db.close();}
});
test('user admission is atomic with its task, sequence and outbox; failed assistant persistence never becomes success',async()=>{
 const db=openDatabase(':memory:'),store=new ChatStore(db);const id=conversation(store);
 db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON chat_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END");
 await assert.rejects(store.accept(input(id)),/outbox unavailable/);assert.equal(db.prepare('SELECT count(*) AS n FROM chat_turns').get()!.n,0);assert.equal(store.conversation(id)!.id,id);assert.equal(db.prepare('SELECT next_turn_seq AS n FROM chat_conversations').get()!.n,1);
 db.exec('DROP TRIGGER fail_outbox');
 const service=new ChatService(store,fake(),settings());
 try{const receipt=await store.accept(input(id));db.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON chat_messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'disk failure'); END");service.start();await service.idle();assert.equal(store.turn(receipt.turnId).status,'running');assert.equal(store.messages(id,100,10).length,1);assert.equal(db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n,1);
 }finally{await service.stop();db.close();}
});
test('actual process interruption preserves accepted data; restart quarantines running attempts and only explicit acknowledgement retries',async()=>{
 const dir=temporaryDirectory(),filename=join(dir,'chat.db');let db=openDatabase(filename);let service:ChatService|undefined;
 try{
  const store=new ChatStore(db),id=conversation(store),original=input(id),receipt=await store.accept(original);db.close();
  const module=(name:string)=>new URL('../src/'+name,import.meta.url).href;
  const script=`import {openDatabase} from ${JSON.stringify(module('database/index.ts'))};import {ChatStore} from ${JSON.stringify(module('modules/chat/store.ts'))};import {ChatService} from ${JSON.stringify(module('modules/chat/service.ts'))};import {parseChatConfig} from ${JSON.stringify(module('modules/chat/config.ts'))};const db=openDatabase(${JSON.stringify(filename)});const service=new ChatService(new ChatStore(db),{name:'fake',model:'test',complete:async()=>process.exit(77)},parseChatConfig({}));service.start();`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});assert.equal(child.status,77,child.stderr);
  db=openDatabase(filename);const restarted=new ChatStore(db);let calls=0;service=new ChatService(restarted,fake(async()=>{calls++;return reply();}),settings());service.start();await service.idle();assert.equal(calls,0);assert.equal(restarted.turn(receipt.turnId).status,'unknown');assert.equal(restarted.messages(id,100,10)[0].id,receipt.messageId);
  assert.equal((await service.send(original)).turnId,receipt.turnId);assert.equal(calls,0);
  service.retry(receipt.turnId,randomUUID(),true);await service.idle();assert.equal(calls,1);assert.equal(restarted.messages(id,100,10).length,2);await service.stop();db.close();
  db=openDatabase(filename);assert.equal(new ChatStore(db).turn(receipt.turnId).status,'succeeded');
 }finally{await service?.stop();db.close();rmSync(dir,{recursive:true});}
});
test('queued work resumes once after restart, and independent conversations share one lightweight worker',async()=>{
 const db=openDatabase(':memory:'),store=new ChatStore(db);let active=0,peak=0,calls=0;
 const a=conversation(store),b=conversation(store);await store.accept(input(a));await store.accept(input(b));
 const service=new ChatService(store,fake(async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return reply();}),settings());
 try{service.start();await service.idle();assert.equal(calls,2);assert.equal(peak,1);assert.equal(store.messages(a,100,10).length,2);assert.equal(store.messages(b,100,10).length,2);}finally{await service.stop();db.close();}
});
test('additive v2 to v3 upgrade backs up and rehearses; old records and auth remain intact; failure rolls back',async()=>{
 const dir=temporaryDirectory(),filename=join(dir,'v2.db');try{
  const db=new DatabaseSync(filename);migrate(db,migrations.slice(0,2));db.prepare('INSERT INTO diaries VALUES (?,?,?)').run('old-uuid','2026-10-15','historical fixture');db.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').run('test-hash','test-version',123);const fingerprint=databaseFingerprint(db);
  assert.throws(()=>migrate(db,undefined,{afterStep:version=>{if(version===3)throw new Error('injected-v3-failure');}}),/injected-v3-failure/);assert.equal(databaseFingerprint(db),fingerprint);assert.equal(schemaVersion(db),2);db.close();
  const upgrade=await upgradeDatabase(filename,join(dir,'backups'));assert.ok(upgrade.backupDirectory);assert.ok(upgrade.rehearsalDatabase);const before=new DatabaseSync(join(upgrade.backupDirectory!,'database.sqlite'),{readOnly:true});assert.equal(databaseFingerprint(before),fingerprint);before.close();
  const current=openDatabase(filename);assert.equal(schemaVersion(current),latestVersion);assert.equal(current.prepare('SELECT content FROM diaries').get()!.content,'historical fixture');assert.equal(current.prepare('SELECT token_hash FROM auth_sessions').get()!.token_hash,'test-hash');const store=new ChatStore(current),id=conversation(store);const service=new ChatService(store,fake(),settings());await service.send(input(id));await service.idle();await service.stop();const after=databaseFingerprint(current);current.close();
  assert.deepEqual(await upgradeDatabase(filename,join(dir,'backups')),{changed:false});const backup=await createBackup(filename,join(dir,'backups'));const restored=await restoreBackup(backup,join(dir,'restored'));const copy=new DatabaseSync(restored,{readOnly:true});assert.equal(databaseFingerprint(copy),after);assert.equal(copy.prepare('SELECT count(*) AS n FROM chat_messages').get()!.n,2);assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');copy.close();
 }finally{rmSync(dir,{recursive:true});}
});
test('DeepSeek adapter uses official compatible shape, bounded text, cancellation and truthful cache usage',async()=>{
 let request:RequestInit|undefined;let url='';const config=settings();
 const transport:typeof fetch=async(input,init)=>{url=String(input);request=init;return new Response(JSON.stringify({id:'provider-id',choices:[{finish_reason:'stop',message:{content:'回复'}}],usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20}}),{status:200});};
 const adapter=new DeepSeekProvider(config,transport);const signal=new AbortController().signal;const result=await adapter.complete([{role:'user',content:'hello'}],signal);assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(request!.signal,signal);assert.equal(request!.redirect,'error');assert.equal((request!.headers as Record<string,string>).Authorization,'Bearer test-only-not-a-real-key');const body=JSON.parse(String(request!.body));assert.equal(body.stream,false);assert.equal(body.model,config.model);assert.equal(body.thinking.type,'disabled');assert.equal(body.max_tokens,config.maxOutputTokens);assert.equal(result.content,'回复');assert.equal(result.usage.cacheReadTokens,80);assert.equal(result.usage.cacheWriteTokens,null);assert.equal(result.usage.cacheMissTokens,20);
});
test('DeepSeek adapter sanitizes supplier errors and rejects malformed or truncated successes',async()=>{
 const config=settings(),signal=new AbortController().signal;
 for(const status of [401,429,500]){const adapter=new DeepSeekProvider(config,async()=>new Response('private supplier error with fake secret',{status}));await assert.rejects(adapter.complete([{role:'user',content:'test'}],signal),(error:unknown)=>error instanceof ModelError&&error.code==='MODEL_HTTP_'+status&&error.outcome===(status===500?'unknown':'failed')&&!error.message.includes('private'));}
 for(const value of ['not-json',JSON.stringify({choices:[{finish_reason:'length',message:{content:'partial'}}]}),JSON.stringify({choices:[{finish_reason:'stop',message:{content:null}}]})]){const adapter=new DeepSeekProvider(config,async()=>new Response(value));await assert.rejects(adapter.complete([],signal),ModelError);}
 const adapter=new DeepSeekProvider(config,async()=>{throw new Error('network with secret');});await assert.rejects(adapter.complete([],signal),/MODEL_NETWORK_ERROR/);
});
test('chat configuration keeps credentials backend-only and validates resource limits and HTTPS',()=>{
 assert.equal(parseChatConfig({}).model,'');assert.equal(parseChatConfig({}).apiKey,'');assert.throws(()=>parseChatConfig({DEEPSEEK_BASE_URL:'http://api.deepseek.com'}));assert.throws(()=>parseChatConfig({DEEPSEEK_BASE_URL:'https://user:password@api.deepseek.com'}));assert.throws(()=>parseChatConfig({CHAT_CONTEXT_TURNS:'0'}));assert.throws(()=>parseChatConfig({CHAT_CONTEXT_MAX_CHARS:'1000'}));assert.throws(()=>parseChatConfig({MODEL_TIMEOUT_MS:'0'}));
});

test('read-only chat requests never call a model, and HTTP unknown-result retries require acknowledgement',async()=>{
 let calls=0;const app=await harness(fake(async()=>{if(++calls===1)throw new ModelError('MODEL_TIMEOUT','unknown');return reply();}));
 try{const route=app.base+'/api/chat',id=conversation(app.store),url=route+'/conversations/'+id+'/messages';
  for(const path of ['/config','/conversations','/conversations/'+id+'/messages'])assert.equal((await app.request(route+path)).status,200);assert.equal(calls,0);
  const result=await (await app.request(url,{method:'POST',body:JSON.stringify(input(id))})).json();await app.chat.idle();
  const retryId=randomUUID(),retryUrl=route+'/turns/'+result.turnId+'/retry';
  assert.equal((await app.request(retryUrl,{method:'POST',body:JSON.stringify({retryId})})).status,409);assert.equal(calls,1);
  for(let i=0;i<2;i++)assert.equal((await app.request(retryUrl,{method:'POST',body:JSON.stringify({retryId,acknowledgeUnknown:true})})).status,202);
  await app.chat.idle();assert.equal(calls,2);assert.equal(app.store.messages(id,100,10).length,2);
 }finally{await app.close();}
});
test('worker capacity rejects new work without losing already accepted messages',async()=>{
 const db=openDatabase(':memory:'),store=new ChatStore(db);const service=new ChatService(store,fake(()=>new Promise(()=>{})),{...settings(),maxQueued:1,timeoutMs:1000});
 try{const a=conversation(store),b=conversation(store),first=await service.send(input(a));await assert.rejects(service.send(input(b)),/CHAT_QUEUE_FULL/);assert.equal(store.messages(a,100,10).length,1);assert.equal(store.messages(b,100,10).length,0);await service.stop();assert.equal(store.turn(first.turnId).status,'unknown');
  await assert.rejects(service.send(input(b)),/CHAT_WORKER_UNAVAILABLE/);
 }finally{await service.stop();db.close();}
});
