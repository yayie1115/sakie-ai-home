import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync,linkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {temporaryDirectory} from './helpers.js';
import {authorizeOrigin,parseNetworkPolicy,createProductionApproval,productionPhrase,defaultTestPolicy,type RuntimeNetworkPolicy} from '../../local-agent/src/network-policy.js';
import {HttpSyncTransport} from '../../local-agent/src/transport.js';
import {repositoryRoot} from '../src/config/env.js';

test('default sync transport rejects production, alternate loopback ports and host spellings before fetch',()=>{
 let calls=0;const trap:typeof fetch=async()=>{calls++;throw new Error('must not call');};
 for(const origin of ['https://sakiehome.icu','https://example.invalid','http://127.0.0.1:9999','http://localhost:3000','http://127.1:3000','http://2130706433:3000','https://*.example.com','https://example.com.'])assert.throws(()=>new HttpSyncTransport(origin,'fake',trap));
 assert.equal(calls,0);assert.equal(authorizeOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000');
});
test('test policy only admits an exact independently listed literal-loopback origin',()=>{
 const p=parseNetworkPolicy({version:1,environment:'test',allowedOrigins:['http://127.0.0.1:3199']});assert.equal(authorizeOrigin('http://127.0.0.1:3199',p),'http://127.0.0.1:3199');
 for(const origin of ['http://127.0.0.1:3200','http://[::1]:3199','https://127.0.0.1:3199'])assert.throws(()=>authorizeOrigin(origin,p),/NOT_ALLOWLISTED/);
 for(const origin of ['https://sakiehome.icu','http://localhost:3199'])assert.throws(()=>parseNetworkPolicy({version:1,environment:'test',allowedOrigins:[origin]}));
 for(const bad of [null,{}, {version:1,environment:'production',allowedOrigins:['http://example.com']},{version:1,environment:'test',allowedOrigins:['http://127.0.0.1:3000','http://127.0.0.1:3000']}])assert.throws(()=>parseNetworkPolicy(bad));
});
test('production requires manual phrase and binds approval to exact origin, policy and physical local paths',async()=>{
 const dir=temporaryDirectory(),origin='https://sync.example.invalid';const p=parseNetworkPolicy({version:1,environment:'production',allowedOrigins:[origin]});const binding={database:join(dir,'archive.db'),credentials:join(dir,'agent-credentials.json')};
 assert.throws(()=>authorizeOrigin(origin,p),/APPROVAL_REQUIRED/);assert.throws(()=>createProductionApproval(p,origin,binding,'yes'),/CONFIRMATION_MISMATCH/);
 const approval=createProductionApproval(p,origin,binding,productionPhrase(origin));const runtime:RuntimeNetworkPolicy={...p,approval,binding};assert.equal(authorizeOrigin(origin,runtime),origin);
 assert.throws(()=>authorizeOrigin(origin,{...runtime,binding:{...binding,credentials:join(dir,'different.json')}}),/BINDING_MISMATCH/);
 assert.throws(()=>authorizeOrigin(origin,{...runtime,allowedOrigins:[origin,'https://other.example.invalid']}),/APPROVAL_MISMATCH/);
 assert.throws(()=>authorizeOrigin(origin,{...runtime,approval:{...approval,origin:'https://other.example.invalid'}}),/APPROVAL_MISMATCH/);
 let calls=0;const mock:typeof fetch=async(input,init)=>{calls++;assert.equal(String(input),origin+'/api/sync/resume');assert.equal(init!.redirect,'error');return new Response(JSON.stringify({status:'resume'}));};
 await new HttpSyncTransport(origin,'synthetic',mock,1000,runtime).resume({archive:{archiveId:randomUUID(),restoreGeneration:randomUUID()},lastArchived:null});assert.equal(calls,1); // Mock only: no DNS, socket or production request.
});
test('policy is rechecked before each request, so changing its allowlist prevents any fetch',async()=>{
 const policy:RuntimeNetworkPolicy={version:1,environment:'test',allowedOrigins:['http://127.0.0.1:3100']};let calls=0;const transport=new HttpSyncTransport('http://127.0.0.1:3100','fake',async()=>{calls++;return new Response('{}');},1000,policy);policy.allowedOrigins=['http://127.0.0.1:3000'];
 await assert.rejects(transport.resume({archive:{archiveId:randomUUID(),restoreGeneration:randomUUID()},lastArchived:null}),/NOT_ALLOWLISTED/);assert.equal(calls,0);
});
test('redirect responses fail without a follow-up request or credential forwarding',async()=>{
 let calls=0;const transport=new HttpSyncTransport('http://127.0.0.1:3100','synthetic',async(_input,init)=>{calls++;assert.equal(init!.redirect,'error');return new Response('',{status:302,headers:{Location:'https://sakiehome.icu/api/sync/pull'}});});await assert.rejects(transport.resume({archive:{archiveId:randomUUID(),restoreGeneration:randomUUID()},lastArchived:null}),/SYNC_HTTP_302/);assert.equal(calls,1);
});
async function cli(args:string[]){const child=spawn(process.execPath,['--import','tsx',join(repositoryRoot,'local-agent/src/cli.ts'),...args],{cwd:repositoryRoot,env:{...process.env,DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:''},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill(),15000);const[code]=await once(child,'exit');clearTimeout(timer);return{code,stdout,stderr};}
test('CLI rejects legacy/environment mismatches and production targets before creating archives or contacting a server',async()=>{
 const dir=temporaryDirectory(),db=join(dir,'must-not-create.db'),creds=join(dir,'agent-credentials.json');let requests=0;const server=createServer((_req,res)=>{requests++;res.end('{}');}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const local='http://127.0.0.1:'+address.port;
 try{
  writeFileSync(creds,JSON.stringify({cloud:local,token:'synthetic-secret',database:db}));const legacy=await cli(['once','--credentials',creds]);assert.equal(legacy.code,1);assert.match(legacy.stderr,/ENVIRONMENT_MISMATCH/);
  writeFileSync(creds,JSON.stringify({version:2,environment:'production',cloud:local,token:'synthetic-secret',database:db}));assert.match((await cli(['once','--credentials',creds])).stderr,/ENVIRONMENT_MISMATCH/);
  writeFileSync(creds,JSON.stringify({version:2,environment:'test',cloud:'https://sakiehome.icu',token:'synthetic-secret',database:db}));const bad=await cli(['once','--credentials',creds]);assert.match(bad.stderr,/NOT_ALLOWLISTED/);assert.ok(!bad.stderr.includes('synthetic-secret'));
  const pair=await cli(['pair','--cloud','https://sakiehome.icu','--database',db,'--credentials',join(dir,'new-creds.json'),'--pairing-code-file',join(dir,'nonexistent-secret.txt')]);assert.match(pair.stderr,/NOT_ALLOWLISTED/);
  assert.equal(requests,0);assert.equal(existsSync(db),false);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('production approval CLI refuses noninteractive confirmation without writing a file or opening a database',async()=>{
 const dir=temporaryDirectory(),policy=join(dir,'policy.json'),approval=join(dir,'approval.json'),db=join(dir,'none.db');writeFileSync(policy,JSON.stringify({version:1,environment:'production',allowedOrigins:['https://sync.example.invalid']}));const result=await cli(['approve-production','--policy',policy,'--cloud','https://sync.example.invalid','--database',db,'--credentials',join(dir,'creds.json'),'--approval',approval]);assert.equal(result.code,1);assert.match(result.stderr,/REQUIRES_TTY/);assert.equal(existsSync(approval),false);assert.equal(existsSync(db),false);
});
function ps(args:string[]){const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];env.PSModulePath=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');return spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',...args],{cwd:repositoryRoot,env,encoding:'utf8',timeout:30000,windowsHide:true});}
function parseResult(stdout:string){return JSON.parse(stdout.trim().split(String.fromCharCode(10)).filter(s=>s.trim().startsWith('{')).at(-1)!);}
test('Windows ACL plan, WhatIf, apply, verify, inherited future files and restore work only on isolated fixtures',{skip:process.platform!=='win32'},()=>{
 const dir=temporaryDirectory(),target=join(dir,'fixture'),plan=join(dir,'plan.json'),script=join(repositoryRoot,'tools/windows-acl.ps1');mkdirSync(target);const file=join(target,'.env');writeFileSync(file,'SYNTHETIC_ONLY=1');
 const before=ps(['-Command',"(Get-Acl -LiteralPath '"+file+"').Sddl"]);assert.equal(before.status,0);
 const planned=ps(['-File',script,'-Mode','Plan','-Targets',target,'-PlanPath',plan]);assert.equal(planned.status,0,planned.stderr);const hash=parseResult(planned.stdout).PlanHash;
 const invoke=(mode:string,extra='')=>ps(['-Command',"& '"+script+"' -Mode "+mode+" -PlanPath '"+plan+"' -ExpectedPlanHash '"+hash+"' "+extra]);
 const preview=invoke('Apply','-WhatIf');assert.equal(preview.status,0,preview.stderr);assert.equal(parseResult(preview.stdout).Executed,false);assert.equal(ps(['-Command',"(Get-Acl -LiteralPath '"+file+"').Sddl"]).stdout,before.stdout);
 const applied=invoke('Apply','-Confirm:$false');assert.equal(applied.status,0,applied.stderr);assert.equal(parseResult(applied.stdout).Verified,true);
 const verify=ps(['-File',script,'-Mode','Verify','-Targets',target]);assert.equal(verify.status,0,verify.stderr);assert.equal(parseResult(verify.stdout).Passed,true);
 const restored=invoke('Restore','-Confirm:$false');assert.equal(restored.status,0,restored.stderr);assert.equal(ps(['-Command',"(Get-Acl -LiteralPath '"+file+"').Sddl"]).stdout,before.stdout);
 assert.equal(readFileSync(file,'utf8'),'SYNTHETIC_ONLY=1');
});
test('Windows ACL rejects changed inventories, content changes and a wrong reviewed hash before changing permissions',{skip:process.platform!=='win32'},()=>{
 const dir=temporaryDirectory(),target=join(dir,'fixture'),plan=join(dir,'plan.json'),script=join(repositoryRoot,'tools/windows-acl.ps1');mkdirSync(target);const file=join(target,'test.txt');writeFileSync(file,'synthetic');const planned=ps(['-File',script,'-Mode','Plan','-Targets',target,'-PlanPath',plan]);assert.equal(planned.status,0,planned.stderr);const hash=parseResult(planned.stdout).PlanHash;
 const wrong=ps(['-Command',"& '"+script+"' -Mode Apply -PlanPath '"+plan+"' -ExpectedPlanHash '"+'0'.repeat(64)+"' -Confirm:$false"]);assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/HASH_REQUIRED/);
 writeFileSync(file,'changed synthetic content');const contentChanged=ps(['-Command',"& '"+script+"' -Mode Apply -PlanPath '"+plan+"' -ExpectedPlanHash '"+hash+"' -Confirm:$false"]);assert.notEqual(contentChanged.status,0);assert.match(contentChanged.stderr,/CONTENT_CHANGED/);
 writeFileSync(join(target,'new.txt'),'new fixture');const changed=ps(['-Command',"& '"+script+"' -Mode Apply -PlanPath '"+plan+"' -ExpectedPlanHash '"+hash+"' -Confirm:$false"]);assert.notEqual(changed.status,0);assert.match(changed.stderr,/INVENTORY_CHANGED/);
});

test('Windows ACL restricts newly created WAL/credential files and refuses unsafe root or junction targets',{skip:process.platform!=='win32'},()=>{
 const dir=temporaryDirectory(),target=join(dir,'fixture'),plan=join(dir,'plan.json'),script=join(repositoryRoot,'tools/windows-acl.ps1');mkdirSync(target);writeFileSync(join(target,'initial.db'),'synthetic db');const planned=ps(['-File',script,'-Mode','Plan','-Targets',target,'-PlanPath',plan]);assert.equal(planned.status,0,planned.stderr);const hash=parseResult(planned.stdout).PlanHash;
 const applied=ps(['-Command',"& '"+script+"' -Mode Apply -PlanPath '"+plan+"' -ExpectedPlanHash '"+hash+"' -Confirm:$false"]);assert.equal(applied.status,0,applied.stderr);
 writeFileSync(join(target,'initial.db-wal'),'synthetic wal');writeFileSync(join(target,'agent-credentials-fixture.json'),'synthetic only');const verify=ps(['-File',script,'-Mode','Verify','-Targets',target]);assert.equal(verify.status,0,verify.stderr);
 const changed=ps(['-Command',"& '"+script+"' -Mode Restore -PlanPath '"+plan+"' -ExpectedPlanHash '"+hash+"' -Confirm:$false"]);assert.notEqual(changed.status,0);assert.match(changed.stderr,/INVENTORY_CHANGED/);
 const volume=repositoryRoot.slice(0,3);const rootRejected=ps(['-File',script,'-Mode','Check','-Targets',volume]);assert.notEqual(rootRejected.status,0);assert.match(rootRejected.stderr,/ROOT_OR_STREAM/);
 const junction=join(dir,'junction');const created=ps(['-Command',"New-Item -ItemType Junction -Path '"+junction+"' -Target '"+target+"' | Out-Null"]);assert.equal(created.status,0,created.stderr);const rejected=ps(['-File',script,'-Mode','Plan','-Targets',junction,'-PlanPath',join(dir,'junction-plan.json')]);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/REPARSE_POINT/);unlinkSync(junction);assert.equal(existsSync(join(target,'initial.db')),true);const alias=join(dir,'hardlink');linkSync(join(target,'initial.db'),alias);try{const hard=ps(['-File',script,'-Mode','Check','-Targets',target]);assert.notEqual(hard.status,0);assert.match(hard.stderr,/HARDLINK/);}finally{unlinkSync(alias);}
});

test('Windows ACL equality ignores Allow order but preserves masks, flags, duplicates and Deny ordering',{skip:process.platform!=='win32'},()=>{
 const script=join(repositoryRoot,'tools/windows-acl.ps1');
 const result=ps(['-Command',`$ast=[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$null,[ref]$null); $f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'EquivalentDacl'},$true); . ([scriptblock]::Create($f.Extent.Text));
 $a='D:P(A;;FR;;;SY)(A;;FW;;;BA)'; $b='D:P(A;;FW;;;BA)(A;;FR;;;SY)';
 if(-not (EquivalentDacl $a $b)){throw 'ALLOW_ORDER'};
 foreach($bad in @('D:P(A;;FA;;;SY)(A;;FW;;;BA)','D:(A;;FR;;;SY)(A;;FW;;;BA)','D:P(A;ID;FR;;;SY)(A;;FW;;;BA)','D:P(A;;FR;;;SY)(A;;FW;;;BA)(A;;FW;;;BA)')){if(EquivalentDacl $a $bad){throw 'FALSE_EQUIVALENCE'}};
 if(EquivalentDacl 'D:P(D;;FW;;;SY)(A;;FA;;;SY)' 'D:P(A;;FA;;;SY)(D;;FW;;;SY)'){throw 'DENY_ORDER'}; Write-Output 'EQUALITY_OK'`]);
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/EQUALITY_OK/);
});

test('Windows ACL Apply accepts an isolated reviewed plan with equivalent Allow ACE order',{skip:process.platform!=='win32'},()=>{
 const dir=temporaryDirectory(),target=join(dir,'fixture'),plan=join(dir,'plan.json'),script=join(repositoryRoot,'tools/windows-acl.ps1');mkdirSync(target);writeFileSync(join(target,'only.txt'),'synthetic only');
 const planned=ps(['-File',script,'-Mode','Plan','-Targets',target,'-PlanPath',plan]);assert.equal(planned.status,0,planned.stderr);
 // Modify only this synthetic plan: original descriptors stay semantically identical.
 const reverse=ps(['-Command',`$p=Get-Content -LiteralPath '${plan}' -Raw|ConvertFrom-Json; foreach($e in $p.Entries){$r=[Security.AccessControl.RawSecurityDescriptor]::new($e.AccessSddl);foreach($ace in $r.DiscretionaryAcl){if($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed){throw 'FIXTURE_EXPECTS_ALLOW_ONLY'}};$d=[Security.AccessControl.RawAcl]::new($r.DiscretionaryAcl.Revision,$r.DiscretionaryAcl.Count);for($i=$r.DiscretionaryAcl.Count-1;$i -ge 0;$i--){$d.InsertAce($d.Count,$r.DiscretionaryAcl[$i])};$r.DiscretionaryAcl=$d;$e.AccessSddl=$r.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)};[IO.File]::WriteAllText('${plan}',($p|ConvertTo-Json -Depth 20));(Get-FileHash -LiteralPath '${plan}').Hash`]);assert.equal(reverse.status,0,reverse.stderr);const hash=reverse.stdout.trim();
 const applied=ps(['-Command',`& '${script}' -Mode Apply -PlanPath '${plan}' -ExpectedPlanHash '${hash}' -Confirm:$false`]);assert.equal(applied.status,0,applied.stderr);assert.equal(parseResult(applied.stdout).Verified,true);assert.equal(readFileSync(join(target,'only.txt'),'utf8'),'synthetic only');
});

test('Windows ACL preflights every object and denies Apply with zero mutations when a later object lacks WRITE_DAC',{skip:process.platform!=='win32'},()=>{
 const dir=temporaryDirectory(),target=join(dir,'fixture'),plan=join(dir,'plan.json'),script=join(repositoryRoot,'tools/windows-acl.ps1');mkdirSync(target);const good=join(target,'a-writable.txt'),bad=join(target,'z-denied.txt');writeFileSync(good,'synthetic good');writeFileSync(bad,'synthetic denied');
 // OWNER RIGHTS overrides the owner's implicit WRITE_DAC. No admin ownership changes.
 const setup=ps(['-Command',`$a=Get-Acl -LiteralPath '${bad}';$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),[Security.AccessControl.FileSystemRights]::ChangePermissions,[Security.AccessControl.AccessControlType]::Deny));Set-Acl -LiteralPath '${bad}' -AclObject $a`]);assert.equal(setup.status,0,setup.stderr);
 const planned=ps(['-File',script,'-Mode','Plan','-Targets',target,'-PlanPath',plan]);assert.equal(planned.status,0,planned.stderr);const hash=parseResult(planned.stdout).PlanHash;
 const snapshot=()=>ps(['-Command',`@('${target}','${good}','${bad}')|ForEach-Object{(Get-Acl -LiteralPath $_).Sddl}`]);const before=snapshot();assert.equal(before.status,0,before.stderr);
 const denied=ps(['-Command',`& '${script}' -Mode Apply -PlanPath '${plan}' -ExpectedPlanHash '${hash}' -Confirm:$false`]);assert.notEqual(denied.status,0);assert.match(denied.stderr,/WRITE_DAC_PREFLIGHT_FAILED_ZERO_CHANGES/);assert.ok(denied.stderr.includes('z-denied.txt'));assert.match(denied.stderr,/Win32=5/);assert.doesNotMatch(denied.stderr,/ROLLBACK/);
 const after=snapshot();assert.equal(after.status,0,after.stderr);assert.equal(after.stdout,before.stdout);assert.equal(existsSync(plan+'.apply.json'),false);assert.equal(readFileSync(good,'utf8'),'synthetic good');assert.equal(readFileSync(bad,'utf8'),'synthetic denied');
});