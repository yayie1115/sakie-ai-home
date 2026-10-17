import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer,request as forward,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';

const root=fileURLToPath(new URL('../../',import.meta.url));
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,accept:(v:T)=>boolean,timeout=10000):Promise<T>{
 const end=Date.now()+timeout;while(true){const value=await read();if(accept(value))return value;if(Date.now()>end)throw new Error('Acceptance condition timed out');await pause(25);}
}
function launch(file:string,args:string[],env:NodeJS.ProcessEnv){
 const child=spawn(process.execPath,[file,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let stdout='',stderr='';child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
 const done=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 return{child,done,output:()=>({stdout,stderr})};
}
async function kill(p:ReturnType<typeof launch>|undefined){if(p&&p.child.exitCode===null){p.child.kill();await p.done;}}
async function ipc(child:ChildProcess,type:string):Promise<any>{
 const requestId=randomUUID();return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{cleanup();reject(new Error('Fixture IPC timed out'));},5000);
  const receive=(m:any)=>{if(m.requestId===requestId){cleanup();resolve(m);}};
  const cleanup=()=>{clearTimeout(timeout);child.off('message',receive);};
  child.on('message',receive);child.send!({type,requestId});
 });
}
function archiveState(path:string){
 const db=new DatabaseSync(path,{readOnly:true});try{return{
  events:db.prepare('SELECT event_id,stream_seq,payload_hash FROM archive_events ORDER BY stream_seq').all(),
  messages:db.prepare('SELECT id,conversation_id,message_seq,role,content_hash FROM archive_messages ORDER BY rowid').all(),
  cursor:Number(db.prepare('SELECT seq FROM archive_cursor').get()!.seq),
  retry:db.prepare('SELECT phase,failures FROM archive_retry').get()!,
  revisions:db.prepare('SELECT * FROM archive_message_state ORDER BY message_id').all()
 };}finally{db.close();}
}

test('built cloud + agent CLI: durable HTTP chat, kill/replay, offline reconnect, lost ACK, restart, restore and revoke',{timeout:90000},async t=>{
 assert.equal(process.env.SAKIE_SYNC_E2E,'1','Use npm run test:sync:e2e for isolated environment/builds');
 assert.ok(process.env.TEST_DATA_ROOT);const dir=mkdtempSync(join(process.env.TEST_DATA_ROOT!,'process-case-'));
 const cloudFile=join(dir,'cloud.db'),archiveFile=join(dir,'archive.db'),credentials=join(dir,'agent-credentials-test.json'),policy=join(dir,'policy.json');
 const env={...process.env,DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:'',E2E_CLOUD_DATABASE:cloudFile};
 let cloud:ReturnType<typeof launch>|undefined,agent:ReturnType<typeof launch>|undefined,cloudPort=0;
 let offline=false,holdAck=false,loseAckReply=false;let onHeldAck=()=>{};const held:ServerResponse[]=[];
 async function startCloud(){
  cloud=launch(join(root,'backend/test/fixtures/sync-cloud-process.mjs'),[],{...env,E2E_CLOUD_PORT:String(cloudPort)});
  const current=cloud;cloudPort=await new Promise<number>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Cloud startup timed out: '+current.output().stderr.slice(-1000))),10000);
   current.child.on('message',(m:any)=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port);}});
   current.done.then(code=>{clearTimeout(timer);reject(new Error('Cloud exited before ready: '+code));},reject);
  });
 }
 const stats=()=>ipc(cloud!.child,'stats');
 const relay=createServer((req,res)=>{
  if(offline&&req.url?.startsWith('/api/sync/')){req.resume();res.writeHead(503);res.end('{}');return;}
  if(holdAck&&req.url==='/api/sync/ack'){req.resume();held.push(res);onHeldAck();return;}
  const lose=loseAckReply&&req.url==='/api/sync/ack';if(lose)loseAckReply=false;
  const upstream=forward({hostname:'127.0.0.1',port:cloudPort,path:req.url,method:req.method,headers:req.headers},response=>{
   if(lose&&response.statusCode===200){response.resume();response.on('end',()=>res.destroy());return;}
   res.writeHead(response.statusCode??502,response.headers);response.pipe(res);
  });upstream.on('error',()=>{if(!res.destroyed){if(!res.headersSent)res.writeHead(503);res.end('{}');}});req.pipe(upstream);
 });
 let origin='',cookie='',csrf='';
 async function owner(path:string,init:RequestInit={}){const headers=new Headers(init.headers);headers.set('Cookie',cookie);headers.set('X-CSRF-Token',csrf);if(init.body)headers.set('Content-Type','application/json');return fetch(origin+path,{...init,headers});}
 async function cli(command:string,extra:string[]=[],file=credentials){
  const p=launch(join(root,'local-agent/dist/cli.js'),[command,'--credentials',file,'--policy',policy,...extra],{...env,SYNC_BATCH_SIZE:'1',SYNC_POLL_MS:'20',SYNC_RETRY_BASE_MS:'10',SYNC_RETRY_MAX_MS:'50'});
  const timer=setTimeout(()=>p.child.kill(),15000);let code;try{code=await p.done;}finally{clearTimeout(timer);}return{code,...p.output()};
 }
 async function pair(file=credentials){
  const r=await owner('/api/devices/pairings',{method:'POST',body:'{}'});assert.equal(r.status,201);
  const code=join(dir,'pairing-code-'+randomUUID()+'.txt');writeFileSync(code,(await r.json()).pairingId);
  const result=await cli('pair',['--cloud',origin,'--database',archiveFile,'--pairing-code-file',code],file);assert.equal(result.code,0,result.stderr);
  return code;
 }
 async function catchUp(file=credentials){
  for(let n=0;n<40;n++){const r=await cli('once',[],file);assert.equal(r.code,0,r.stderr);const state=JSON.parse(r.stdout.trim());if(state.caughtUp)return state;}
  throw new Error('CLI did not converge');
 }
 let conversationId='';
 async function send(content:string,id=randomUUID()){
  const body=JSON.stringify({clientMessageId:id,content});const r=await owner('/api/chat/conversations/'+conversationId+'/messages',{method:'POST',body});assert.equal(r.status,202);const receipt=await r.json();
  await until(async()=>{const response=await owner('/api/chat/turns/'+receipt.turnId);assert.equal(response.status,200);return(await response.json()).turn.status;},status=>status==='succeeded');
  return{...receipt,clientMessageId:id};
 }
 const checkParity=async()=>{const c=await stats(),a=archiveState(archiveFile);assert.deepEqual(a.events.map(r=>({...r})),c.events);assert.deepEqual(a.messages.map(r=>({...r})),c.messages);assert.equal(a.cursor,c.events.length);return c;};
 try{
  await startCloud();relay.listen(0,'127.0.0.1');await once(relay,'listening');const address=relay.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
  writeFileSync(policy,JSON.stringify({version:1,environment:'test',allowedOrigins:[origin]}));
  const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'e2e-test-password-only'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=(await login.json()).csrfToken;
  const createBody=JSON.stringify({id:randomUUID(),title:'synthetic process acceptance'});
  assert.equal((await fetch(origin+'/api/chat/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:createBody})).status,401);
  assert.equal((await fetch(origin+'/api/chat/conversations',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:createBody})).status,403);
  assert.equal((await owner('/api/chat/conversations',{method:'POST',headers:{Origin:'https://wrong.example.invalid'},body:createBody})).status,403);
  const conversation=await owner('/api/chat/conversations',{method:'POST',body:createBody});assert.equal(conversation.status,201);conversationId=(await conversation.json()).id;
  await pair();const first=await send('synthetic first');const repeated=await send('synthetic first',first.clientMessageId);assert.equal(repeated.messageId,first.messageId);await send('synthetic second');assert.equal((await stats()).attempts,2);
  const conflict=await owner('/api/chat/conversations/'+conversationId+'/messages',{method:'POST',body:JSON.stringify({clientMessageId:first.clientMessageId,content:'different synthetic content'})});assert.equal(conflict.status,409);
  t.diagnostic('PASS authenticated HTTP + fake model + durable duplicate receipts; no agent online required');

  holdAck=true;const committed=new Promise<void>(resolve=>{onHeldAck=resolve;});
  agent=launch(join(root,'local-agent/dist/cli.js'),['run','--credentials',credentials,'--policy',policy],{...env,SYNC_BATCH_SIZE:'1',SYNC_POLL_MS:'20',SYNC_RETRY_BASE_MS:'10',SYNC_RETRY_MAX_MS:'50'});
  await Promise.race([committed,agent.done.then(()=>{throw new Error('Agent exited before ACK gate');})]);await kill(agent);agent=undefined;
  assert.equal(archiveState(archiveFile).cursor,1);assert.equal((await stats()).devices[0].ack_seq,0);holdAck=false;for(const response of held)response.destroy();
  await catchUp();await checkParity();assert.equal((await stats()).devices[0].ack_seq,4);
  const restored=join(dir,'old-archive.db');const old=new DatabaseSync(archiveFile,{readOnly:true});try{await backup(old,restored);}finally{old.close();}
  t.diagnostic('PASS real agent process killed after local COMMIT/before ACK; replays deduplicate after restart');

  offline=true;agent=launch(join(root,'local-agent/dist/cli.js'),['run','--credentials',credentials,'--policy',policy],{...env,SYNC_BATCH_SIZE:'1',SYNC_POLL_MS:'20',SYNC_RETRY_BASE_MS:'10',SYNC_RETRY_MAX_MS:'50'});
  await until(()=>archiveState(archiveFile).retry.phase,x=>x==='offline');await send('synthetic offline third');offline=false;
  await until(async()=>{const s=await stats();return s.devices[0].ack_seq===s.events.length;},x=>x);
  await kill(agent);agent=undefined;await checkParity();assert.equal((await stats()).attempts,3);
  t.diagnostic('PASS actual HTTP outage/backoff/reconnect while cloud chat continues; no extra model calls');

  await send('synthetic fourth');loseAckReply=true;const lost=await cli('once');assert.equal(lost.code,1);assert.equal(archiveState(archiveFile).cursor,7);assert.equal((await stats()).devices[0].ack_seq,7);
  const prior=await stats();await kill(cloud);cloud=undefined;await startCloud();assert.deepEqual((await stats()).events,prior.events);assert.equal((await stats()).devices[0].ack_seq,7);
  await catchUp();await checkParity();assert.equal((await stats()).attempts,4);
  t.diagnostic('PASS lost ACK response + hard cloud process restart retain device, stream IDs and confirmed cursor');

  const oldCreds=join(dir,'agent-credentials-restored.json');writeFileSync(oldCreds,JSON.stringify({...JSON.parse(readFileSync(credentials,'utf8')),database:restored}));
  const behind=await cli('once',[],oldCreds);assert.equal(behind.code,1);assert.match(behind.stderr,/RECONCILE_cursor-behind/);assert.equal(archiveState(restored).cursor,4);assert.equal((await stats()).devices[0].ack_seq,8);
  t.diagnostic('PASS old local snapshot cannot reuse a higher cloud ACK or roll back current archive');

  const raw=(await stats()).messages;const edit=await owner('/api/chat/messages/'+raw[0].id,{method:'PATCH',body:JSON.stringify({requestId:randomUUID(),baseRevision:1,content:'synthetic edited'})});assert.equal(edit.status,200);
  const deletion=await owner('/api/chat/messages/'+raw[1].id,{method:'DELETE',body:JSON.stringify({requestId:randomUUID(),baseRevision:1})});assert.equal(deletion.status,200);await catchUp();await checkParity();
  const state=archiveState(archiveFile);assert.equal(state.revisions.length,2);assert.equal(state.messages.length,8);assert.equal(state.revisions.filter(r=>r.deleted_at!==null).length,1);
  const history=await owner('/api/chat/conversations/'+conversationId+'/messages');assert.equal((await history.json()).items.length,7);
  t.diagnostic('PASS edit/tombstone events synchronize without removing original messages');

  const current=JSON.parse(readFileSync(credentials,'utf8'));assert.equal((await fetch(origin+'/api/diaries',{headers:{Authorization:'Bearer '+current.token}})).status,401);
  agent=launch(join(root,'local-agent/dist/cli.js'),['run','--credentials',credentials,'--policy',policy],{...env,SYNC_POLL_MS:'20',SYNC_RETRY_BASE_MS:'10',SYNC_RETRY_MAX_MS:'50'});
  assert.equal((await owner('/api/devices/'+current.deviceId+'/revoke',{method:'POST'})).status,204);
  assert.equal(await agent.done,1);agent=undefined;assert.equal(archiveState(archiveFile).retry.phase,'blocked');
  await send('synthetic after revoke');const fresh=join(dir,'agent-credentials-repaired.json');await pair(fresh);await catchUp(fresh);const final=await checkParity();
  assert.equal(final.attempts,5);assert.equal(final.messages.length,10);assert.equal(final.events.length,12);assert.equal(final.devices.filter((d:any)=>!d.revoked_at)[0].ack_seq,12);
  writeFileSync(join(dir,'acceptance-summary.json'),JSON.stringify({passed:true,messages:10,events:12,attempts:5,scenarios:7},null,2));
  t.diagnostic('PASS live revocation stops agent; explicit re-pair replays whole stream idempotently');
 }finally{
  await kill(agent);for(const response of held)response.destroy();relay.closeAllConnections();if(relay.listening)await new Promise<void>(resolve=>relay.close(()=>resolve()));await kill(cloud);
 }
});
