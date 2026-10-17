import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {initializeCloud,acceptanceCloud} from './cloud.mjs';
import {runAcceptance,validateScope,windowsPowerShellEnv} from './accept.mjs';
import {buildPackage} from './build-package.mjs';
const parent=resolve('..','sakie-ai-home-data');mkdirSync(parent,{recursive:true});
const root=mkdtempSync(join(parent,'https-acceptance-lab-'));
function dir(name){const p=join(root,name);mkdirSync(p);return p;}

test('deployment archive is allowlisted, hash-complete and contains no runtime secrets',()=>{
 const bundle=buildPackage({build:false});const manifest=JSON.parse(readFileSync(join(bundle.output,'manifest.json')));
 assert.ok(manifest.files.length>20);
 for(const item of manifest.files){assert.ok(!item.path.includes('..'));assert.ok(!/node_modules|\/test\/|owner\.json|login-secret|\.db$|\.pem$/.test(item.path));if(item.path.endsWith('.env')){assert.equal(item.path,'acceptance.env');assert.equal(readFileSync(join(bundle.output,item.path),'utf8'),`ACCEPTANCE_RUN_ID=${bundle.runId}\nPUBLIC_ORIGIN=https://sync-check.sakiehome.icu\n`);}assert.equal(createHash('sha256').update(readFileSync(join(bundle.output,item.path))).digest('hex'),item.sha256);}
 assert.equal(createHash('sha256').update(readFileSync(bundle.archive)).digest('hex'),bundle.sha256);
 const paths=execFileSync('tar',['-tzf',bundle.archive],{encoding:'utf8'}).split('\n').filter(Boolean);assert.ok(paths.every(p=>!p.startsWith('/')&&!p.split('/').includes('..')));
 const compose=JSON.parse(readFileSync(join(bundle.output,'compose.json')));assert.deepEqual(compose.services.cloud.ports,['127.0.0.1:3301:3000']);assert.equal(compose.networks.isolated.internal,true);assert.equal(compose.services.cloud.volumes[1].read_only,true);assert.equal(compose.services.initialize.network_mode,'none');
 const nginx=readFileSync(join(bundle.output,'nginx.conf'),'utf8');assert.match(nginx,/server_name sync-check\.sakiehome\.icu/);assert.ok(!nginx.includes('phos.sakiehome.icu'));console.log(JSON.stringify({bundle:bundle.output,files:manifest.files.length,sha256:bundle.sha256}));
});
test('cloud refuses unknown DB, repeat init and missing initialized DB without adoption',async()=>{
 const data=dir('guard-cloud'),identity=dir('guard-identity'),runId=randomUUID();
 await initializeCloud({data,identity,runId});await assert.rejects(initializeCloud({data,identity,runId}));
 writeFileSync(join(data,'cloud.db'),'not a database');const before=readFileSync(join(data,'cloud.db'));
 await assert.rejects(acceptanceCloud({data,identity,runId,origin:'https://example.invalid'}),/Unadopted database/);assert.deepEqual(readFileSync(join(data,'cloud.db')),before);
 const missing=dir('missing-db');writeFileSync(join(missing,'synthetic-marker.json'),JSON.stringify({kind:'sakie-synthetic-https-sync-v1',runId,initializedDatabase:true}));await assert.rejects(acceptanceCloud({data:missing,identity,runId,origin:'https://example.invalid'}),/Expected database missing/);
});
test('wrong service marker stops before requesting password or creating an archive',async()=>{
 const windows=dir('wrong-target'),origin='https://127.0.0.1:3443';writeFileSync(join(windows,'sync-policy.local.json'),JSON.stringify({version:1,environment:'test',allowedOrigins:[origin]}));let passwords=0,requests=0;
 await assert.rejects(runAcceptance({environment:'test',origin,runId:randomUUID()},{dir:windows,password:async()=>{passwords++;return 'unused';},fetcher:async()=>{requests++;return new Response(JSON.stringify({kind:'wrong'}));}}));assert.equal(passwords,0);assert.equal(requests,1);assert.equal(existsSync(join(windows,'archive.db')),false);
});
test('production target/approval blocks before network; old evidence is not reused',async()=>{
 const windows=dir('approval'),origin='https://sync-check.sakiehome.icu',config={environment:'production',origin,runId:randomUUID()};writeFileSync(join(windows,'sync-policy.local.json'),JSON.stringify({version:1,environment:'production',allowedOrigins:[origin]}));let calls=0;
 await assert.rejects(runAcceptance(config,{dir:windows,fetcher:async()=>{calls++;throw Error();}}));assert.equal(calls,0);
 assert.throws(()=>validateScope({...config,origin:'https://phos.sakiehome.icu'},windows));writeFileSync(join(windows,'result.json'),'preserved');assert.throws(()=>validateScope(config,windows));assert.equal(readFileSync(join(windows,'result.json'),'utf8'),'preserved');
});
test('Windows helper parses and rejects nonprivate scope without ACL writes',()=>{
 const command='$errors=$null;$tokens=$null; foreach($p in @("tools/https-sync/check-private.ps1","tools/https-sync/prepare-windows.ps1")){[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $p),[ref]$tokens,[ref]$errors) | Out-Null;if($errors.Count){exit 1}};Write-Output "PARSE_PASS"';
 assert.match(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8'}),/PARSE_PASS/);
 const scope=dir('nonprivate-scope');assert.throws(()=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File','tools/https-sync/check-private.ps1','-Path',scope],{stdio:'pipe'}));
 assert.equal(existsSync(join(scope,'archive.db')),false);
});
test('Windows preparation clears stale native exit status via isolated checker process',()=>{
 const sandbox=dir('prepare-exit-regression'),scripts=join(sandbox,'project','tools','https-sync'),oldRun=join(sandbox,'old-run'),newRun=join(sandbox,'new-run');
 for(const p of [scripts,oldRun,newRun])mkdirSync(p,{recursive:true});
 const fixed=readFileSync('tools/https-sync/prepare-windows.ps1','utf8');
 const old=fixed.replace('& powershell.exe -NoProfile -NonInteractive -File "$PSScriptRoot\\check-private.ps1" -Path $RunDirectory','& "$PSScriptRoot\\check-private.ps1" -Path $RunDirectory');
 assert.notEqual(old,fixed);
 writeFileSync(join(scripts,'old.ps1'),old);writeFileSync(join(scripts,'fixed.ps1'),fixed);
 // Stub ONLY in this new synthetic sandbox; production ACL gate is never replaced.
 writeFileSync(join(scripts,'check-private.ps1'),'param([string]$Path)\nWrite-Output "SYNTHETIC_CHECK_PASS"\n');
 const template=join(sandbox,'template.json');writeFileSync(template,JSON.stringify({version:1,environment:'production',origin:'https://sync-check.sakiehome.icu',runId:randomUUID()}));
 const launch=(script,run)=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"& cmd.exe /c exit 7; & '"+script+"' -RunDirectory '"+run+"' -Template '"+template+"'; if($LASTEXITCODE -ne 0){exit 1}"],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 assert.throws(()=>launch(join(scripts,'old.ps1'),oldRun));assert.equal(existsSync(join(oldRun,'run.json')),false);
 assert.match(launch(join(scripts,'fixed.ps1'),newRun),/Private run files prepared/);assert.equal(JSON.parse(readFileSync(join(newRun,'run.json'))).environment,'production');
});
test('Windows PowerShell ACL module loads with a clean child module path',()=>{
 const scope=dir('module-discovery');const original=process.env.PSModulePath;const clean=windowsPowerShellEnv();assert.ok(!Object.keys(clean).some(k=>k.toLowerCase()==='psmodulepath'));assert.equal(process.env.PSModulePath,original);
 const command="$a=Get-Acl -LiteralPath '"+scope+"';if($null -eq $a){exit 1};Write-Output 'ACL_MODULE_PASS'";
 assert.match(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',env:clean,stdio:['ignore','pipe','pipe']}),/ACL_MODULE_PASS/);
});
test('Windows Agent over verified TLS: CLI, reconnect, lost ACK, process restart and revoke',{timeout:60000},async()=>{
 const fixture=dir('tls-case'),runId=randomUUID();for(const p of ['cloud','identity','windows'])mkdirSync(join(fixture,p));await initializeCloud({data:join(fixture,'cloud'),identity:join(fixture,'identity'),runId});
 const openssl='E:\\Git\\usr\\bin\\openssl.exe';assert.ok(existsSync(openssl),'OpenSSL required; no silent skip');
 execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(fixture,'key.pem'),'-out',join(fixture,'cert.pem'),'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const env={...process.env,SAKIE_HTTPS_FIXTURE:'1',HTTPS_FIXTURE_ROOT:fixture,HTTPS_FIXTURE_RUN_ID:runId,NODE_TLS_REJECT_UNAUTHORIZED:'1',NODE_EXTRA_CA_CERTS:join(fixture,'cert.pem')};let cloud,worker,port=0;
 const launch=(file,extra={})=>spawn(process.execPath,[join('tools/https-sync',file)],{env:{...env,...extra},stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 async function start(){cloud=launch('tls-fixture.mjs',{HTTPS_FIXTURE_PORT:String(port)});const ready=await Promise.race([once(cloud,'message').then(([m])=>m),once(cloud,'exit').then(()=>{throw Error('TLS server exited');})]);port=ready.port;return ready.origin;}
 const stop=async child=>{if(child&&child.exitCode===null){child.kill();await once(child,'exit');}};
 try{
  const origin=await start();await assert.rejects(fetch(origin+'/api/health')); // Parent does not trust the fixture CA.
  writeFileSync(join(fixture,'windows','sync-policy.local.json'),JSON.stringify({version:1,environment:'test',allowedOrigins:[origin]}));
  worker=launch('accept-worker.mjs',{HTTPS_FIXTURE_ORIGIN:origin});
  const result=await new Promise((ok,fail)=>{
   const timer=setTimeout(()=>fail(Error('HTTPS worker timed out')),40000);
   worker.on('message',async m=>{if(m.restart){try{await stop(cloud);await start();worker.send({restarted:true});}catch(e){clearTimeout(timer);fail(e);}}else if(m.evidence){clearTimeout(timer);ok(m.evidence);}else if(m.failed){clearTimeout(timer);fail(Error('HTTPS worker failed; inspect private fixture result'));}});
   worker.on('exit',code=>{if(code){clearTimeout(timer);fail(Error('HTTPS worker exited'));}});
  });
  assert.equal(result.passed,true);assert.equal(result.scenarios.length,6);assert.equal(result.disposableDeviceRevoked,true);assert.equal(result.ackSeq,6);
  await stop(cloud);cloud=undefined;const db=new DatabaseSync(join(fixture,'cloud','cloud.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare('SELECT count(*) n FROM chat_messages').get().n,6);assert.equal(db.prepare('SELECT count(*) n FROM chat_attempts').get().n,3);assert.equal(db.prepare('SELECT ack_seq FROM sync_devices').get().ack_seq,6);assert.ok(db.prepare('SELECT revoked_at FROM sync_devices').get().revoked_at);}finally{db.close();}
  writeFileSync(join(fixture,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({evidence:'verified-TLS-real-Agent-CLI-and-cloud-processes',...result}));
 }finally{await stop(worker);await stop(cloud);}
});
