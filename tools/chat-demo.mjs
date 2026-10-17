// Local, synthetic-only launcher. No dotenv, network model provider or production flag.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const project=fileURLToPath(new URL('../',import.meta.url));
export const demoPassword='demo-only-sakie';
const marker='sakie-synthetic-chat-demo-v1';
export function demoDirectory(resume) {
  const parent=resolve(project,'..','sakie-ai-home-data');
  if(resume){
    // Only a named direct child created by this launcher; never an arbitrary database path.
    if(!/^chat-demo-[A-Za-z0-9_-]+$/.test(resume))throw new Error('Invalid demo run name');
    const dir=join(parent,resume);
    if(lstatSync(dir).isSymbolicLink()||realpathSync(dirname(dir))!==realpathSync(parent)||realpathSync(dir)!==dir)throw new Error('Unsafe demo directory');
    if(readFileSync(join(dir,'synthetic-marker.txt'),'utf8')!==marker)throw new Error('Not a synthetic demo');
    for(const file of ['chat.db','owner.json'])if(existsSync(join(dir,file))&&lstatSync(join(dir,file)).isSymbolicLink())throw new Error('Linked demo asset');
    return dir;
  }
  mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'chat-demo-'));
  writeFileSync(join(dir,'synthetic-marker.txt'),marker,{flag:'wx'});return dir;
}
export async function startDemo({resume,port=5180}={}) {
  const dir=demoDirectory(resume);
  Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:join(dir,'disabled.env'),DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:'',DATA_DIR:dir,BACKUP_DIR:join(dir,'backups'),DATABASE_PATH:join(dir,'chat.db'),OWNER_CREDENTIAL_FILE:join(dir,'owner.json')});
  const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
  const [{openDatabase},{createApp},{createOwnerCredential},{AuthService},{ChatStore},{ChatService},{parseChatConfig},{default:express}]=await Promise.all([
    load('database/index.js'),load('app.js'),load('modules/auth/credentials.js'),load('modules/auth/service.js'),load('modules/chat/store.js'),load('modules/chat/service.js'),load('modules/chat/config.js'),import('express')]);
  const credentialFile=join(dir,'owner.json');
  if(!existsSync(credentialFile))writeFileSync(credentialFile,JSON.stringify(await createOwnerCredential(demoPassword)),{flag:'wx'});
  const credential=JSON.parse(readFileSync(credentialFile,'utf8'));
  const db=openDatabase(join(dir,'chat.db'));const store=new ChatStore(db);
  if(!store.conversations(Number.MAX_SAFE_INTEGER,1).length)store.createConversation(randomUUID(),'合成聊天演示');
  let calls=0;
  const chat=new ChatService(store,{name:'fake-demo',model:'synthetic',async complete(messages){calls++;return {content:'[假模型，无收费调用] 已收到：'+messages.filter(m=>m.role==='user').at(-1).content,requestId:null};}},parseChatConfig({}));
  const authOptions={loadCredential:()=>credential,publicOrigin:'http://127.0.0.1',secureCookies:false};
  const api=createApp(db,{auth:new AuthService(db,authOptions),chat});
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>req.path==='/api'||req.path.startsWith('/api/')?api(req,res,next):next());
  app.use(express.static(join(project,'frontend/dist')));
  app.use((req,res)=>{if(req.method==='GET'){res.setHeader('Cache-Control','no-store');res.sendFile(join(project,'frontend/dist/index.html'));}else res.sendStatus(404);});
  const server=await new Promise((ok,fail)=>{const s=app.listen(port,'127.0.0.1',()=>ok(s));s.once('error',fail);});
  const origin='http://127.0.0.1:'+server.address().port;authOptions.publicOrigin=origin;chat.start();
  return {origin,dir,db,get calls(){return calls;},async close(){await new Promise(r=>server.close(r));await chat.stop();db.close();}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);const resume=args.includes('--resume')?args[args.indexOf('--resume')+1]:undefined;
  if(!args.includes('--no-build'))for(const workspace of ['backend','frontend'])execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run','build','-w',workspace],{cwd:project,stdio:'inherit',shell:process.platform==='win32'});
  const demo=await startDemo({resume});
  const info={url:demo.origin+'/demo/chat',run:basename(demo.dir),pid:process.pid,mode:'synthetic-only'};
  writeFileSync(join(demo.dir,'session.json'),JSON.stringify(info,null,2));
  console.log(JSON.stringify({...info,password:demoPassword}));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await demo.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
