import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,join,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export function classify(path){
 const p=path.replaceAll('\\','/');
 if(p.startsWith('/')||p.split('/').includes('..'))return 'excluded';
 if(/(^|\/)(node_modules|dist|\.git|\.phase1-work|data|backups|uploads|secrets|\.secrets)(\/|$)/i.test(p))return 'excluded';
 const name=p.split('/').at(-1);
 if((/^\.env(?:\.|$)/i.test(name)&&name!=='.env.example')||/^(?:\.npmrc|owner\.json|id_rsa|id_ed25519|credentials.*\.json|agent-credentials.*\.json|pairing-code.*\.txt|sync-production-approval.*\.json|sync-policy\.local\.json|acl-plan.*\.json)$/i.test(name))return 'excluded';
 if(/\.(?:db|sqlite|sqlite3|db3)(?:[-.]|$)|\.(?:log|pem|key|pfx|p12|zip|gz|bak)$/i.test(name))return 'excluded';
 if(p.startsWith('docs/')||name==='FILES.txt')return 'review-only';
 if(/^(?:backend|frontend|local-agent|packages|tools|\.github)\//.test(p)||['package.json','package-lock.json','.gitignore','.dockerignore','.env.example','README.md','compose.yaml','compose.release.json'].includes(p))return 'candidate';
 return 'review-only';
}
export function findings(text){
 const result=[];
 if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAGE-SECRET-KEY-[A-Z0-9]{20,}|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/.test(text))result.push('credential-signature');
 if(/S-1-5-21-(?:\d+-){2,}\d+|[A-Z]:[\\/]Users[\\/][^\s\\/]+/i.test(text))result.push('machine-identity');
 for(const match of text.matchAll(/\b(?:api_?key|password|token|secret)\s*[:=]\s*['"]([A-Za-z0-9_./+=-]{24,})['"]/gi))if(!/test|synthetic|fake|example|placeholder/i.test(match[1]))result.push('sensitive-assignment');
 for(const line of text.split(/\r?\n/))if(/^[A-Z_]*(?:API_KEY|PASSWORD|TOKEN|SECRET)\s*=\s*\S{16,}/.test(line)&&!/(?:example|test|fake|placeholder)/i.test(line))result.push('environment-secret');
 return [...new Set(result)];
}
export function inspect(root,paths){
 const canonical=realpathSync(root),candidate=[],review=[],excluded=[],blocked=[];
 for(const path of [...new Set(paths)].sort()){
  const kind=classify(path);if(kind==='excluded'){excluded.push({path,reason:'sensitive-or-generated-path'});continue;}
  const full=resolve(root,path),rel=relative(canonical,realpathSync(full));
  if(lstatSync(full).isSymbolicLink()||rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe source object');
  if(kind==='review-only'){
   const issues=extname(path)==='.md'||path==='FILES.txt'?findings(readFileSync(full,'utf8')):[];
   review.push({path,reasons:issues.length?issues:['documentation-or-non-source']});continue;
  }
  if(!['.ts','.tsx','.js','.mjs','.json','.yaml','.yml','.html','.css','.md','.ps1','.svg','.conf','.xml',''].includes(extname(path))&&!path.endsWith('.env.example')){review.push({path,reasons:['binary-or-unknown-format']});continue;}
  const bytes=readFileSync(full),issues=findings(bytes.toString('utf8'));
  if(issues.length){blocked.push({path,reasons:issues});continue;}
  candidate.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
 }
 return{candidate,review,excluded,blocked};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const root=fileURLToPath(new URL('../',import.meta.url));
 const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
 const indexBefore=git(['diff','--cached','--raw']);
 const paths=git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean);
 const report=inspect(root,paths);report.baseCommit=git(['rev-parse','HEAD']).trim();report.publicationAuthorized=false;
 const outputParent=join(root,'.phase1-work');mkdirSync(outputParent,{recursive:true});
 const output=mkdtempSync(join(outputParent,'source-release-review-'));
 writeFileSync(join(output,'source-plan.json'),JSON.stringify(report,null,2),{flag:'wx'});
 if(git(['diff','--cached','--raw'])!==indexBefore)throw new Error('Normal index unexpectedly changed');
 console.log(JSON.stringify({candidateFiles:report.candidate.length,reviewOnly:report.review.length,excluded:report.excluded.length,blocked:report.blocked.length,reviewIdentityFiles:report.review.filter(x=>x.reasons.includes('machine-identity')).length,manifest:join(output,'source-plan.json'),publicationAuthorized:false}));
 if(report.blocked.length)process.exitCode=1;
}
