import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
const project=fileURLToPath(new URL('../../',import.meta.url));
export const expectedKind='sakie-synthetic-https-sync-v1';
// Windows PowerShell 5 must discover its own built-in modules, not inherited PowerShell 7 modules.
export function windowsPowerShellEnv(){const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];return env;}
const load=p=>import(pathToFileURL(join(project,'local-agent/dist',p)).href);
const hash=s=>createHash('sha256').update(s).digest('hex');
export function validateScope(config,dir){
  const origin=new URL(config.origin);
  if(origin.protocol!=='https:'||config.origin!==origin.origin||origin.username||origin.password||!config.runId?.match(/^[a-f0-9-]{36}$/))throw new Error('Invalid HTTPS acceptance scope');
  const rel=relative(realpathSync(project),realpathSync(dir));
  if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel))||lstatSync(dir).isSymbolicLink())throw new Error('Private run must be outside source');
  if(config.environment==='production'&&origin.origin!=='https://sync-check.sakiehome.icu')throw new Error('Unexpected remote acceptance target');
  if(!['test','production'].includes(config.environment))throw new Error('Invalid environment');
  for(const f of ['archive.db','agent-credentials-acceptance.json','result.json'])if(existsSync(join(dir,f)))throw new Error('Fresh run required; prior evidence is preserved');
  for(const name of readdirSync(dir))if(!['run.json','sync-policy.local.json','sync-production-approval.json'].includes(name)||lstatSync(join(dir,name)).isSymbolicLink())throw new Error('Unexpected run asset; no existing evidence is adopted');
}
export async function runAcceptance(config,{dir,password,restart,fetcher=fetch}={}){
  validateScope(config,dir);
  const {parseNetworkPolicy,authorizeOrigin}=await load('network-policy.js');
  const {LocalArchive}=await load('archive.js');const {HttpSyncTransport}=await load('transport.js');const {SyncRunner}=await load('runner.js');
  const database=join(dir,'archive.db'),credential=join(dir,'agent-credentials-acceptance.json'),policyFile=join(dir,'sync-policy.local.json'),approvalFile=join(dir,'sync-production-approval.json');
  const policy=parseNetworkPolicy(JSON.parse(readFileSync(policyFile,'utf8')));
  assert.equal(policy.environment,config.environment);assert.deepEqual(policy.allowedOrigins,[config.origin]);
  if(policy.environment==='production'){policy.approval=JSON.parse(readFileSync(approvalFile,'utf8'));policy.binding={database,credentials:credential};}
  authorizeOrigin(config.origin,policy); // Before any request or database creation.
  const request=(path,init={})=>fetcher(config.origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
  async function marker(){const r=await request('/api/acceptance/identity');assert.equal(r.status,200);assert.deepEqual(await r.json(),{kind:expectedKind,runId:config.runId});}
  await marker(); // Never send an owner password to an unmarked or mismatching server.
  const secret=await password();let cookie='',csrf='',deviceId,archive,revoked=false;
  const stages=[];const evidence={passed:false,transport:'https',scenarios:stages,runId:config.runId};
  async function owner(path,init={}){const headers=new Headers(init.headers);headers.set('Cookie',cookie);headers.set('X-CSRF-Token',csrf);headers.set('Origin',config.origin);if(init.body)headers.set('Content-Type','application/json');return request(path,{...init,headers});}
  async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(100);}throw new Error('Acceptance deadline reached');}
  function cli(){
    const args=[join(project,'local-agent/dist/cli.js'),'once','--credentials',credential,'--policy',policyFile];if(config.environment==='production')args.push('--approval',approvalFile);
    return JSON.parse(execFileSync(process.execPath,args,{cwd:project,encoding:'utf8',windowsHide:true,timeout:20000,stdio:['ignore','pipe','pipe'],env:{...process.env,DOTENV_CONFIG_PATH:join(dir,'disabled.env')}}).trim());
  }
  try{
    assert.equal((await request('/api/chat/conversations')).status,401);
    const login=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.origin},body:JSON.stringify({password:secret})});assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie'),/; Secure/);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrfToken;
    const createBody=JSON.stringify({id:randomUUID(),title:'synthetic HTTPS acceptance'});
    assert.equal((await request('/api/chat/conversations',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:createBody})).status,403);
    assert.equal((await request('/api/chat/conversations',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,Origin:'https://wrong.example.invalid','Content-Type':'application/json'},body:createBody})).status,403);
    const created=await owner('/api/chat/conversations',{method:'POST',body:createBody});assert.equal(created.status,201);const conversation=(await created.json()).id;
    const pair=await owner('/api/devices/pairings',{method:'POST',body:'{}'});assert.equal(pair.status,201);const pairingCode=(await pair.json()).pairingId;
    archive=new LocalArchive(database);const anonymous=new HttpSyncTransport(config.origin,'',fetcher,15000,policy);
    const identity=await archive.inspectIdentity();const paired=await anonymous.request('pair',{pairingCode,archive:identity});deviceId=paired.deviceId;
    assert.match(paired.token,/^[A-Za-z0-9_-]{43}$/);
    writeFileSync(credential,JSON.stringify({version:2,environment:config.environment,cloud:config.origin,deviceId,token:paired.token,database}),{flag:'wx',mode:0o600});
    assert.equal((await request('/api/chat/conversations',{headers:{Authorization:'Bearer '+paired.token}})).status,401);
    stages.push('HTTPS marker/TLS, user auth/CSRF/Origin and device scope');
    async function send(content,clientMessageId=randomUUID()){
      const r=await owner('/api/chat/conversations/'+conversation+'/messages',{method:'POST',body:JSON.stringify({clientMessageId,content})});assert.equal(r.status,202);const receipt=await r.json();
      await until(async()=>{const s=await owner('/api/chat/turns/'+receipt.turnId);assert.equal(s.status,200);return(await s.json()).turn.status==='succeeded';});return receipt;
    }
    const firstId=randomUUID();const first=await send('synthetic HTTPS first',firstId);const again=await send('synthetic HTTPS first',firstId);assert.equal(again.messageId,first.messageId);
    assert.equal(cli().caughtUp,true);assert.equal(archive.db.prepare('SELECT count(*) n FROM archive_messages').get().n,2);
    stages.push('actual agent CLI, durable messages and duplicate submit');
    let offline=true,loseAck=false;
    const faulty=async(url,options)=>{if(offline)throw new Error('Injected local disconnection');const r=await fetcher(url,options);if(loseAck&&new URL(url).pathname==='/api/sync/ack'&&r.ok){loseAck=false;await r.arrayBuffer();throw new Error('Injected ACK response loss');}return r;};
    const runner=new SyncRunner(archive,new HttpSyncTransport(config.origin,paired.token,faulty,15000,policy),{pollMs:50,retryBaseMs:10,retryMaxMs:100});
    const abort=new AbortController();const running=runner.run(abort.signal);
    try{await until(()=>archive.retryState().phase==='offline');await send('synthetic HTTPS while agent offline');offline=false;await until(async()=>{const c=await archive.cursor();return c.contiguousSeq===4&&archive.retryState().phase==='caught-up';});}finally{abort.abort();await running;}
    stages.push('agent automatic reconnect while cloud chat remains writable');
    await send('synthetic HTTPS lost ACK');loseAck=true;await assert.rejects(runner.syncOnce());assert.equal((await archive.cursor()).contiguousSeq,6);
    async function ack(){const r=await owner('/api/devices');assert.equal(r.status,200);return(await r.json()).items.find(d=>d.id===deviceId).ackSeq;}
    assert.equal(await ack(),6);await restart();await until(async()=>{try{await marker();return true;}catch{return false;}});assert.equal(await ack(),6);assert.equal(cli().caughtUp,true);
    stages.push('ACK response loss and isolated cloud restart preserve ACK/cursor');
    const history=await owner('/api/chat/conversations/'+conversation+'/messages');assert.equal(history.status,200);const messages=(await history.json()).items;
    const archived=archive.db.prepare('SELECT id,message_seq,role,content_hash FROM archive_messages ORDER BY message_seq').all();assert.deepEqual(archived.map(x=>({...x})),messages.map(m=>({id:m.id,message_seq:m.messageSeq,role:m.role,content_hash:hash(m.content)})));
    assert.equal(messages.length,6);assert.equal(archive.db.prepare('SELECT count(*) n FROM archive_events').get().n,6);assert.equal(await ack(),6);
    stages.push('six raw messages/events: ID, order, content hashes and watermarks agree');
    assert.equal((await owner('/api/devices/'+deviceId+'/revoke',{method:'POST'})).status,204);revoked=true;
    await assert.rejects(runner.syncOnce());assert.equal(archive.retryState().phase,'blocked');assert.equal((await owner('/api/chat/conversations/'+conversation+'/messages')).status,200);
    stages.push('device revoke blocks sync; cloud history retained');
    evidence.passed=true;evidence.messages=6;evidence.events=6;evidence.ackSeq=6;return evidence;
  }finally{
    if(deviceId&&!revoked){try{revoked=(await owner('/api/devices/'+deviceId+'/revoke',{method:'POST'})).status===204;}catch{}}
    evidence.disposableDeviceRevoked=revoked;archive?.close();writeFileSync(join(dir,'result.json'),JSON.stringify(evidence,null,2),{flag:'wx',mode:0o600});
  }
}
export const remoteCommand="sudo -n docker compose --project-directory /srv/sakie-sync-acceptance/release --env-file /srv/sakie-sync-acceptance/release/acceptance.env -f /srv/sakie-sync-acceptance/release/compose.json -p sakie-sync-acceptance";
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  let stage='arguments';
  try{
    const at=process.argv.indexOf('--run');if(at<0||!process.argv.includes('--authorized-remote-run'))throw new Error('Explicit authorized remote acceptance required');
    const dir=realpathSync(process.argv[at+1]);
    if(process.platform!=='win32')throw new Error('Remote acceptance entry requires Windows');
    stage='private-scope';
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(project,'tools/https-sync/check-private.ps1'),'-Path',dir],{stdio:'pipe',env:windowsPowerShellEnv()});
    stage='configuration';
    const config=JSON.parse(readFileSync(join(dir,'run.json'),'utf8'));if(config.environment!=='production')throw new Error('Remote entry requires production policy');
    const ssh=command=>execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','sakie',command],{encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']});
    stage='https-acceptance';
    const result=await runAcceptance(config,{dir,password:async()=>ssh(remoteCommand+" exec -T cloud node -e 'process.stdout.write(require(\"fs\").readFileSync(\"/run/synthetic-identity/login-secret.txt\",\"utf8\"))'").trim(),restart:async()=>{ssh(remoteCommand+' restart cloud');}});
    console.log(JSON.stringify(result));
  }catch(error){console.error(JSON.stringify({stoppedAt:stage,category:error.code??error.name,status:error.status??null}));if(stage==='private-scope')console.error(error.stderr?.toString());console.error('HTTPS acceptance stopped. Inspect sanitized result.json if present; no credential values logged.');process.exitCode=1;}
}
