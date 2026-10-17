import {mkdirSync,mkdtempSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const parent=join(dirname(root),basename(root)+'-data');mkdirSync(parent,{recursive:true});
const testRoot=mkdtempSync(join(parent,'sync-e2e-'));
const npm=process.env.npm_execpath;if(!npm)throw new Error('Use npm run test:sync:e2e');
const env={...process.env,NODE_ENV:'test',DOTENV_CONFIG_PATH:join(testRoot,'no-dotenv.env'),DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:'',DATA_DIR:join(testRoot,'unused'),DATABASE_PATH:join(testRoot,'unused','cloud.db'),BACKUP_DIR:join(testRoot,'unused-backups'),OWNER_CREDENTIAL_FILE:join(testRoot,'unused','owner.json'),TEST_DATA_ROOT:testRoot,SAKIE_SYNC_E2E:'1'};
console.log('Synthetic-only sync acceptance; no dotenv, real models or production targets.');
for(const args of [[npm,'run','build','-w','backend'],[npm,'run','build','-w','local-agent'],['--import','tsx','--test','backend/test/sync-e2e.acceptance.ts']]){
 const child=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
 if(child.error)throw child.error;if(child.status!==0)process.exit(child.status??1);
}
