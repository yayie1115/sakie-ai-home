import {existsSync,mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {LocalArchive,ArchiveError} from './archive.js';
import {HttpSyncTransport,TransportError} from './transport.js';
import {SyncRunner} from './runner.js';
import {NetworkPolicyError,parseNetworkPolicy,defaultTestPolicy,cloudUrl,authorizeOrigin,createProductionApproval,productionPhrase,policyHash,type RuntimeNetworkPolicy,type ProductionApproval} from './network-policy.js';
const args=process.argv.slice(2),command=args.shift();
function option(name:string,required=true){const at=args.indexOf('--'+name);if(at<0){if(required)throw new Error('Required --'+name);return undefined;}if(!args[at+1]||args[at+1].startsWith('--'))throw new Error('Missing --'+name);return args[at+1];}
function outside(value:string){const path=resolve(value),root=fileURLToPath(new URL('../../',import.meta.url)),rel=relative(root,path);if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('Agent data and credentials must be outside source project');return path;}
function readJson(path:string){if(statSync(path).size>65536)throw new NetworkPolicyError('SYNC_CONFIG_TOO_LARGE');return JSON.parse(readFileSync(path,'utf8'));}
function policy():RuntimeNetworkPolicy{const file=option('policy',false);const p=file?parseNetworkPolicy(readJson(outside(file))):defaultTestPolicy;return{...p};}
function approved(p:RuntimeNetworkPolicy,database:string,credentials:string){if(p.environment==='production'){const file=option('approval',false);if(!file)throw new NetworkPolicyError('SYNC_PRODUCTION_APPROVAL_REQUIRED');p.approval=readJson(outside(file)) as ProductionApproval;p.binding={database,credentials};}return p;}
async function main(){
 if(command==='approve-production'){
  const p=policy(),origin=cloudUrl(option('cloud')!),database=outside(option('database')!),credentials=outside(option('credentials')!),file=outside(option('approval')!);
  if(existsSync(file))throw new NetworkPolicyError('SYNC_APPROVAL_FILE_EXISTS');
  if(p.environment!=='production'||!p.allowedOrigins.includes(origin))throw new NetworkPolicyError('SYNC_TARGET_NOT_ALLOWLISTED');
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new NetworkPolicyError('SYNC_PRODUCTION_CONFIRMATION_REQUIRES_TTY');
  console.log('Production policy SHA256: '+policyHash(p)+'\nProduction target: '+origin+'\nArchive: '+database+'\nCredentials: '+credentials+'\nThis step writes an approval record only; it does not connect.');
  const terminal=createInterface({input:process.stdin,output:process.stdout});let phrase:string;try{phrase=await terminal.question('Type exactly: '+productionPhrase(origin)+'\n> ');}finally{terminal.close();}
  const result=createProductionApproval(p,origin,{database,credentials},phrase!);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log('Approval saved. No network request made.');
 }else if(command==='pair'){
  const archivePath=outside(option('database')!),credentials=outside(option('credentials')!),codeFile=outside(option('pairing-code-file')!),origin=cloudUrl(option('cloud')!);
  const p=approved(policy(),archivePath,credentials);authorizeOrigin(origin,p);
  if(existsSync(credentials))throw new Error('Credential file exists; use a NEW file for explicit re-pairing');
  const archive=new LocalArchive(archivePath);
  try{
   const identity=await archive.inspectIdentity(),code=readFileSync(codeFile,'utf8').trim();
   const transport=new HttpSyncTransport(origin,'',fetch,15000,p);const result=await transport.request<{token:string;deviceId:string}>('pair',{pairingCode:code,archive:identity});
   if(!/^[A-Za-z0-9_-]{43}$/.test(result.token))throw new Error('Invalid credential response');
   mkdirSync(dirname(credentials),{recursive:true});writeFileSync(credentials,JSON.stringify({version:2,environment:p.environment,cloud:origin,deviceId:result.deviceId,token:result.token,database:archivePath},null,2),{flag:'wx',mode:0o600});
   archive.setRetry(0,0,'offline',null);console.log('Paired. Credentials saved outside source; token is not printed.');
  }finally{archive.close();}
 }else if(command==='once'||command==='run'||command==='status'){
  const credentialPath=outside(option('credentials')!),c=readJson(credentialPath),p=policy();
  if(c.version!==2||c.environment!==p.environment)throw new NetworkPolicyError('SYNC_CREDENTIAL_ENVIRONMENT_MISMATCH');
  const database=outside(c.database);approved(p,database,credentialPath);authorizeOrigin(c.cloud,p);
  const archive=new LocalArchive(database);
  try{
   if(command==='status'){console.log(JSON.stringify({environment:p.environment,identity:await archive.inspectIdentity(),cursor:await archive.cursor(),retry:archive.retryState()}));return;}
   const transport=new HttpSyncTransport(c.cloud,c.token,fetch,15000,p),runner=new SyncRunner(archive,transport,{pollMs:Number(process.env.SYNC_POLL_MS??5000),batchSize:Number(process.env.SYNC_BATCH_SIZE??50),retryBaseMs:Number(process.env.SYNC_RETRY_BASE_MS??1000),retryMaxMs:Number(process.env.SYNC_RETRY_MAX_MS??60000)});
   if(command==='once')console.log(JSON.stringify(await runner.syncOnce()));
   else{const controller=new AbortController();for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>controller.abort());await runner.run(controller.signal);}
  }finally{archive.close();}
 }else throw new Error('Commands: approve-production, pair, once, run, status. See docs/sync-security.md');
}
main().catch(error=>{console.error(error instanceof TransportError||error instanceof ArchiveError||error instanceof NetworkPolicyError?error.code:'Agent stopped; verify configuration. No credential values logged.');process.exitCode=1;});
