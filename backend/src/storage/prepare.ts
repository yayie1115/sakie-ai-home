import { DatabaseSync, backup } from 'node:sqlite';
import { closeSync, openSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, repositoryRoot } from '../config/env.js';
import { createBackup, restoreBackup } from '../database/backup.js';
import { businessFingerprint } from '../database/fingerprint.js';
import { upgradeDatabase } from '../database/upgrade.js';
import { openDatabase } from '../database/index.js';
export async function prepareStorage(settings:Pick<typeof config,'databasePath'|'backupDir'|'dataDir'>,options:{importLegacy?:boolean;legacyPath?:string}={}){
  if(settings.databasePath===':memory:')return {created:false,imported:false};
  if(existsSync(settings.databasePath)){
    const marker=join(dirname(settings.databasePath),'restore-info.json');
    if(existsSync(marker)){const info=JSON.parse(readFileSync(marker,'utf8'));if(info.requiresSessionRevocation||info.requiresArchiveReconciliation)throw new Error('Restored candidate is quarantined: revoke sessions and reconcile archive identity before explicit activation');}
    return {created:false,imported:false};
  }
  const legacy=options.legacyPath??join(repositoryRoot,'backend','data','sakie.db');
  if(existsSync(legacy)){
    if(!options.importLegacy)throw new Error('Legacy database retained: run npm run db:prepare -w backend -- --import-legacy in local maintenance mode before starting');
    const snapshot=await createBackup(legacy,settings.backupDir);
    mkdirSync(dirname(settings.dataDir),{recursive:true});const stage=mkdtempSync(join(dirname(settings.dataDir),'prepare-'));
    const candidate=await restoreBackup(snapshot,join(stage,'candidate'));
    await upgradeDatabase(candidate,settings.backupDir);
    const source=new DatabaseSync(legacy,{readOnly:true});const ready=new DatabaseSync(candidate,{readOnly:true});
    try{if(businessFingerprint(source)!==businessFingerprint(ready))throw new Error('Legacy data changed; stop old writers and retry');}finally{source.close();ready.close();}
    mkdirSync(dirname(settings.databasePath),{recursive:true});
    // Exclusively reserve a new file before backup(), whose API otherwise allows replacement.
    closeSync(openSync(settings.databasePath,'wx',0o600));
    const archive=new DatabaseSync(candidate,{readOnly:true});try{await backup(archive,settings.databasePath);}finally{archive.close();}
    writeFileSync(join(settings.dataDir,'legacy-import.json'),JSON.stringify({source:legacy,snapshot,importedAt:new Date().toISOString()},null,2),{flag:'wx'});
    return {created:true,imported:true,snapshot};
  }
  const db=openDatabase(settings.databasePath);db.close();return {created:true,imported:false};
}
