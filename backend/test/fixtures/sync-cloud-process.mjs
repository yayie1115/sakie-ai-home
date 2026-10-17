// Test-only bootstrap around the built backend. Never enables a fake provider in production code.
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {openDatabase} from '../../dist/database/index.js';
import {createApp} from '../../dist/app.js';
import {createOwnerCredential} from '../../dist/modules/auth/credentials.js';
import {AuthService} from '../../dist/modules/auth/service.js';
import {ChatStore} from '../../dist/modules/chat/store.js';
import {ChatService} from '../../dist/modules/chat/service.js';
import {parseChatConfig} from '../../dist/modules/chat/config.js';
if(process.env.SAKIE_SYNC_E2E!=='1'||!process.send)throw new Error('Isolated test bootstrap only');
const root=resolve(process.env.TEST_DATA_ROOT),filename=resolve(process.env.E2E_CLOUD_DATABASE);
const rel=relative(root,filename);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Fixture path escaped test root');
const credentialPath=filename+'.owner.json';mkdirSync(dirname(filename),{recursive:true});
if(!existsSync(credentialPath))writeFileSync(credentialPath,JSON.stringify(await createOwnerCredential('e2e-test-password-only')),{flag:'wx'});
const credential=JSON.parse(readFileSync(credentialPath,'utf8'));
const db=openDatabase(filename);
const provider={name:'fake-e2e',model:'synthetic',async complete(){return{content:'synthetic assistant reply',requestId:null,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null}};}};
const chat=new ChatService(new ChatStore(db),provider,parseChatConfig({}));
const auth=new AuthService(db,{loadCredential:()=>credential,publicOrigin:'http://127.0.0.1:5173',secureCookies:false});
const server=createApp(db,{auth,chat}).listen(Number(process.env.E2E_CLOUD_PORT??0),'127.0.0.1',()=>{
 chat.start();process.send({type:'ready',port:server.address().port});
});
process.on('message',message=>{
 if(message?.type!=='stats')return;
 process.send({type:'stats',requestId:message.requestId,
  messages:db.prepare('SELECT id,conversation_id,message_seq,role,content_hash FROM chat_messages ORDER BY rowid').all(),
  events:db.prepare('SELECT event_id,stream_seq,payload_hash FROM chat_outbox ORDER BY stream_seq').all(),
  devices:db.prepare('SELECT id,ack_seq,delivered_seq,revoked_at FROM sync_devices').all(),
  attempts:Number(db.prepare('SELECT count(*) AS n FROM chat_attempts').get().n)});
});
server.on('error',()=>process.exit(1));
