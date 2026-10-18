/** M0-2 local-only read environment. No dotenv, real provider, existing DB path or resume option. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync,openSync,closeSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const project=fileURLToPath(new URL('../',import.meta.url));
export const m0TestPassword='m0-local-readonly-test-only';
export const m0Isolation=Object.freeze({host:'127.0.0.1',port:5193,environment:'m0-isolated-readonly',writeEnabled:false,modelCallsEnabled:false,protocol:'chat-v4-readonly'});
export async function startM0TestServer({port=0,fixtureData=false,seed}={}){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_PORT');if(typeof fixtureData!=='boolean')throw Error('INVALID_FIXTURE_FLAG');if(seed&&fixtureData!==true)throw Error('FIXTURE_LABEL_REQUIRED');
 const parent=join(dirname(project.replace(/[\\/]$/,'')),'sakie-ai-home-data','tests');mkdirSync(parent,{recursive:true});if(lstatSync(parent).isSymbolicLink()||realpathSync(parent)!==resolve(parent))throw Error('LINKED_TEST_PARENT');
 const dir=mkdtempSync(join(parent,'m0-mobile-ui-'));writeFileSync(join(dir,'m0-marker.txt'),'sakie-m0-readonly-test-v1',{flag:'wx'});const file=join(dir,'m0-test.sqlite');closeSync(openSync(file,'wx'));
 const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
 const [{migrate},{ChatStore},{ChatService},{parseChatConfig},{chatRouter},{createOwnerCredential},{AuthService},{authRouter},{default:express}]=await Promise.all([load('database/migrations.js'),load('modules/chat/store.js'),load('modules/chat/service.js'),load('modules/chat/config.js'),load('modules/chat/routes.js'),load('modules/auth/credentials.js'),load('modules/auth/service.js'),load('modules/auth/routes.js'),import('express')]);
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');migrate(db);if(seed)await seed(db);
 const store=new ChatStore(db),chat=new ChatService(store,null,parseChatConfig({}));
 const credential=await createOwnerCredential(m0TestPassword),options={loadCredential:()=>credential,publicOrigin:'http://127.0.0.1',secureCookies:false};const auth=new AuthService(db,options);
 const app=express();app.disable('x-powered-by');app.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();});
 app.get('/api/m0/capabilities',(_req,res)=>res.json({...m0Isolation,fixtureData}));app.use('/api/auth',authRouter(auth));
 app.use('/api/chat',(req,res,next)=>{try{auth.require(req);if(!['GET','HEAD'].includes(req.method))return res.status(405).json({error:'M0_READ_ONLY'});next();}catch(e){next(e);}},chatRouter(chat));
 app.use('/api',(_req,res)=>res.status(404).json({error:'NOT_FOUND'}));
 app.get('/m0/chat',(_req,res)=>res.type('html').send(readFileSync(join(project,'frontend/dist/index.html'),'utf8').replace('<head>','<head><meta name="sakie-m0-environment" content="isolated-readonly">')));
 app.use('/assets',express.static(join(project,'frontend/dist/assets'),{index:false}));app.get('/',(_req,res)=>res.redirect('/m0/chat'));app.use((_req,res)=>res.status(404).send('M0 isolated route only'));
 app.use((error,_req,res,_next)=>res.status(error.status??500).json({error:error.code??'M0_TEST_ERROR'}));
 const server=await new Promise((ok,fail)=>{const s=app.listen(port,m0Isolation.host,()=>ok(s));s.once('error',fail);});const origin='http://'+m0Isolation.host+':'+server.address().port;options.publicOrigin=origin;
 return {origin,dir,file,db,chat,auth,async close(){await chat.stop();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);if(args.some(a=>a!=='--no-build'))throw Error('No host, database, credentials, resume or model arguments are accepted');
 if(!args.includes('--no-build'))for(const workspace of ['backend','frontend'])execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run','build','--workspace',workspace],{cwd:project,stdio:'inherit',shell:process.platform==='win32'});
 const server=await startM0TestServer({port:m0Isolation.port});console.log(JSON.stringify({url:server.origin+'/m0/chat',mode:'empty-isolated-readonly',password:m0TestPassword,data:'new unique test directory; no existing database opened',publicAccess:false}));
 let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await server.close();process.exit(0);});
}
