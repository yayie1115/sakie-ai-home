import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,realpathSync,copyFileSync} from 'node:fs';
import {join,relative,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {findings} from '../release-audit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function buildPackage({build=true}={}){
 if(build){const npm=process.env.npm_execpath;if(!npm)throw new Error('Use npm run prepare:sync:https');for(const workspace of ['backend','local-agent'])execFileSync(process.execPath,[npm,'run','build','-w',workspace],{cwd:root,stdio:'inherit'});}
 const runId=randomUUID(),output=join(root,'.phase1-work','https-deploy-'+runId);mkdirSync(output,{recursive:true});
 const files=['package.json','package-lock.json','backend/package.json','frontend/package.json','local-agent/package.json','packages/contracts/package.json','packages/contracts/src/index.d.ts','tools/https-sync/cloud.mjs','tools/https-sync/Dockerfile'];
 function walk(dir){for(const item of readdirSync(join(root,dir),{withFileTypes:true})){const p=join(dir,item.name);if(item.isSymbolicLink())throw new Error('Linked package object');if(item.isDirectory())walk(p);else if(item.name.endsWith('.js'))files.push(p);else if(!item.name.endsWith('.js.map'))throw new Error('Unexpected built artifact');}}
 walk('backend/dist');const manifest=[];
 for(const p of files){const src=join(root,p);if(lstatSync(src).isSymbolicLink()||relative(realpathSync(root),realpathSync(src)).startsWith('..'))throw new Error('Unsafe package path');const bytes=readFileSync(src);if(findings(bytes.toString('utf8')).length)throw new Error('Package content needs private review');const to=join(output,p);mkdirSync(dirname(to),{recursive:true});copyFileSync(src,to);manifest.push({path:p.replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex')});}
 for(const [source,target] of [['compose.json','compose.json'],['nginx.conf','nginx.conf'],['nginx-http.conf','nginx-http.conf'],['OPERATIONS.md','OPERATIONS.md']]){const bytes=readFileSync(join(root,'tools/https-sync',source));writeFileSync(join(output,target),bytes);manifest.push({path:target,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const config={version:1,environment:'production',origin:'https://sync-check.sakiehome.icu',runId};
 const env=`ACCEPTANCE_RUN_ID=${runId}\nPUBLIC_ORIGIN=${config.origin}\n`;writeFileSync(join(output,'acceptance.env'),env);
 writeFileSync(join(output,'windows-run.template.json'),JSON.stringify(config,null,2));
 for(const p of ['acceptance.env','windows-run.template.json'])manifest.push({path:p,sha256:createHash('sha256').update(readFileSync(join(output,p))).digest('hex')});
 writeFileSync(join(output,'manifest.json'),JSON.stringify({kind:'synthetic-https-deployment-v1',runId,files:manifest},null,2));
 const archive=output+'.tar.gz';execFileSync('tar',['-czf',archive,'-C',output,'.'],{stdio:'pipe'});
 const sha256=createHash('sha256').update(readFileSync(archive)).digest('hex');writeFileSync(archive+'.sha256',sha256+'  '+archive.split(/[\\/]/).at(-1)+'\n');
 return {output,archive,sha256,runId,files:manifest.length};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(buildPackage()));
