import {upgradeOperations} from './modules/chat/live-operations.js';
import {upgradeBatch} from './modules/chat/live-batch.js';
import {upgradeUi} from './modules/app-ui/schema.js';
import {upgradeMemory} from './modules/memory-next/live/schema.js';
import { upgradeLiveChat } from './modules/chat/live-schema.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config/env.js';
import { createBackup, restoreBackup, verifyBackup } from './database/backup.js';
import { upgradeDatabase } from './database/upgrade.js';
import { prepareStorage } from './storage/prepare.js';
import { createOwnerCredential } from './modules/auth/credentials.js';
const args=process.argv.slice(2);const command=args.shift();
function option(name:string,fallback?:string){const index=args.indexOf('--'+name);if(index<0)return fallback;const value=args[index+1];if(!value||value.startsWith('--'))throw new Error('Missing --'+name);return value;}
function required(name:string){const value=option(name);if(!value)throw new Error('Required --'+name);return resolve(value);}
async function main(){
  if(command==='backup'){console.log(await createBackup(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!),{mediaDir:option('media-dir')?resolve(option('media-dir')!):undefined,mediaQuiesced:args.includes('--media-quiesced')}));}
  else if(command==='verify'){const value=await verifyBackup(required('backup'));console.log(JSON.stringify({verified:true,schemaVersion:value.schemaVersion,files:value.files.length}));}
  else if(command==='restore'){console.log(await restoreBackup(required('backup'),required('target')));console.log('Restored to a new directory. Revoke sessions and reconcile archive generation before activation.');}
  else if(command==='chat-upgrade'){console.log(JSON.stringify(await upgradeLiveChat(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='chat-ops-upgrade'){console.log(JSON.stringify(await upgradeOperations(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='batch-upgrade'){console.log(JSON.stringify(await upgradeBatch(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='ui-upgrade'){console.log(JSON.stringify(await upgradeUi(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='memory-upgrade'){console.log(JSON.stringify(await upgradeMemory(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='migrate'){console.log(JSON.stringify(await upgradeDatabase(resolve(option('database',config.databasePath)!),resolve(option('backup-dir',config.backupDir)!))));}
  else if(command==='prepare'){console.log(JSON.stringify(await prepareStorage(config,{importLegacy:args.includes('--import-legacy')})));}
  else if(command==='auth-setup'){
    if(existsSync(config.credentialPath)&&!args.includes('--rotate'))throw new Error('Owner already configured; use --rotate to explicitly rotate and invalidate all existing sessions');
    const password=randomBytes(24).toString('base64url');const credential=await createOwnerCredential(password);
    mkdirSync(dirname(config.credentialPath),{recursive:true});
    if(args.includes('--rotate')){const temp=config.credentialPath+'.'+credential.id+'.new';writeFileSync(temp,JSON.stringify(credential,null,2),{flag:'wx',mode:0o600});renameSync(temp,config.credentialPath);}
    else writeFileSync(config.credentialPath,JSON.stringify(credential,null,2),{flag:'wx',mode:0o600});
    console.log('Owner configured. Copy this generated password into your password manager; it is not stored in plaintext:');console.log(password);
  }else throw new Error('Commands: prepare, backup, verify, restore, migrate, chat-upgrade, memory-upgrade, ui-upgrade, batch-upgrade, chat-ops-upgrade, auth-setup');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Command failed');process.exitCode=1;});
