// Offline only: normal project index, refs and remotes are never changed.
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,realpathSync,lstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {inspect} from '../release-audit.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function checkpoint(){
 const git=(args,cwd=root)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const before=git(['status','--porcelain=v1']),index=git(['diff','--cached','--raw']);
 const paths=git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean),review=inspect(root,paths);
 if(review.blocked.length)throw new Error('Source review blocked');
 const output=mkdtempSync(join(root,'.phase1-work','private-activation-')),bundle=join(output,'original-history.bundle');
 git(['bundle','create',bundle,'--all']);git(['bundle','verify',bundle]);
 const repo=join(output,'repository');git(['clone','--no-checkout',bundle,repo]);git(['remote','remove','origin'],repo);git(['config','core.autocrlf','false'],repo);git(['config','core.safecrlf','false'],repo);git(['switch','-c','private/phase2-activation',git(['rev-parse','HEAD']).trim()],repo);
 const chosen=[...review.candidate,...review.review.filter(x=>x.path.endsWith('.md')&&x.reasons.length===1&&x.reasons[0]==='documentation-or-non-source')];const manifest=[];
 for(const item of chosen){const src=join(root,item.path);if(lstatSync(src).isSymbolicLink())throw Error('Linked source');const bytes=readFileSync(src);const dest=join(repo,item.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(src,dest);manifest.push({path:item.path,sha256:createHash('sha256').update(bytes).digest('hex')});}
 git(['add','--all'],repo);git(['-c','user.name=sakie local checkpoint','-c','user.email=checkpoint@local.invalid','commit','-m','chore: preserve phase 2 activation source (private only)'],repo);
 const commit=git(['rev-parse','HEAD'],repo).trim();git(['bundle','create',join(output,'complete-source.bundle'),'--all'],repo);
 // Prove recovery from the deliverable, not merely that a bundle file exists.
 const recovered=join(output,'recovered');git(['clone','-c','core.autocrlf=false','--branch','private/phase2-activation',join(output,'complete-source.bundle'),recovered]);git(['remote','remove','origin'],recovered);
 for(const item of manifest)if(createHash('sha256').update(readFileSync(join(recovered,item.path))).digest('hex')!==item.sha256)throw Error('Recovered source mismatch');
 if(git(['status','--porcelain=v1'])!==before||git(['diff','--cached','--raw'])!==index)throw Error('Original workspace changed');
 const result={commit,files:manifest.length,quarantined:review.review.filter(x=>x.reasons.includes('machine-identity')).map(x=>x.path),remotes:git(['remote'],repo).trim(),restored:true};
 writeFileSync(join(output,'manifest.json'),JSON.stringify({result,files:manifest},null,2));return{output,...result};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(checkpoint()));
