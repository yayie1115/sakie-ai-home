// Test child only: no production HTTP fault or administration endpoints.
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {acceptanceCloud} from './cloud.mjs';
if(process.env.SAKIE_HTTPS_FIXTURE!=='1'||!process.send)throw new Error('Synthetic test child only');
const root=process.env.HTTPS_FIXTURE_ROOT,runId=process.env.HTTPS_FIXTURE_RUN_ID;
let cloud;const server=createServer({key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))},(req,res)=>cloud?cloud.app(req,res):res.end());
await new Promise(r=>server.listen(Number(process.env.HTTPS_FIXTURE_PORT??0),'127.0.0.1',r));
const origin='https://127.0.0.1:'+server.address().port;
cloud=await acceptanceCloud({data:join(root,'cloud'),identity:join(root,'identity'),runId,origin});process.send({port:server.address().port,origin});
