import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
export const repositoryRoot = fileURLToPath(new URL('../../../',import.meta.url));
export function parseConfig(env: NodeJS.ProcessEnv) {
  const port=Number(env.PORT ?? 3000);
  if (!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be an integer between 1 and 65535');
  const nodeEnv=env.NODE_ENV??'development';
  if(!['development','test','production'].includes(nodeEnv))throw new Error('Invalid NODE_ENV');
  const host=env.HOST??'127.0.0.1';if(!host.trim())throw new Error('HOST must not be empty');
  const runtimeRole=env.RUNTIME_ROLE??'cloud';if(runtimeRole!=='cloud'&&runtimeRole!=='windows')throw new Error('Invalid RUNTIME_ROLE');
  const nonEmpty=(value:string,name:string)=>{if(!value.trim())throw new Error(name+' must not be empty');return value;};
  const defaultData=join(dirname(repositoryRoot),(basename(repositoryRoot)||'sakie-ai-home')+'-data',runtimeRole);
  const dataDir=resolve(nonEmpty(env.DATA_DIR??(env.DATABASE_PATH&&env.DATABASE_PATH!==':memory:'?dirname(resolve(env.DATABASE_PATH)):defaultData),'DATA_DIR'));
  const databasePath=env.DATABASE_PATH=== ':memory:'?':memory:':resolve(nonEmpty(env.DATABASE_PATH??join(dataDir,'sakie.db'),'DATABASE_PATH'));
  const backupDir=resolve(nonEmpty(env.BACKUP_DIR??join(dirname(repositoryRoot),(basename(repositoryRoot)||'sakie-ai-home')+'-backups',runtimeRole),'BACKUP_DIR'));
  if(databasePath!==':memory:'&&databasePath===resolve(backupDir,'database.sqlite'))throw new Error('Backup must not overwrite database');
  const rawOrigin=nonEmpty(env.PUBLIC_ORIGIN??('http://127.0.0.1:5173'),'PUBLIC_ORIGIN');
  const origin=new URL(rawOrigin);
  if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
  if(nodeEnv==='production'&&(!env.PUBLIC_ORIGIN||origin.protocol!=='https:'))throw new Error('Production requires an explicit HTTPS PUBLIC_ORIGIN');
  const allowedOrigins=nodeEnv==='development'&&['127.0.0.1','localhost'].includes(origin.hostname)?[origin.protocol+'//'+(origin.hostname==='localhost'?'127.0.0.1':'localhost')+(origin.port?':'+origin.port:'')]:[];
  const credentialPath=resolve(nonEmpty(env.OWNER_CREDENTIAL_FILE??join(dataDir,'auth','owner.json'),'OWNER_CREDENTIAL_FILE'));
  const sessionHours=Number(env.SESSION_HOURS??168);if(!Number.isFinite(sessionHours)||sessionHours<1||sessionHours>720)throw new Error('Invalid SESSION_HOURS');
  if(nodeEnv!=='production'){for(const target of [dataDir,backupDir,credentialPath,...(databasePath===':memory:'?[]:[databasePath])]){const rel=relative(resolve(repositoryRoot),target);if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new Error('Runtime storage must be outside the source project');}}
  return Object.freeze({port,host,nodeEnv,runtimeRole,dataDir,databasePath,backupDir,credentialPath,publicOrigin:origin.origin,allowedOrigins,secureCookies:nodeEnv==='production',sessionTtlMs:sessionHours*3600000});
}
export const config=parseConfig(process.env);
