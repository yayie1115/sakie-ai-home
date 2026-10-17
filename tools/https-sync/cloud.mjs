// Standalone synthetic deployment, never the production server.ts entry.
import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
const project=fileURLToPath(new URL('../../',import.meta.url));
export const kind='sakie-synthetic-https-sync-v1';
export async function acceptanceCloud({data,identity,runId,origin}) {
  if(!/^[a-f0-9-]{36}$/.test(runId)||new URL(origin).protocol!=='https:')throw new Error('Invalid acceptance scope');
  for(const dir of [data,identity])if(!existsSync(dir)||lstatSync(dir).isSymbolicLink())throw new Error('Explicit isolated directories required');
  const stamp=JSON.parse(readFileSync(join(data,'synthetic-marker.json'),'utf8'));
  if(stamp.kind!==kind||stamp.runId!==runId)throw new Error('Synthetic marker mismatch');
  if(!stamp.initializedDatabase&&existsSync(join(data,'cloud.db')))throw new Error('Unadopted database; stop for review');
  if(!existsSync(join(data,'cloud.db'))&&stamp.initializedDatabase)throw new Error('Expected database missing');
  Object.assign(process.env,{NODE_ENV:'production',PUBLIC_ORIGIN:origin,DOTENV_CONFIG_PATH:join(data,'disabled.env'),DATA_DIR:data,DATABASE_PATH:join(data,'cloud.db'),BACKUP_DIR:join(data,'backups'),OWNER_CREDENTIAL_FILE:join(identity,'owner.json'),DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:''});
  const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
  const [{openDatabase},{createApp},{loadOwnerCredential},{AuthService},{ChatStore},{ChatService},{parseChatConfig},{default:express}]=await Promise.all([
    load('database/index.js'),load('app.js'),load('modules/auth/credentials.js'),load('modules/auth/service.js'),load('modules/chat/store.js'),load('modules/chat/service.js'),load('modules/chat/config.js'),import('express')]);
  const credential=loadOwnerCredential(join(identity,'owner.json'));if(!credential)throw new Error('Synthetic identity missing');
  const db=openDatabase(join(data,'cloud.db'));
  if(!stamp.initializedDatabase)writeFileSync(join(data,'synthetic-marker.json'),JSON.stringify({...stamp,initializedDatabase:true}));
  const chat=new ChatService(new ChatStore(db),{name:'fake-https-acceptance',model:'synthetic',async complete(){return {content:'synthetic HTTPS assistant reply',requestId:null};}},parseChatConfig({}));
  const app=express();app.disable('x-powered-by');
  app.get('/api/acceptance/identity',(_req,res)=>{res.set('Cache-Control','no-store');res.json({kind,runId});});
  app.use(createApp(db,{chat,auth:new AuthService(db,{loadCredential:()=>credential,publicOrigin:origin,secureCookies:true})}));chat.start();
  return {app,db,async close(){await chat.stop();db.close();}};
}
export async function initializeCloud({data,identity,runId}) {
  // One-time initialization only. Refuse preexisting files rather than adopt or upgrade a database.
  if(!/^[a-f0-9-]{36}$/.test(runId))throw new Error('Invalid scope');
  for(const dir of [data,identity]){mkdirSync(dir,{recursive:true});if(lstatSync(dir).isSymbolicLink()||readdirSync(dir).length)throw new Error('Fresh plain empty directories required');}
  if(existsSync(join(data,'cloud.db'))||existsSync(join(data,'synthetic-marker.json'))||existsSync(join(identity,'owner.json'))||existsSync(join(identity,'login-secret.txt')))throw new Error('Fresh empty scope required');
  Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:join(data,'disabled.env'),DATA_DIR:data,BACKUP_DIR:join(data,'backups'),OWNER_CREDENTIAL_FILE:join(identity,'owner.json'),DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:''});
  const {createOwnerCredential}=await import(pathToFileURL(join(project,'backend/dist/modules/auth/credentials.js')).href);
  const password=randomBytes(32).toString('base64url');
  writeFileSync(join(identity,'login-secret.txt'),password,{flag:'wx',mode:0o600});
  writeFileSync(join(identity,'owner.json'),JSON.stringify(await createOwnerCredential(password)),{flag:'wx',mode:0o600});
  writeFileSync(join(data,'synthetic-marker.json'),JSON.stringify({kind,runId}),{flag:'wx',mode:0o600});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args={data:'/app/synthetic-data',identity:'/run/synthetic-identity',runId:process.env.ACCEPTANCE_RUN_ID,origin:process.env.PUBLIC_ORIGIN};
  if(!args.runId)throw new Error('Acceptance scope required');
  if(process.argv.includes('--init')){await initializeCloud(args);console.log('Fresh synthetic scope initialized; credential values not printed.');}
  else{const cloud=await acceptanceCloud(args);const server=cloud.app.listen(3000,'0.0.0.0');let stopping=false;const close=async()=>{if(stopping)return;stopping=true;await new Promise(r=>server.close(r));await cloud.close();process.exit(0);};process.on('SIGTERM',close);process.on('SIGINT',close);console.log('Synthetic acceptance API listening; no real model provider.');}
}
