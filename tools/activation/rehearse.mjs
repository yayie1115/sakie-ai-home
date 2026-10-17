// Frozen historical SNAPSHOT only; never opens the formal cloud database.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {windowsPowerShellEnv} from '../https-sync/accept.mjs';
const project=fileURLToPath(new URL('../../',import.meta.url));
const frozen='E:\\sakie-ai-home-backups\\sync-acceptance-5394b44fd2f94eb59d8b165fa36f5b56\\snapshot-TPZG6o';
const privateParent='E:\\sakie-ai-home-data\\sync-acceptance-5394b44fd2f94eb59d8b165fa36f5b56';
export async function rehearse(){
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(project,'tools/https-sync/check-private.ps1'),'-Path',privateParent],{env:windowsPowerShellEnv(),stdio:'pipe'});
 if(lstatSync(frozen).isSymbolicLink()||realpathSync(frozen)!==frozen)throw Error('Snapshot link');
 const dir=mkdtempSync(join(privateParent,'activation-rehearsal-'));
 Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:join(dir,'disabled.env'),DATA_DIR:dir,BACKUP_DIR:join(dir,'backups'),OWNER_CREDENTIAL_FILE:join(dir,'unused-owner.json'),DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:''});
 const load=p=>import(pathToFileURL(join(project,'backend/dist',p)).href);
 const [{verifyBackup,restoreBackup,createBackup},{upgradeDatabase},{migrate,assertMigrationHistory},{databaseFingerprint,preservedTables,assertPreservedTables}]=await Promise.all([load('database/backup.js'),load('database/upgrade.js'),load('database/migrations.js'),load('database/fingerprint.js')]);
 const sourceHash=createHash('sha256').update(readFileSync(join(frozen,'database.sqlite'))).digest('hex');
 const workingSnapshot=join(dir,'input-snapshot');mkdirSync(workingSnapshot);const recorded=JSON.parse(readFileSync(join(frozen,'manifest.json'),'utf8'));if(recorded.mediaPolicy!=='none'||recorded.files.length!==1||recorded.files[0].path!=='database.sqlite')throw Error('This rehearsal requires the registered DB-only snapshot');
 // Byte-copy before SQLite inspection; even potential WAL/SHM side effects stay inside the NEW private directory.
 for(const name of ['manifest.json','database.sqlite'])copyFileSync(join(frozen,name),join(workingSnapshot,name));
 const baseline=await verifyBackup(workingSnapshot);assert.equal(baseline.schemaVersion,3);
 const file=await restoreBackup(workingSnapshot,join(dir,'candidate'));let db=new DatabaseSync(file);let tables,fingerprint;try{tables=preservedTables(db);fingerprint=databaseFingerprint(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
 assert.throws(()=>migrate(db,undefined,{afterStep:()=>{throw Error('Synthetic interruption after DDL');}}));assert.equal(databaseFingerprint(db),fingerprint);assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);assertMigrationHistory(db);}finally{db.close();}
 const upgraded=await upgradeDatabase(file,join(dir,'backups'));assert.equal(upgraded.changed,true);assert.equal((await upgradeDatabase(file,join(dir,'backups'))).changed,false);
 db=new DatabaseSync(file,{readOnly:true});let messages,events;try{assertPreservedTables(db,tables);assertMigrationHistory(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');messages=Number(db.prepare('SELECT count(*) n FROM chat_messages').get().n);events=Number(db.prepare('SELECT count(*) n FROM chat_outbox').get().n);fingerprint=databaseFingerprint(db);}finally{db.close();}
 const snapshot=await createBackup(file,join(dir,'roundtrip-backups'));const restored=await restoreBackup(snapshot,join(dir,'roundtrip'));db=new DatabaseSync(restored,{readOnly:true});try{assert.equal(databaseFingerprint(db),fingerprint);}finally{db.close();}
 await assert.rejects(restoreBackup(snapshot,join(dir,'roundtrip')));assert.equal(createHash('sha256').update(readFileSync(join(frozen,'database.sqlite'))).digest('hex'),sourceHash);
 // Restored data must remain quarantined; this rehearsal never activates or serves old private content.
 const {prepareStorage}=await load('storage/prepare.js');await assert.rejects(prepareStorage({databasePath:restored,dataDir:join(dir,'roundtrip'),backupDir:join(dir,'unused-backup')}),/quarantined/);
 const result={passed:true,source:'frozen historical v3 snapshot; NOT current formal database',schemaFrom:3,schemaTo:4,messages,events,checks:['source snapshot hash/manifest','failure transaction rollback','v3-v4 old-table preservation','repeat migration no-op','v4 backup restore fingerprint','restore overwrite refusal','restore activation quarantine'],currentMainDatabaseOpened:false};writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});return{directory:dir,...result};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await rehearse()));
