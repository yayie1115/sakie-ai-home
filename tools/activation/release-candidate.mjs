// Operator-controlled release of a RESTORED CLOUD CANDIDATE. Never invoked by server startup.
import {readFileSync,writeFileSync,renameSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
export const activationPhrase='ACTIVATE RESTORED CLOUD WITH A NEW ARCHIVE';
export async function loadReleaseRuntime(backendDist=fileURLToPath(new URL('../../backend/dist/',import.meta.url))){
 const base=resolve(backendDist);return Promise.all(['modules/auth/credentials.js','database/fingerprint.js','database/migrations.js'].map(p=>import(pathToFileURL(join(base,p)).href)));
}
export async function releaseCandidate({database,ownerFile,expectedFingerprint,confirmation,backendDist}){
 if(confirmation!==activationPhrase||!/^([a-f0-9]{64})$/.test(expectedFingerprint))throw Error('Explicit reviewed activation required');
 for(const p of [database,ownerFile])if(lstatSync(p).isSymbolicLink()||realpathSync(p)!==resolve(p))throw Error('Linked activation asset');
 const dir=dirname(database),marker=join(dir,'restore-info.json'),receipt=join(dir,'activation-receipt.json');
 if(existsSync(receipt))throw Error('Activation receipt exists; operator review required');
 const info=JSON.parse(readFileSync(marker,'utf8'));if(info.requiresSessionRevocation!==true||info.requiresArchiveReconciliation!==true)throw Error('Fresh quarantined restore required');
 const [{loadOwnerCredential},{databaseFingerprint},{assertMigrationHistory}]=await loadReleaseRuntime(backendDist);
 const owner=loadOwnerCredential(ownerFile);if(!owner)throw Error('New private owner credential required');
 const db=new DatabaseSync(database);try{db.exec('BEGIN IMMEDIATE');
 if(db.prepare('PRAGMA user_version').get().user_version!==4)throw Error('v4 required');assertMigrationHistory(db);
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||databaseFingerprint(db)!==expectedFingerprint)throw Error('Candidate changed');
 if(db.prepare('SELECT 1 FROM sync_devices WHERE revoked_at IS NULL LIMIT 1').get())throw Error('Active devices need explicit reconciliation');
 if(db.prepare('SELECT 1 FROM auth_sessions WHERE credential_version=? LIMIT 1').get(owner.id))throw Error('Owner must invalidate all restored sessions');

 // Receipt precedes marker update; an interruption stops rather than silently adopting a new baseline.
 const proof={format:1,at:new Date().toISOString(),fingerprint:expectedFingerprint,ownerVersion:owner.id,sessions:'invalidated-by-new-owner-version',archive:'no-active-devices; require-fresh-archive-and-pairing'};
 writeFileSync(receipt,JSON.stringify(proof,null,2),{flag:'wx',mode:0o600});
 const temp=marker+'.activation-new';writeFileSync(temp,JSON.stringify({...info,requiresSessionRevocation:false,requiresArchiveReconciliation:false,activationReceipt:'activation-receipt.json'}),{flag:'wx',mode:0o600});renameSync(temp,marker);return proof;
 }finally{try{db.exec('ROLLBACK');}finally{db.close();}}
}
