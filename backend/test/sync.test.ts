import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {join} from 'node:path';
import {mkdirSync,rmSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import type {ArchiveIdentity,SyncTransport,WireSyncEvent} from '@sakie/contracts';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/database/index.js';
import {migrate,migrations,schemaVersion,latestVersion} from '../src/database/migrations.js';
import {upgradeDatabase} from '../src/database/upgrade.js';
import {createBackup,restoreBackup,verifyBackup} from '../src/database/backup.js';
import {databaseFingerprint} from '../src/database/fingerprint.js';
import {prepareStorage} from '../src/storage/prepare.js';
import {AuthService} from '../src/modules/auth/service.js';
import {ChatStore} from '../src/modules/chat/store.js';
import {ChatService} from '../src/modules/chat/service.js';
import {parseChatConfig} from '../src/modules/chat/config.js';
import type {ModelProvider} from '../src/modules/chat/provider.js';
import {SyncService} from '../src/modules/sync/service.js';
import {digest,wireEvent} from '../src/modules/sync/events.js';
import {LocalArchive,ArchiveError} from '../../local-agent/src/archive.js';
import {HttpSyncTransport as BaseHttpSyncTransport,TransportError,cloudUrl} from '../../local-agent/src/transport.js';
import {SyncRunner} from '../../local-agent/src/runner.js';
class HttpSyncTransport extends BaseHttpSyncTransport {constructor(origin:string,token:string){super(origin,token,fetch,15000,{version:1,environment:'test',allowedOrigins:[origin]});}}
import {authenticatedFetch,testCredential,temporaryDirectory} from './helpers.js';
const model:ModelProvider={name:'fake',model:'fake',async complete(){return{content:'synthetic reply',requestId:null,usage:{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null}};}};
async function cloud(filename=':memory:'){
 const db=openDatabase(filename),store=new ChatStore(db),chat=new ChatService(store,model,parseChatConfig({}));chat.start();const sync=new SyncService(db);
 const auth=new AuthService(db,{loadCredential:()=>testCredential,publicOrigin:'http://127.0.0.1:5173',secureCookies:false});
 const server=createApp(db,{auth,chat}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 const authorized=await authenticatedFetch(()=>base);const owner:typeof fetch=(url,init={})=>{const headers=new Headers(init.headers);if(init.body)headers.set('Content-Type','application/json');return authorized(url,{...init,headers});};
 return{db,store,chat,sync,base,owner,async close(){await chat.stop();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}};
}
async function emit(c:Awaited<ReturnType<typeof cloud>>,conversationId?:string,content='synthetic user'){
 const id=conversationId??randomUUID();if(!conversationId)c.store.createConversation(id,'synthetic');const sent=await c.chat.send({conversationId:id,clientMessageId:randomUUID(),content});await c.chat.idle();return{conversationId:id,...sent};
}
async function pair(c:Awaited<ReturnType<typeof cloud>>,archive:LocalArchive){
 const created=await c.owner(c.base+'/api/devices/pairings',{method:'POST',body:'{}'});assert.equal(created.status,201);const{pairingId}=await created.json();
 const response=await fetch(c.base+'/api/sync/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:pairingId,archive:await archive.inspectIdentity()})});assert.equal(response.status,201);return await response.json() as {token:string;deviceId:string};
}
async function catchUp(runner:SyncRunner){for(let i=0;i<100;i++){const result=await runner.syncOnce();if(result.caughtUp)return result;}throw new Error('Did not converge');}
function allEvents(c:Awaited<ReturnType<typeof cloud>>){return c.db.prepare('SELECT * FROM chat_outbox ORDER BY stream_seq').all().map(wireEvent);}
function device(c:Awaited<ReturnType<typeof cloud>>,id:string){return c.db.prepare('SELECT ack_seq,delivered_seq FROM sync_devices WHERE id=?').get(id)!;}
function wrap(t:SyncTransport,overrides:Partial<SyncTransport>):SyncTransport{return{resume:r=>t.resume(r),pull:(a,l)=>t.pull(a,l),acknowledge:c=>t.acknowledge(c),...overrides};}

test('device pairing is owner-protected, single-use and revocable; device tokens never authorize business APIs',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  assert.equal((await fetch(c.base+'/api/devices/pairings',{method:'POST'})).status,401);
  assert.equal((await fetch(c.base+'/api/sync/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const code=await c.sync.createPairing(),identity=await a.inspectIdentity();
  const bad=await fetch(c.base+'/api/sync/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:'invalid',archive:identity})});assert.equal(bad.status,401);
  const credentials=c.sync.pair(code.pairingId,identity);assert.throws(()=>c.sync.pair(code.pairingId,identity),/INVALID_PAIRING/);
  const tokenRow=c.db.prepare('SELECT token_hash FROM sync_devices WHERE id=?').get(credentials.deviceId)!;assert.notEqual(tokenRow.token_hash,credentials.token);assert.equal(tokenRow.token_hash,digest(credentials.token));
  assert.equal((await fetch(c.base+'/api/diaries',{headers:{Authorization:'Bearer '+credentials.token}})).status,401);
  const transport=new HttpSyncTransport(c.base,credentials.token);assert.equal((await transport.resume({archive:identity,lastArchived:null})).status,'resume');
  await c.owner(c.base+'/api/devices/'+credentials.deviceId+'/revoke',{method:'POST'});await assert.rejects(transport.resume({archive:identity,lastArchived:null}),/SYNC_HTTP_401/);
  const expired=await c.sync.createPairing();c.db.exec('UPDATE sync_pairings SET expires_at=0');assert.throws(()=>c.sync.pair(expired.pairingId,identity),/INVALID_PAIRING/);
 }finally{a.close();await c.close();}
});
test('cloud chats normally while Windows is offline; reconnect incrementally archives messages in authoritative order',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  const first=await emit(c,undefined,'first synthetic user');await emit(c,first.conversationId,'second synthetic user');assert.equal(c.db.prepare('SELECT count(*) AS n FROM chat_messages').get()!.n,4);
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,0);const p=await pair(c,a);const runner=new SyncRunner(a,new HttpSyncTransport(c.base,p.token),{batchSize:1});const result=await catchUp(runner);assert.equal(result.ackSeq,4);
  assert.deepEqual(a.db.prepare('SELECT message_seq,content FROM archive_messages ORDER BY message_seq').all().map(r=>[r.message_seq,r.content]),[[1,'first synthetic user'],[2,'synthetic reply'],[3,'second synthetic user'],[4,'synthetic reply']]);
  const originals=c.db.prepare('SELECT id,content_hash FROM chat_messages ORDER BY id').all();assert.deepEqual(a.db.prepare('SELECT id,content_hash FROM archive_messages ORDER BY id').all(),originals);
  assert.equal(device(c,p.deviceId).ack_seq,4);assert.equal(c.db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n,4);assert.equal(await c.sync.canPrune(),false);
 }finally{a.close();await c.close();}
});
test('repeated and overlapping events are idempotent; same ID with altered header or body never advances the cursor',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  const first=await emit(c);await emit(c,first.conversationId);const events=allEvents(c);const id=String(c.db.prepare('SELECT producer_id FROM chat_archive_identity').get()!.producer_id);a.bindStream('chat:'+id);
  await a.commitBatch(events.slice(0,2));await a.commitBatch(events);for(let i=0;i<10;i++)await a.commitBatch(events);assert.equal((await a.cursor())!.contiguousSeq,4);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,4);
  const changed={...events[0],kind:'chat.message.deleted'};await assert.rejects(a.commitBatch([changed]),/EVENT_ID_CONFLICT/);assert.equal((await a.cursor())!.contiguousSeq,4);
  const changedBody={...events[0],payload:{...events[0].payload as object,content:'changed'}};await assert.rejects(a.commitBatch([changedBody]),/EVENT_HASH_MISMATCH/);
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_conflicts').get()!.n,2);
 }finally{a.close();await c.close();}
});
test('a failed local transaction rolls back messages, receipts and cursor, and sends no ACK',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  await emit(c);const p=await pair(c,a),transport=new HttpSyncTransport(c.base,p.token);let acks=0;
  a.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON archive_events BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  const runner=new SyncRunner(a,wrap(transport,{acknowledge:async cursor=>{acks++;return transport.acknowledge(cursor);}}));await assert.rejects(runner.syncOnce());assert.equal(acks,0);assert.equal((await a.cursor())!.contiguousSeq,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,0);assert.equal(device(c,p.deviceId).ack_seq,0);
  a.db.exec('DROP TRIGGER fail_receipt');await catchUp(runner);assert.equal(device(c,p.deviceId).ack_seq,2);
 }finally{a.close();await c.close();}
});
test('ACK loss before reaching cloud persists local commit and retry backoff; reopening safely replays from cloud ACK',async()=>{
 const dir=temporaryDirectory(),c=await cloud();let a=new LocalArchive(join(dir,'archive.db'));try{
  await emit(c);const p=await pair(c,a),transport=new HttpSyncTransport(c.base,p.token);const runner=new SyncRunner(a,wrap(transport,{acknowledge:async()=>{throw new TransportError('SYNC_NETWORK_UNAVAILABLE');}}),{now:()=>1000,random:()=>1,retryBaseMs:200,retryMaxMs:800});
  await assert.rejects(runner.syncOnce());assert.equal((await a.cursor())!.contiguousSeq,2);assert.equal(device(c,p.deviceId).ack_seq,0);assert.equal(a.retryState().nextRetryAt,1200);a.close();a=new LocalArchive(join(dir,'archive.db'));assert.equal(a.retryState().failures,1);
  await catchUp(new SyncRunner(a,transport,{batchSize:1}));assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,2);assert.equal(device(c,p.deviceId).ack_seq,2);
 }finally{a.close();await c.close();rmSync(dir,{recursive:true});}
});
test('lost ACK response after durable cloud confirmation is harmless and duplicate ACKs cannot roll back progress',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{await emit(c);const p=await pair(c,a),t=new HttpSyncTransport(c.base,p.token);const broken=wrap(t,{acknowledge:async cursor=>{await t.acknowledge(cursor);throw new TransportError('SYNC_NETWORK_UNAVAILABLE');}});await assert.rejects(new SyncRunner(a,broken).syncOnce());assert.equal(device(c,p.deviceId).ack_seq,2);await catchUp(new SyncRunner(a,t));assert.equal((await t.acknowledge(await a.receiptAt(1))).ackSeq,2);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_events').get()!.n,2);}finally{a.close();await c.close();}
});
test('cloud rejects undelivered, fabricated and wrong-generation ACKs; unknown streams and cursor rollback require reconciliation',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{await emit(c);const p=await pair(c,a),t=new HttpSyncTransport(c.base,p.token),identity=await a.inspectIdentity();const resume=await t.resume({archive:identity,lastArchived:null});a.bindStream(resume.streamId);
  const events=allEvents(c);await a.commitBatch(events);await assert.rejects(t.acknowledge(await a.receiptAt(2)),/SYNC_HTTP_409/);await t.pull(0,50);await assert.rejects(t.acknowledge({...await a.receiptAt(2),lastPayloadHash:'0'.repeat(64)}),/SYNC_HTTP_409/);await assert.rejects(t.acknowledge({...await a.receiptAt(2),archive:{...identity,restoreGeneration:randomUUID()}}),/SYNC_HTTP_409/);await t.acknowledge(await a.receiptAt(2));
  const behind=await t.resume({archive:identity,lastArchived:await a.receiptAt(1)});assert.equal(behind.status,'reconcile-required');if(behind.status==='reconcile-required')assert.equal(behind.reason,'cursor-behind');
  assert.equal((await t.resume({archive:identity,lastArchived:{...await a.receiptAt(2),streamId:'chat:'+randomUUID()}})).status,'reconcile-required');
 }finally{a.close();await c.close();}
});
test('network outage persists retry state and a later reconnect archives the backlog without touching models',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{await emit(c);const p=await pair(c,a),t=new HttpSyncTransport(c.base,p.token);let online=false;
  const runner=new SyncRunner(a,wrap(t,{resume:request=>online?t.resume(request):Promise.reject(new TransportError('SYNC_NETWORK_UNAVAILABLE'))}),{now:()=>1000,random:()=>1,retryBaseMs:100,retryMaxMs:400});
  await assert.rejects(runner.syncOnce());assert.equal(a.retryState().phase,'offline');assert.equal(a.retryState().nextRetryAt,1100);await emit(c);online=true;const attempts=c.db.prepare('SELECT count(*) AS n FROM chat_attempts').get()!.n;await catchUp(runner);assert.equal((await a.cursor())!.contiguousSeq,4);assert.equal(c.db.prepare('SELECT count(*) AS n FROM chat_attempts').get()!.n,attempts);
 }finally{a.close();await c.close();}
});
test('cloud restart preserves stable event IDs, device credentials and ACK cursor',async()=>{
 const dir=temporaryDirectory(),file=join(dir,'cloud.db');let c=await cloud(file);const a=new LocalArchive(':memory:');try{
  const sent=await emit(c);const p=await pair(c,a);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));const original=allEvents(c).map(e=>e.eventId);await c.close();c=await cloud(file);assert.deepEqual(allEvents(c).map(e=>e.eventId),original);assert.equal(device(c,p.deviceId).ack_seq,2);await emit(c,sent.conversationId);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));assert.equal((await a.cursor())!.contiguousSeq,4);
 }finally{a.close();await c.close();rmSync(dir,{recursive:true});}
});
test('chat edit and soft deletion sync as versions while raw text remains preserved and hidden from future context',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  const sent=await emit(c,undefined,'original user');const messageId=sent.messageId;const requestId=randomUUID();const change={baseRevision:1,requestId,content:'edited user'};
  for(let i=0;i<2;i++)assert.equal((await c.owner(c.base+'/api/chat/messages/'+messageId,{method:'PATCH',body:JSON.stringify(change)})).status,200);
  assert.equal((await c.owner(c.base+'/api/chat/messages/'+messageId,{method:'PATCH',body:JSON.stringify({...change,content:'conflict'})})).status,409);
  const deletion={baseRevision:2,requestId:randomUUID()};for(let i=0;i<2;i++)assert.equal((await c.owner(c.base+'/api/chat/messages/'+messageId,{method:'DELETE',body:JSON.stringify(deletion)})).status,200);
  assert.equal(c.db.prepare('SELECT content FROM chat_messages WHERE id=?').get(messageId)!.content,'original user');assert.ok(c.db.prepare('SELECT deleted_at FROM chat_message_state WHERE message_id=?').get(messageId)!.deleted_at);
  const history=await(await c.owner(c.base+'/api/chat/conversations/'+sent.conversationId+'/messages')).json();assert.equal(history.items.length,1);
  const p=await pair(c,a);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));assert.equal(a.db.prepare('SELECT content FROM archive_messages WHERE id=?').get(messageId)!.content,'original user');const state=a.db.prepare('SELECT * FROM archive_message_state WHERE message_id=?').get(messageId)!;assert.equal(state.revision,3);assert.equal(state.content,'edited user');assert.ok(state.deleted_at);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_events').get()!.n,4);
 }finally{a.close();await c.close();}
});
test('memory, diary, dream and activity create/update/delete events preserve revision history and tombstones',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  const fixtures={memories:{content:'synthetic memory',type:'fact',importance:3},diaries:{date:'2026-10-15',content:'synthetic diary'},dreams:{date:'2026-10-15',content:'synthetic dream',source:'user'},activities:{time:'2026-10-15T00:00:00.000Z',type:'test',content:'synthetic activity'}};
  for(const[resource,body]of Object.entries(fixtures)){
   const response=await c.owner(c.base+'/api/'+resource,{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,201);const record=await response.json();
   const mutation={baseRevision:1,requestId:randomUUID(),record:{...record,content:'edited synthetic record'}};
   for(let i=0;i<2;i++)assert.equal((await c.owner(c.base+'/api/'+resource+'/'+record.id,{method:'PUT',body:JSON.stringify(mutation)})).status,200);
   assert.equal((await c.owner(c.base+'/api/'+resource+'/'+record.id,{method:'DELETE'})).status,204);
  }
  const p=await pair(c,a);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token),{batchSize:2}));assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_records').get()!.n,4);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_record_versions').get()!.n,12);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_records WHERE deleted_at IS NOT NULL AND revision=3').get()!.n,4);
 }finally{a.close();await c.close();}
});
test('legacy record snapshots are bootstrapped once, including previously soft-deleted records without fabricated history',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  c.db.prepare('INSERT INTO diaries VALUES (?,?,?)').run('legacy-diary','2026-01-01','synthetic legacy');c.db.prepare("INSERT INTO record_metadata VALUES ('diaries',?,3,'legacy_unverified',?)").run('legacy-diary','2026-01-02T00:00:00Z');
  const p=await pair(c,a);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));const row=a.db.prepare('SELECT revision,deleted_at FROM archive_records').get()!;assert.equal(row.revision,3);assert.ok(row.deleted_at);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_record_versions').get()!.n,1);
 }finally{a.close();await c.close();}
});
test('restored local backup gets a new generation, stops old credentials, then explicit revoke and re-pair safely replay the complete backlog',async()=>{
 const dir=temporaryDirectory(),c=await cloud();let a=new LocalArchive(join(dir,'live','archive.db'));let restored:LocalArchive|undefined;
 try{
  const first=await emit(c),p=await pair(c,a),oldIdentity=await a.inspectIdentity();await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));const snapshot=await createBackup(a.filename,join(dir,'backups'));await verifyBackup(snapshot);
  await emit(c,first.conversationId);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));assert.equal(device(c,p.deviceId).ack_seq,4);
  const filename=await restoreBackup(snapshot,join(dir,'restored'));restored=new LocalArchive(filename);assert.equal((await restored.inspectIdentity()).archiveId,oldIdentity.archiveId);assert.notEqual((await restored.inspectIdentity()).restoreGeneration,oldIdentity.restoreGeneration);
  await assert.rejects(new SyncRunner(restored,new HttpSyncTransport(c.base,p.token)).syncOnce(),/RECONCILE_restore-generation-changed/);assert.equal(device(c,p.deviceId).ack_seq,4);assert.equal((await restored.cursor())!.contiguousSeq,2);
  await c.sync.revoke(p.deviceId);const fresh=await pair(c,restored);await catchUp(new SyncRunner(restored,new HttpSyncTransport(c.base,fresh.token),{batchSize:1}));assert.equal((await restored.cursor())!.contiguousSeq,4);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,4);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,4);assert.ok(JSON.parse(readFileSync(join(dir,'restored','restore-info.json'),'utf8')).requiresArchiveReconciliation);
 }finally{restored?.close();a.close();await c.close();rmSync(dir,{recursive:true});}
});
test('an old database copied without a restore marker still cannot reuse an acknowledged higher cloud watermark',async()=>{
 const dir=temporaryDirectory(),c=await cloud();const a=new LocalArchive(join(dir,'live','archive.db'));let old:LocalArchive|undefined;
 try{const first=await emit(c),p=await pair(c,a);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));const snapshot=await createBackup(a.filename,join(dir,'backups'));await emit(c,first.conversationId);await catchUp(new SyncRunner(a,new HttpSyncTransport(c.base,p.token)));mkdirSync(join(dir,'copy'));copyFileSync(join(snapshot,'database.sqlite'),join(dir,'copy','archive.db'));old=new LocalArchive(join(dir,'copy','archive.db'));await assert.rejects(new SyncRunner(old,new HttpSyncTransport(c.base,p.token)).syncOnce(),/RECONCILE_cursor-behind/);assert.equal(device(c,p.deviceId).ack_seq,4);
 }finally{old?.close();a.close();await c.close();rmSync(dir,{recursive:true});}
});
test('unknown event kinds, missing sequence and reverse ordering fail closed with forensic evidence',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{await emit(c);const events=allEvents(c);a.bindStream('chat:'+events[0].producerId);await assert.rejects(a.commitBatch([events[1]]),/EVENT_GAP/);await assert.rejects(a.commitBatch([{...events[0],kind:'future.unknown'}]),/EVENT_KIND_UNSUPPORTED/);await assert.rejects(a.commitBatch([events[1],events[0]]));assert.equal((await a.cursor())!.contiguousSeq,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_events').get()!.n,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_conflicts').get()!.n,3);
 }finally{a.close();await c.close();}
});
test('actual local process termination before COMMIT leaves no receipt or cursor advancement; replay recovers',async()=>{
 const dir=temporaryDirectory(),c=await cloud();let a=new LocalArchive(join(dir,'archive.db'));try{
  await emit(c);const events=allEvents(c);a.bindStream('chat:'+events[0].producerId);a.close();const eventsFile=join(dir,'events.json');writeFileSync(eventsFile,JSON.stringify(events));
  const script=`import {LocalArchive} from ${JSON.stringify(new URL('../../local-agent/src/archive.ts',import.meta.url).href)};import{readFileSync}from'node:fs';const archive=new LocalArchive(${JSON.stringify(join(dir,'archive.db'))});await archive.commitBatch(JSON.parse(readFileSync(${JSON.stringify(eventsFile)},'utf8')),{beforeCommit:()=>process.exit(77)});`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',timeout:15000});assert.equal(child.status,77,child.stderr);a=new LocalArchive(join(dir,'archive.db'));assert.equal((await a.cursor())!.contiguousSeq,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_messages').get()!.n,0);await a.commitBatch(events);assert.equal((await a.cursor())!.contiguousSeq,2);
 }finally{a.close();await c.close();rmSync(dir,{recursive:true});}
});
test('v3 to v4 migration preserves all historical chat/outbox IDs and ledger rows, and failed migration rolls back',async()=>{
 const dir=temporaryDirectory(),file=join(dir,'v3.db');try{
  const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');migrate(db,migrations.slice(0,3));const store=new ChatStore(db),id=randomUUID();store.createConversation(id,'legacy synthetic');await store.accept({conversationId:id,clientMessageId:randomUUID(),content:'historical synthetic'});const before=databaseFingerprint(db),messages=db.prepare('SELECT * FROM chat_messages').all(),outbox=db.prepare('SELECT * FROM chat_outbox').all();
  assert.throws(()=>migrate(db,undefined,{afterStep:v=>{if(v===4)throw new Error('v4 injected failure');}}),/v4 injected failure/);assert.equal(databaseFingerprint(db),before);assert.equal(schemaVersion(db),3);db.close();
  const result=await upgradeDatabase(file,join(dir,'backups'));assert.ok(result.rehearsalDatabase);await verifyBackup(result.backupDirectory!);const ready=openDatabase(file);assert.equal(schemaVersion(ready),latestVersion);assert.deepEqual(ready.prepare('SELECT * FROM chat_messages').all(),messages);assert.deepEqual(ready.prepare('SELECT * FROM chat_outbox').all(),outbox);ready.close();assert.deepEqual(await upgradeDatabase(file,join(dir,'backups')),{changed:false});
 }finally{rmSync(dir,{recursive:true});}
});
test('sync transport requires HTTPS outside loopback and never follows redirects or exposes credentials in errors',async()=>{
 assert.equal(cloudUrl('http://127.0.0.1:1234'),'http://127.0.0.1:1234');assert.throws(()=>cloudUrl('http://example.com'));assert.throws(()=>cloudUrl('https://user:password@example.com'));assert.throws(()=>cloudUrl('https://example.com/?token=fake'));
 const transport=new BaseHttpSyncTransport('http://127.0.0.1:3100','synthetic-token',async(_url,init)=>{assert.equal(init!.redirect,'error');throw new Error('raw transport contains synthetic credential');});
 await assert.rejects(transport.resume({archive:{archiveId:randomUUID(),restoreGeneration:randomUUID()},lastArchived:null}),(error:unknown)=>error instanceof TransportError&&error.message==='SYNC_NETWORK_UNAVAILABLE');
});

test('background runner automatically reconnects with durable backoff and exits on cancellation without model polling',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  await emit(c);const p=await pair(c,a),t=new HttpSyncTransport(c.base,p.token),controller=new AbortController();let tries=0;
  const wrapped=wrap(t,{resume:async request=>{if(++tries===1)throw new TransportError('SYNC_NETWORK_UNAVAILABLE');return t.resume(request);},acknowledge:async cursor=>{const result=await t.acknowledge(cursor);controller.abort();return result;}});
  const runner=new SyncRunner(a,wrapped,{retryBaseMs:5,retryMaxMs:20,pollMs:20});const timeout=setTimeout(()=>controller.abort(),3000);
  try{await runner.run(controller.signal);}finally{clearTimeout(timeout);}
  assert.ok(tries>=2);assert.equal(device(c,p.deviceId).ack_seq,2);assert.equal(a.retryState().phase,'caught-up');assert.equal(c.db.prepare('SELECT count(*) AS n FROM chat_attempts').get()!.n,1);
 }finally{a.close();await c.close();}
});
test('migration rehearsals reject accidental edits to historical CHAT tables, not just the original four modules',async()=>{
 const dir=temporaryDirectory(),file=join(dir,'cloud.db');try{const db=openDatabase(file);const store=new ChatStore(db);store.createConversation('synthetic-conversation','kept title');const {preservedTables,assertPreservedTables}=await import('../src/database/fingerprint.js');const before=preservedTables(db);db.exec("UPDATE chat_conversations SET title='unexpected mutation'");assert.throws(()=>assertPreservedTables(db,before),/pre-existing table: chat_conversations/);db.close();}finally{rmSync(dir,{recursive:true});}
});

test('an archive refuses a cloud database path without changing its contents or migration version',()=>{
 const dir=temporaryDirectory(),file=join(dir,'cloud.db');try{const db=openDatabase(file),before=databaseFingerprint(db);db.close();assert.throws(()=>new LocalArchive(file),/ARCHIVE_SCHEMA_MISMATCH/);const check=new DatabaseSync(file,{readOnly:true});assert.equal(databaseFingerprint(check),before);assert.equal(schemaVersion(check),latestVersion);check.close();}finally{rmSync(dir,{recursive:true});}
});

test('an HTTP permanent event gap blocks the runner without advancing local cursor or cloud ACK',async()=>{
 const c=await cloud(),a=new LocalArchive(':memory:');try{
  await emit(c);const p=await pair(c,a);
  c.db.prepare('DELETE FROM chat_outbox WHERE stream_seq=1').run(); // Synthetic corruption only.
  const transport=new HttpSyncTransport(c.base,p.token),runner=new SyncRunner(a,transport);
  await assert.rejects(runner.syncOnce(),(e:unknown)=>e instanceof TransportError&&e.code==='SYNC_HTTP_409'&&!e.retryable);
  assert.equal(a.retryState().phase,'blocked');assert.equal((await a.cursor())!.contiguousSeq,0);
  assert.equal(device(c,p.deviceId).ack_seq,0);assert.equal(a.db.prepare('SELECT count(*) AS n FROM archive_events').get()!.n,0);
  await assert.rejects(runner.run(new AbortController().signal),/SYNC_HTTP_409/);
 }finally{a.close();await c.close();}
});
