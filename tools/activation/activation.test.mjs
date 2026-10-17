import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';import {join,resolve} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {render} from './render.mjs';import {validateRun,retryDecision,acquireLock} from './agent-host.mjs';import {releaseCandidate,activationPhrase} from './release-candidate.mjs';
const syntheticSid=['S',1,5,21,111,222,333,444].join('-');
const root=mkdtempSync(resolve('.phase1-work','activation-tests-'));
test('runtime configuration preserves origin, durable stores, ordinary task and bounded resources',()=>{
 const c=render('https://home.example.invalid','E:\\node\\node.exe',syntheticSid);const b=c.compose.services.backend;
 assert.deepEqual(b.ports,['127.0.0.1:3401:3000']);assert.equal(b.restart,'unless-stopped');assert.equal(b.volumes[2].read_only,true);assert.equal(b.volumes[0].bind.create_host_path,false);assert.match(c.task,/<LogonType>InteractiveToken/);assert.match(c.task,/<RunLevel>LeastPrivilege/);assert.ok(!c.task.includes('Password'));assert.ok(!c.task.includes('<RestartOnFailure>'));assert.equal(validateRun(c.run),c.run);
 for(const origin of ['https://phos.sakiehome.icu','https://sync-check.sakiehome.icu','https://sakiehome.icu','http://example.invalid'])assert.throws(()=>render(origin,'node.exe',syntheticSid));
});
test('agent blocks unsafe paths and permanent failures; live locks not replaced, dead locks retain evidence',()=>{
 assert.throws(()=>validateRun({origin:'https://example.invalid',database:'E:\\sakie-ai-home-data\\cloud\\sakie.db'}));assert.equal(retryDecision({retry:{phase:'blocked'}}),'stop');assert.equal(retryDecision({retry:{phase:'offline'}}),'retry');
 const file=join(root,'host.lock');const first=acquireLock(file);assert.throws(()=>acquireLock(file,()=>true));first.release();writeFileSync(file,JSON.stringify({version:1,pid:987654,nonce:'synthetic'}));const next=acquireLock(file,()=>false);assert.equal(readdirSync(root).filter(x=>x.includes('.stale-')).length,1);next.release();writeFileSync(file,'corrupt');assert.throws(()=>acquireLock(file,()=>false));assert.equal(readFileSync(file,'utf8'),'corrupt');
});
test('restored candidate release requires fingerprint, fresh owner and no active devices',async()=>{
 const dir=join(root,'cloud');mkdirSync(dir);const file=join(dir,'candidate.db'),ownerFile=join(dir,'owner.json');
 const {migrate}=await import('../../backend/dist/database/migrations.js');const {databaseFingerprint}=await import('../../backend/dist/database/fingerprint.js');const {createOwnerCredential}=await import('../../backend/dist/modules/auth/credentials.js');
 const db=new DatabaseSync(file);migrate(db);writeFileSync(ownerFile,JSON.stringify(await createOwnerCredential('synthetic-test-owner-only')));const marker=join(dir,'restore-info.json');writeFileSync(marker,JSON.stringify({requiresSessionRevocation:true,requiresArchiveReconciliation:true}));
 const fingerprint=databaseFingerprint(db);const opts={database:file,ownerFile,expectedFingerprint:fingerprint,confirmation:activationPhrase};await assert.rejects(releaseCandidate({...opts,confirmation:'wrong'}));await assert.rejects(releaseCandidate({...opts,expectedFingerprint:'0'.repeat(64)}));
 const {SyncService}=await import('../../backend/dist/modules/sync/service.js');const sync=new SyncService(db);const p=await sync.createPairing();const paired=sync.pair(p.pairingId,{archiveId:'11111111-1111-4111-8111-111111111111',restoreGeneration:'22222222-2222-4222-8222-222222222222'});await assert.rejects(releaseCandidate({...opts,expectedFingerprint:databaseFingerprint(db)}),/Active devices/);await sync.revoke(paired.deviceId);
 const ready={...opts,expectedFingerprint:databaseFingerprint(db)};const proof=await releaseCandidate(ready);assert.equal(proof.sessions,'invalidated-by-new-owner-version');assert.equal(JSON.parse(readFileSync(marker)).requiresArchiveReconciliation,false);assert.equal(databaseFingerprint(db),ready.expectedFingerprint);await assert.rejects(releaseCandidate(ready));db.close();
});
