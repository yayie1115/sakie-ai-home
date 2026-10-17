import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {superviseProcess} from './supervision.mjs';
const root=mkdtempSync(resolve('.phase1-work','supervision-lab-'));
const child=(name,body)=>({command:process.execPath,args:['--input-type=module','-e',body],cwd:root});
test('real child crash restarts, then clean exit stops; no child output captured',async()=>{
 const counter=join(root,'restarts.json');const states=[];
 await superviseProcess({...child('restart',`import{existsSync,readFileSync,writeFileSync}from'node:fs';const f=${JSON.stringify(counter)};const n=existsSync(f)?Number(readFileSync(f)):0;writeFileSync(f,String(n+1));process.exit(n===0?7:0);`),readState:()=>({retry:{phase:'caught-up'}}),status:s=>states.push(s),restartDelayMs:10});
 assert.equal(readFileSync(counter,'utf8'),'2');assert.deepEqual(states,['running','restart-backoff','running','stopped']);
});
for(const phase of ['blocked',undefined,'future-unknown'])test(`unsafe state ${phase} never restarts`,async()=>{
 const states=[];await assert.rejects(superviseProcess({...child('blocked','process.exit(9)'),readState:()=>({retry:{phase}}),status:s=>states.push(s),restartDelayMs:1}));assert.deepEqual(states,['running','blocked-review-required']);
});
test('status read failure stops without a retry',async()=>{const states=[];await assert.rejects(superviseProcess({...child('unknown','process.exit(9)'),readState:()=>{throw Error('unavailable')},status:s=>states.push(s)}));assert.deepEqual(states,['running','blocked-review-required']);});
test('stop interrupts 30s backoff immediately',async()=>{const abort=new AbortController();const states=[];const at=Date.now();await superviseProcess({...child('backoff','process.exit(9)'),readState:()=>({retry:{phase:'offline'}}),signal:abort.signal,status:s=>{states.push(s);if(s==='restart-backoff')setTimeout(()=>abort.abort(),20);}});assert.ok(Date.now()-at<2000);assert.equal(states.at(-1),'stopped');assert.equal(states.filter(s=>s==='running').length,1);});
test('stop kills active synthetic child without leaving a writer',async()=>{const abort=new AbortController();const started=join(root,'child.started');const heartbeat=join(root,'child.heartbeat');const states=[];
 const timer=setInterval(()=>{if(existsSync(started))abort.abort();},20);
 try{await superviseProcess({...child('active',`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`),signal:abort.signal,status:s=>states.push(s),readState:()=>{throw Error('must not inspect after stop')}});}finally{clearInterval(timer);}
 const value=existsSync(heartbeat)?readFileSync(heartbeat,'utf8'):null;await new Promise(r=>setTimeout(r,100));assert.equal(existsSync(heartbeat)?readFileSync(heartbeat,'utf8'):null,value);assert.equal(states.at(-1),'stopped');
});
test('spawn failure is sanitized and blocked',async()=>{const states=[];await assert.rejects(superviseProcess({command:join(root,'missing-node.exe'),args:[],cwd:root,readState:()=>({retry:{phase:'offline'}}),status:s=>states.push(s)}),/could not start/);assert.equal(states.at(-1),'blocked-review-required');});
test('pre-aborted invocation spawns nothing',async()=>{const abort=new AbortController();abort.abort();const states=[];await superviseProcess({...child('none','process.exit(9)'),signal:abort.signal,status:s=>states.push(s),readState:()=>{throw Error()}});assert.deepEqual(states,['stopped']);});

test('task XML omits byte encoding so COM BSTR and UTF-8 files both parse',async()=>{
 const {render}=await import('./render.mjs');const task=render('https://activation.example.invalid',process.execPath,['S',1,5,21,111,222,333,444].join('-')).task;
 assert.ok(task.startsWith('<?xml version="1.0"?>'));assert.ok(!task.includes('encoding='));
});

test('maintenance runtime loader imports compiled modules without opening data',async()=>{
 const {loadReleaseRuntime}=await import('./release-candidate.mjs');const [credentials,fingerprint,migrations]=await loadReleaseRuntime();
 assert.equal(typeof credentials.loadOwnerCredential,'function');assert.equal(typeof fingerprint.databaseFingerprint,'function');assert.equal(typeof migrations.assertMigrationHistory,'function');
 await assert.rejects(loadReleaseRuntime(join(root,'missing-runtime')));
});
