import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {temporaryDirectory} from './helpers.js';
import {repositoryRoot} from '../src/config/env.js';
const cases=['propagation','interrupt-1','interrupt-2','interrupt-3','loss-write-dac','concurrent-inventory','forbidden-change','audit-locked','audit-unavailable-after','audit-corrupt','recovery-fails-again','recovery-concurrent','untrusted-postwrite','process-kill-window'];
for(const scenario of cases)test('synthetic directory ACL: '+scenario,{skip:process.platform!=='win32'},()=>{
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];env.PSModulePath=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');
 const root=join(temporaryDirectory(),'new-directory-lab');
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(repositoryRoot,'backend/test/fixtures/acl-directory-lab.ps1'),'-FixtureRoot',root,'-Case',scenario],{cwd:repositoryRoot,env,encoding:'utf8',windowsHide:true,timeout:120000});
 if(scenario==='process-kill-window'){
  assert.equal(r.status,83,r.stderr);const records=readFileSync(join(root,'directory-audit.jsonl'),'utf8').trim().split(/\r?\n/).map(s=>JSON.parse(JSON.parse(s).Payload));
  assert.equal(records.at(-1).Kind,'write-intent');assert.equal(existsSync(join(root,'directory-result.json')),false);assert.equal(readFileSync(join(root,'target/preserved/z-denied.txt'),'utf8'),'SYNTHETIC:preserved\\z-denied.txt');return;
 }
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,new RegExp('DIR_LAB_OK '+scenario));
 const evidence=JSON.parse(readFileSync(join(root,'directory-result.json'),'utf8'));assert.ok(evidence.Original);assert.ok(evidence.Observed);assert.ok(evidence.CannotProve.length>0);
});
