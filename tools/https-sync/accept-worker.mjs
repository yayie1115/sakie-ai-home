import {runAcceptance} from './accept.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.SAKIE_HTTPS_FIXTURE!=='1'||!process.send)throw new Error('Synthetic test worker only');
const root=process.env.HTTPS_FIXTURE_ROOT,origin=process.env.HTTPS_FIXTURE_ORIGIN,runId=process.env.HTTPS_FIXTURE_RUN_ID;
try{
 const evidence=await runAcceptance({environment:'test',origin,runId},{dir:join(root,'windows'),password:async()=>readFileSync(join(root,'identity','login-secret.txt'),'utf8'),restart:async()=>{process.send({restart:true});await new Promise(r=>process.once('message',r));}});
 process.send({evidence});process.disconnect();
}catch{process.send({failed:true});process.disconnect();process.exitCode=1;}
