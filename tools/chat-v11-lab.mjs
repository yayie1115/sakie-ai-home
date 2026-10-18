// Synthetic-only v11 compatibility lab. No dotenv or real provider is loaded.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const project=fileURLToPath(new URL('../',import.meta.url));
export const labPassword='demo-only-sakie-v11';
const marker='sakie-chat-v11-synthetic-only-v1';
export function labDirectory(resume){
 const parent=resolve(project,'..','sakie-ai-home-data');
 if(resume){if(!/^chat-v11-lab-[A-Za-z0-9_-]+$/.test(resume))throw Error('Invalid synthetic run name');const dir=join(parent,resume);
  if(lstatSync(dir).isSymbolicLink()||realpathSync(dir)!==dir||realpathSync(dirname(dir))!==realpathSync(parent)||readFileSync(join(dir,'synthetic-marker.txt'),'utf8')!==marker)throw Error('Not a synthetic lab');
  for(const file of ['chat-v11-synthetic.db','chat-v11-synthetic.db-wal','chat-v11-synthetic.db-shm'])if(existsSync(join(dir,file))&&lstatSync(join(dir,file)).isSymbolicLink())throw Error('Linked synthetic asset');return dir;
 }
 mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'chat-v11-lab-'));writeFileSync(join(dir,'synthetic-marker.txt'),marker,{flag:'wx'});return dir;
}
export async function startV11Lab({resume,port=0}={}){
 const dir=labDirectory(resume);
 const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
 const [{openDatabase},{V11LabStore},{ChatService},{parseChatConfig},{createOwnerCredential},{AuthService},{authRouter},{chatRouter},{createV11LabRouter},{decodeSubmission},{default:express}]=await Promise.all([
  load('database/index.js'),load('modules/chat/v11-lab/store.js'),load('modules/chat/service.js'),load('modules/chat/config.js'),load('modules/auth/credentials.js'),load('modules/auth/service.js'),load('modules/auth/routes.js'),load('modules/chat/routes.js'),load('modules/chat/v11-lab/routes.js'),load('modules/chat/v11-lab/codec.js'),import('express')]);
 const db=openDatabase(join(dir,'chat-v11-synthetic.db')),store=new V11LabStore(db);
 const id=store.conversations(Number.MAX_SAFE_INTEGER,1)[0]?.id??randomUUID();store.createConversation(id,'合成 v11 私聊');
 let calls=0;
 const chat=new ChatService(store,{name:'fake-v11-lab',model:'synthetic',async complete(messages){calls++;const last=messages.filter(m=>m.role==='user').at(-1)?.content??'';const batch=decodeSubmission(last);return {content:'[假模型，无收费调用] '+(batch?batch.bubbles.map(b=>b.content).join(' / '):last),requestId:null};}},parseChatConfig({}));
 const credential=await createOwnerCredential(labPassword),options={loadCredential:()=>credential,publicOrigin:'http://127.0.0.1',secureCookies:false};const auth=new AuthService(db,options);
 const app=express();app.disable('x-powered-by');app.use('/api/auth',authRouter(auth));app.use(express.json({limit:'64kb'}));
 app.use('/api/lab/chat-v11',createV11LabRouter(chat,auth,id));
 app.get('/api/lab-metrics',(req,res)=>{auth.require(req);res.json({synthetic:true,calls});});
 app.use('/api/chat',(req,_res,next)=>{try{auth.require(req);next();}catch(e){next(e);}},chatRouter(chat));
 app.use('/api',(_req,res)=>res.status(404).json({error:'NOT_FOUND'}));
 app.get('/demo/chat-group',(_req,res)=>res.type('html').send(readFileSync(join(project,'frontend/dist/index.html'),'utf8').replace('<head>','<head><meta name="sakie-v11-lab" content="synthetic-only">')));
 app.use(express.static(join(project,'frontend/dist')));app.use((req,res)=>req.method==='GET'?res.sendFile(join(project,'frontend/dist/index.html')):res.sendStatus(404));
 app.use((e,_req,res,_next)=>res.status(e.status??500).json({error:e.code??'LAB_ERROR'}));
 const server=await new Promise((ok,fail)=>{const s=app.listen(port,'127.0.0.1',()=>ok(s));s.once('error',fail);});const origin='http://127.0.0.1:'+server.address().port;options.publicOrigin=origin;chat.start();
 return {origin,dir,db,chat,conversationId:id,get calls(){return calls;},async close(){await chat.stop();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),resume=args.includes('--resume')?args[args.indexOf('--resume')+1]:undefined;
 if(!args.includes('--no-build'))for(const w of ['backend','frontend'])execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run','build','-w',w],{cwd:project,stdio:'inherit',shell:process.platform==='win32'});
 const lab=await startV11Lab({resume,port:5191});console.log(JSON.stringify({url:lab.origin+'/demo/chat-group?lab=1',run:basename(lab.dir),password:labPassword,mode:'synthetic-only'}));
 let closing=false;for(const event of ['SIGINT','SIGTERM'])process.on(event,async()=>{if(closing)return;closing=true;await lab.close();process.exit(0);});
}
