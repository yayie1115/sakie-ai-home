// Test harness only; generates its passphrase in memory and pauses after synthetic snapshot.
import{randomBytes}from'node:crypto';import{writeFileSync}from'node:fs';import{createEncryptedBackup}from'./encrypted.mjs';
const [workspace,database,output,ready]=process.argv.slice(2);
if(!workspace.includes('.phase1-work')||!workspace.includes('encrypted-backup-lab-'))throw Error('Synthetic scope only');
await createEncryptedBackup({workspace,database,output,passphrase:randomBytes(24).toString('base64url'),runtime:{checkpoint:async phase=>{if(phase==='snapshot-created'){writeFileSync(ready,'synthetic-ready');await new Promise(()=>{setInterval(()=>{},1000);});}}}});
