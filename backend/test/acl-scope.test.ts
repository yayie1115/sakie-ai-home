import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {temporaryDirectory} from './helpers.js';
import {repositoryRoot} from '../src/config/env.js';
for(const scenario of ['blocked','protected','flags','links','exact'])test('isolated ACL scope: '+scenario,{skip:process.platform!=='win32'},()=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];env.PSModulePath=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules');
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(repositoryRoot,'backend/test/fixtures/acl-scope-lab.ps1'),'-FixtureRoot',join(temporaryDirectory(),'new-lab'),'-Case',scenario],{cwd:repositoryRoot,env,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp('LAB_OK '+scenario));
});
