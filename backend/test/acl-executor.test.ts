import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {temporaryDirectory} from './helpers.js';
import {repositoryRoot} from '../src/config/env.js';
const cases=['success','existing-session-root','outside-path','closed-inheritance','forbidden-conflict','duplicate','unregistered-same-count','profile-type','review-tampered','preflight-denied','inventory-before','after-first','audit-before','audit-after-intent','audit-after-native','unexpected-after-native','inventory-after-first','content-after-first','forbidden-after-first','lose-dac-after-first','one-shot'];
for(const scenario of cases)test('minimal synthetic ACL executor: '+scenario,{skip:process.platform!=='win32'},()=>{
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];env.PSModulePath=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(repositoryRoot,'backend/test/fixtures/acl-executor-lab.ps1'),'-FixtureRoot',join(temporaryDirectory(),'new-executor-lab'),'-Case',scenario],{cwd:repositoryRoot,env,encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,new RegExp('EXECUTOR_OK '+scenario));
});
