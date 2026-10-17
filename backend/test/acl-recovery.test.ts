import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {temporaryDirectory} from './helpers.js';
import {repositoryRoot} from '../src/config/env.js';
const cases=['snapshot','ace-output','preflight','hardlink','symlink','before-change','success','failure','recovery-failure','concurrent','forbidden-change','audit-failure-before','audit-failure-after','tamper-audit','recovery-partial','acl-change','inventory-change','audit-locked','truncated-audit','write-window-change'];
for(const scenario of cases)test('isolated ACL audit/recovery: '+scenario,{skip:process.platform!=='win32'},(t)=>{
 const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];env.PSModulePath=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(repositoryRoot,'backend/test/fixtures/acl-recovery-lab.ps1'),'-FixtureRoot',join(temporaryDirectory(),'new-recovery-lab'),'-Case',scenario],{cwd:repositoryRoot,env,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(r.status,0,r.stderr);if(r.stdout.includes('LAB_UNAVAILABLE')){t.skip(r.stdout.trim());return;}assert.match(r.stdout,new RegExp('LAB_OK '+scenario));
});
