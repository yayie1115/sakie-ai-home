// New synthetic database only; never loads dotenv, a real provider or production app.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const project=fileURLToPath(new URL('../',import.meta.url));
export const data01Password='demo-only-sakie-data01';
export async function startData01Lab({resume,port=0,generator}={}){
 const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
 const [{assertData01Path,data01Marker},{migrateSyntheticOps},{ChatOpsService},{FakeGenerationRunner},{data01Router},{createOwnerCredential},{AuthService},{authRouter},{default:express}]=await Promise.all([
 load('modules/chat/data-next/guard.js'),load('modules/chat/data-next/ops-schema.js'),load('modules/chat/data-next/ops-service.js'),load('modules/chat/data-next/fake-generation.js'),load('modules/chat/data-next/routes.js'),load('modules/auth/credentials.js'),load('modules/auth/service.js'),load('modules/auth/routes.js'),import('express')]);
 const parent=join(project,'.phase1-work');mkdirSync(parent,{recursive:true});let dir;
 if(resume){if(!/^chat-data01-lab-[A-Za-z0-9_-]+$/.test(resume))throw Error('INVALID_RUN_NAME');dir=join(parent,resume);}else{dir=mkdtempSync(join(parent,'chat-data01-lab-'));writeFileSync(join(dir,'synthetic-marker.txt'),data01Marker,{flag:'wx'});}
 if(lstatSync(parent).isSymbolicLink()||realpathSync(parent)!==resolve(parent))throw Error('LINKED_LAB_PARENT');
 const file=join(dir,'chat-data01-synthetic.db');assertData01Path(file);
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');migrateSyntheticOps(db);
 const id=String(db.prepare('SELECT id FROM chat_conversations ORDER BY rowid LIMIT 1').get()?.id??randomUUID());
 const service=new ChatOpsService(db,c=>({read:c===id,write:c===id,audience:'synthetic-owner-private'}));service.legacy.createConversation(id,'CHAT-DATA-01 synthetic');service.recoverInterrupted();const runner=new FakeGenerationRunner(service,generator);
 const credential=await createOwnerCredential(data01Password),options={loadCredential:()=>credential,publicOrigin:'http://127.0.0.1',secureCookies:false};const auth=new AuthService(db,options);
 const app=express();app.disable('x-powered-by');app.use('/api/auth',authRouter(auth));app.use(express.json({limit:'64kb'}));app.use('/api/lab/chat-data01',data01Router(service,auth,id,runner));
 app.use('/api',(_req,res)=>res.status(404).json({error:'NOT_FOUND'}));
 app.get('/demo/chat-group',(_req,res)=>res.type('html').send(readFileSync(join(project,'frontend/dist/index.html'),'utf8').replace('<head>','<head><meta name="sakie-data01-lab" content="synthetic-only">')));
 app.use(express.static(join(project,'frontend/dist')));app.use((e,_req,res,_next)=>res.status(e.status??500).json({error:e.code??'LAB_ERROR'}));
 const server=await new Promise((ok,fail)=>{const s=app.listen(port,'127.0.0.1',()=>ok(s));s.once('error',fail);});const origin='http://127.0.0.1:'+server.address().port;options.publicOrigin=origin;
 return {origin,dir,db,service,runner,conversationId:id,async close(){await runner.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);if(args.some(a=>a!=='--resume'&&!/^chat-data01-lab-[A-Za-z0-9_-]+$/.test(a)))throw Error('INVALID_ARGUMENT');
 const lab=await startData01Lab({port:5192,resume:args.includes('--resume')?args[args.indexOf('--resume')+1]:undefined});
 console.log(JSON.stringify({url:lab.origin+'/demo/chat-group?lab=data01',run:basename(lab.dir),password:data01Password,mode:'synthetic-only',archive:'not-enabled'}));
 let closing=false;for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{if(closing)return;closing=true;await lab.close();process.exit(0);});
}
