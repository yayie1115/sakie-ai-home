// Scheduler host: no credentials on command line, no child output/log bodies, no retry on blocked state.
import {readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {windowsPowerShellEnv} from '../https-sync/accept.mjs';
import {superviseProcess} from './supervision.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function validateRun(c){
 if(!c||c.database!=='E:\\sakie-ai-home-data\\windows-live\\archive.db'||c.credentials!=='E:\\sakie-ai-home-data\\identity-live\\agent-credentials-live.json'||c.policy!=='E:\\sakie-ai-home-data\\identity-live\\sync-policy.local.json'||c.approval!=='E:\\sakie-ai-home-data\\identity-live\\sync-production-approval.json')throw Error('Unexpected live scope');
 const u=new URL(c.origin);if(u.protocol!=='https:'||u.origin!==c.origin||['phos.sakiehome.icu','sync-check.sakiehome.icu','sakiehome.icu','www.sakiehome.icu'].includes(u.hostname))throw Error('Unexpected live target');return c;
}
export function retryDecision(status){return status?.retry?.phase==='blocked'?'stop':'retry';}
export function acquireLock(file,alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}){
 if(existsSync(file)){const old=JSON.parse(readFileSync(file,'utf8'));if(old.version!==1||!Number.isSafeInteger(old.pid)||old.pid<1||typeof old.nonce!=='string'||alive(old.pid))throw Error('Live/unknown lock; stop');renameSync(file,file+'.stale-'+randomUUID());}
 const fd=openSync(file,'wx');const content=JSON.stringify({version:1,pid:process.pid,nonce:randomUUID()});writeFileSync(fd,content);
 return{release(){closeSync(fd);if(readFileSync(file,'utf8')!==content)throw Error('Lock changed; preserve evidence');unlinkSync(file);}};
}
export async function supervise(c,{once=false}={}){
 validateRun(c);if(process.platform!=='win32')throw Error('Windows runtime only');
 for(const dir of [dirname(c.database),dirname(c.credentials)])execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'tools/https-sync/check-private.ps1'),'-Path',dir,'-AccessMode',dir===dirname(c.credentials)?'ReadOnly':'Modify'],{env:windowsPowerShellEnv(),stdio:'pipe'});
 const credential=JSON.parse(readFileSync(c.credentials,'utf8'));if(credential.cloud!==c.origin||credential.database!==c.database||credential.version!==2||credential.environment!=='production')throw Error('Credential scope mismatch');
 const args=[join(root,'local-agent/dist/cli.js'),'--credentials',c.credentials,'--policy',c.policy,'--approval',c.approval];
 const lock=join(dirname(c.database),'agent-host.lock');const held=acquireLock(lock);
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const status=state=>{const f=join(dirname(c.database),'host-status.json'),temp=f+'.new';writeFileSync(temp,JSON.stringify({state,at:new Date().toISOString()}));renameSync(temp,f);};
 try {await superviseProcess({command:process.execPath,args:[args[0],'run',...args.slice(1)],cwd:root,once,signal:controller.signal,status,
  readState:()=>JSON.parse(execFileSync(process.execPath,[args[0],'status',...args.slice(1)],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}))});
 }finally{held.release();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const at=process.argv.indexOf('--run');if(at<0)throw Error();await supervise(JSON.parse(readFileSync(resolve(process.argv[at+1]),'utf8')));}catch{console.error('Agent host stopped; inspect sanitized host-status.json and review identity/ACL/lock.');process.exitCode=1;}}
