// Explicit maintenance command; --check-runtime never reads a database or owner file.
import {readFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {loadReleaseRuntime,releaseCandidate} from './release-candidate.mjs';
const args=process.argv.slice(2);
function value(flag){const i=args.indexOf(flag);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing maintenance argument');return args[i+1];}
try{
 const backendDist=value('--backend-dist');if(!isAbsolute(backendDist))throw Error('Absolute compiled runtime required');
 if(args.includes('--check-runtime')){await loadReleaseRuntime(backendDist);console.log(JSON.stringify({runtimeImports:true,databaseOpened:false}));}
 else{
  const input=JSON.parse(readFileSync(resolve(value('--input')),'utf8'));
  // Fixed container maintenance scope; no automatic confirmation or fallback owner.
  const result=await releaseCandidate({database:'/app/data/sakie.db',ownerFile:'/run/sakie/owner.json',expectedFingerprint:input.expectedFingerprint,confirmation:input.confirmation,backendDist});
  console.log(JSON.stringify({released:true,fingerprint:result.fingerprint}));
 }
}catch{console.error('Candidate maintenance stopped; review scope/runtime/fingerprint/identity and preserve audit.');process.exitCode=1;}
