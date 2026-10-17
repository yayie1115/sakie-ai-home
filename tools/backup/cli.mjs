// Windows operator CLI. Importing this file never loads dotenv or model configuration.
import {existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createEncryptedBackup,verifyEncryptedBackup,restoreEncryptedBackup,pendingStatus,cleanupAbandoned,BackupError} from './encrypted.mjs';
import {hiddenPassphrase} from './prompt.mjs';
import {windowsPowerShellEnv} from '../https-sync/accept.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));const args=process.argv.slice(2),command=args.shift();
const allowed={create:['--database','--output','--workspace','--media-dir','--media-quiesced'],verify:['--input','--workspace'],restore:['--input','--target','--workspace'],status:['--workspace'],'cleanup-abandoned':['--workspace','--job-id']};
function option(name,required=true){const at=args.indexOf('--'+name);if(at<0){if(required)throw Error('ARGUMENTS_REQUIRED');return undefined;}if(!args[at+1]||args[at+1].startsWith('--'))throw Error('ARGUMENTS_REQUIRED');return resolve(args[at+1]);}
function privateDirectory(path){execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'tools/https-sync/check-private.ps1'),'-Path',path],{env:windowsPowerShellEnv(),stdio:'pipe',timeout:30000});}
try{
 if(!allowed[command])throw Error('ARGUMENTS_REQUIRED');
 for(let i=0;i<args.length;i++){if(!allowed[command].includes(args[i])||args.indexOf(args[i])!==i)throw Error('UNKNOWN_OR_DUPLICATE_ARGUMENT');if(args[i]!=='--media-quiesced'){if(!args[++i]||args[i].startsWith('--'))throw Error('ARGUMENTS_REQUIRED');}}
 if(process.platform!=='win32')throw Error('WINDOWS_PRIVATE_SCOPE_REQUIRED');
 const workspace=option('workspace');if(!/^E:\\/i.test(workspace))throw Error('E_DRIVE_SCRATCH_REQUIRED');privateDirectory(workspace);
 if(command==='status'){console.log(JSON.stringify({pending:pendingStatus(workspace)}));}
 else if(command==='cleanup-abandoned'){
  const at=args.indexOf('--job-id'),id=args[at+1];if(!/^[-a-f0-9]{36}$/.test(id))throw Error('ARGUMENTS_REQUIRED');
  const answer=await hiddenPassphrase('Type CLEAN '+id+' to remove only the abandoned owned workspace: ');
  if(answer!=='CLEAN '+id)throw Error('CONFIRMATION_REQUIRED');console.log(JSON.stringify(cleanupAbandoned(workspace,id)));
 }else{
  const pending=pendingStatus(workspace);if(pending)throw Error('PENDING_REVIEW_REQUIRED');
  const options={workspace,minFreeBytes:20*1024**3};
  if(command==='create'){options.database=option('database');options.output=option('output');options.mediaDir=option('media-dir',false);options.mediaQuiesced=args.includes('--media-quiesced');privateDirectory(dirname(options.output));}
  else{options.input=option('input');if(command==='restore'){options.target=option('target');if(!/^E:\\/i.test(options.target))throw Error('E_DRIVE_RESTORE_REQUIRED');if(existsSync(options.target))throw Error('RESTORE_TARGET_EXISTS');privateDirectory(dirname(options.target));}}
  let passphrase=await hiddenPassphrase(command==='create'?'New backup passphrase (20+ characters, hidden): ':'Backup passphrase (hidden): ');
  try{
   if(command==='create'){const again=await hiddenPassphrase('Repeat passphrase (hidden): ');if(passphrase!==again)throw Error('PASSPHRASE_MISMATCH');}
   const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
   try{const run={create:createEncryptedBackup,verify:verifyEncryptedBackup,restore:restoreEncryptedBackup}[command];console.log(JSON.stringify(await run({...options,passphrase,signal:controller.signal})));}
   finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  }finally{passphrase='';}
 }
}catch(error){const permitted=['INTERACTIVE_TTY_REQUIRED','INPUT_ABORTED','ARGUMENTS_REQUIRED','UNKNOWN_OR_DUPLICATE_ARGUMENT','PASSPHRASE_MISMATCH','PENDING_REVIEW_REQUIRED','RESTORE_TARGET_EXISTS'];console.error(JSON.stringify({ok:false,error:error instanceof BackupError?error.code:permitted.includes(error.message)?error.message:'BACKUP_STOPPED_REVIEW_REQUIRED'}));process.exitCode=1;}
