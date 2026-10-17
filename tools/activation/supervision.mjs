// Process supervision only. Callers must validate identity, paths and ACL before entering.
import {spawn} from 'node:child_process';
export async function superviseProcess({command,args,cwd,readState,status,signal,restartDelayMs=30000,once=false}) {
 let child, wake;
 const stop=()=>{child?.kill();wake?.();};
 signal?.addEventListener('abort',stop);
 try {
  while(!signal?.aborted){
   status('running');
   let code;
   try {code=await new Promise((ok,fail)=>{child=spawn(command,args,{cwd,windowsHide:true,stdio:'ignore'});child.once('error',fail);child.once('exit',ok);if(signal?.aborted)child.kill();});}
   catch {status('blocked-review-required');throw Error('Child could not start; operator review required');}
   child=undefined;
   if(signal?.aborted)break;
   let state;
   try {state=await readState();}catch {status('blocked-review-required');throw Error('Status unavailable; no blind restart');}
   // Unknown/malformed state is not evidence that a restart is safe.
   if(!state?.retry||!['offline','caught-up','catching-up','blocked'].includes(state.retry.phase)){
    status('blocked-review-required');throw Error('Unknown status; no blind restart');
   }
   if(state.retry.phase==='blocked'){status('blocked-review-required');throw Error('Blocked; operator action required');}
   if(once||code===0){status('stopped');return;}
   status('restart-backoff');
   await new Promise(ok=>{const timer=setTimeout(done,restartDelayMs);function done(){clearTimeout(timer);wake=undefined;ok();}wake=done;if(signal?.aborted)done();});
  }
  status('stopped');
 } finally {signal?.removeEventListener('abort',stop);}
}
