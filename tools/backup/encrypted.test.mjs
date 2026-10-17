import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,copyFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {Encrypter,Decrypter} from 'age-encryption';
import tar from 'tar-stream';
import {Readable} from 'node:stream';
import {createEncryptedBackup,verifyEncryptedBackup,restoreEncryptedBackup,pendingStatus,cleanupAbandoned,WORK_FACTOR} from './encrypted.mjs';
import {hiddenPassphrase} from './prompt.mjs';
import {legacySchema} from '../../backend/dist/database/legacy-schema.js';
import {databaseFingerprint} from '../../backend/dist/database/fingerprint.js';
import {windowsPowerShellEnv} from '../https-sync/accept.mjs';
const root=mkdtempSync(resolve('.phase1-work','encrypted-backup-lab-'));
writeFileSync(join(root,'.synthetic-owned'),'synthetic-current-run');
if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('tools/backup/test-private-scope.ps1'),'-FixtureRoot',root],{env:windowsPowerShellEnv(),stdio:'pipe'});
const secret=randomBytes(24).toString('base64url');const payload='synthetic-record-'+randomBytes(8).toString('hex');
const source=join(root,'source.db'),media=join(root,'media'),output=join(root,'out');mkdirSync(media);mkdirSync(output);
writeFileSync(join(media,'synthetic.bin'),Buffer.from([0,255,13,10,42]));
let db,fingerprint,archive;
const fresh=name=>{const p=join(root,name);mkdirSync(p);return p;};
const work=name=>fresh('work-'+name);const artifacts=[];
const options=(workspace,extra={})=>({workspace,passphrase:secret,...extra});
function clean(workspace){assert.equal(pendingStatus(workspace),null);assert.deepEqual(readdirSync(workspace),[]);}
before(async()=>{
 db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;'+legacySchema+'PRAGMA user_version=1; CREATE TABLE bytes(id INTEGER PRIMARY KEY, value BLOB);');
 db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run('11111111-1111-4111-8111-111111111111',payload,'synthetic','2026-10-17',3);db.prepare('INSERT INTO bytes VALUES(?,?)').run(1,Buffer.from([0,255,128]));fingerprint=databaseFingerprint(db);
 const workspace=work('initial');archive=join(output,'first.tar.age');await createEncryptedBackup({database:source,output:archive,mediaDir:media,mediaQuiesced:true,...options(workspace)});clean(workspace);
});
after(()=>{db?.close();writeFileSync(join(root,'evidence.json'),JSON.stringify({kind:'synthetic-encrypted-backup-acceptance',crypto:'age-v1',workFactor:WORK_FACTOR,checks:artifacts,realDataUsed:false},null,2));console.log('Synthetic evidence root: '+root);});
test('WAL-inclusive SQLite + binary media restore is exact and quarantined',async()=>{
 assert.ok(statSync(source+'-wal').size>0);const workspace=work('restore'),target=join(root,'recovered');const proof=await restoreEncryptedBackup({input:archive,target,...options(workspace)});assert.equal(proof.quarantined,true);
 const restored=new DatabaseSync(join(target,'sakie.db'),{readOnly:true});assert.equal(databaseFingerprint(restored),fingerprint);assert.equal(restored.prepare('SELECT content FROM memories').get().content,payload);assert.deepEqual([...restored.prepare('SELECT value FROM bytes').get().value],[0,255,128]);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');restored.close();
 assert.deepEqual([...readFileSync(join(target,'media','synthetic.bin'))],[0,255,13,10,42]);const marker=JSON.parse(readFileSync(join(target,'restore-info.json')));assert.equal(marker.requiresSessionRevocation,true);assert.equal(marker.requiresArchiveReconciliation,true);assert.ok(existsSync(join(target,'recovery-complete.json')));clean(workspace);artifacts.push('WAL/blob/media/fingerprint/quarantine exact restore');
});
test('standalone encrypted verify removes all temporary plaintext',async()=>{const w=work('verify');const proof=await verifyEncryptedBackup({input:archive,...options(w)});assert.deepEqual(proof,{verified:true,schemaVersion:1,files:2});clean(w);artifacts.push('authenticated standalone verification');});
test('plaintext metadata and content are concealed; each backup has independent salt and payload nonce',async()=>{
 const second=join(output,'second.tar.age'),w=work('random');await createEncryptedBackup({database:source,output:second,...options(w)});clean(w);const a=readFileSync(archive),b=readFileSync(second);
 for(const needle of [payload,'manifest.json','database.sqlite','synthetic.bin',fingerprint,secret])assert.equal(a.includes(Buffer.from(needle)),false);
 const salt=x=>x.toString('ascii').split('\n')[1].split(' ')[2];const nonce=x=>{const s=x.toString('latin1');const offset=s.indexOf('\n',s.indexOf('\n--- ')+1)+1;return x.subarray(offset,offset+16).toString('hex');};
 assert.notEqual(salt(a),salt(b));assert.notEqual(nonce(a),nonce(b));assert.notDeepEqual(a,b);artifacts.push('independent random salt/nonce and encrypted metadata');
});
test('wrong password cannot create a restore target or leave plaintext',async()=>{const w=work('wrong'),target=join(root,'wrong-target');await assert.rejects(restoreEncryptedBackup({input:archive,target,...options(w,{passphrase:randomBytes(24).toString('base64url')})}),e=>e.code==='AUTH_OR_FORMAT_FAILED');assert.equal(existsSync(target),false);clean(w);});
for(const kind of ['header','payload','truncated','trailing','expensive-kdf'])test('reject '+kind+' corruption before restore publish',async()=>{
 const bytes=readFileSync(archive);let changed=Buffer.from(bytes);if(kind==='header')changed[0]^=1;else if(kind==='payload')changed[changed.length-2]^=1;else if(kind==='truncated')changed=changed.subarray(0,changed.length-17);else if(kind==='trailing')changed=Buffer.concat([changed,Buffer.from('junk')]);else changed=Buffer.from(changed.toString('latin1').replace(/ 18\n/,' 29\n'),'latin1');
 const file=join(output,kind+'.tar.age');writeFileSync(file,changed);const w=work(kind),target=join(root,kind+'-restore');await assert.rejects(restoreEncryptedBackup({input:file,target,...options(w)}));assert.equal(existsSync(target),false);clean(w);
});
test('existing encrypted file and existing restore target are never overwritten',async()=>{const old=readFileSync(archive),w=work('exists');await assert.rejects(createEncryptedBackup({database:source,output:archive,...options(w)}),e=>e.code==='OUTPUT_EXISTS');assert.deepEqual(readFileSync(archive),old);const target=fresh('preexisting');writeFileSync(join(target,'keep'),'synthetic-external');await assert.rejects(restoreEncryptedBackup({input:archive,target,...options(w)}),e=>e.code==='RESTORE_TARGET_EXISTS');assert.equal(readFileSync(join(target,'keep'),'utf8'),'synthetic-external');clean(w);});
test('space preflight stops before any plaintext or output exists',async()=>{const w=work('space'),out=join(output,'no-space.tar.age');await assert.rejects(createEncryptedBackup({database:source,output:out,...options(w,{runtime:{availableBytes:()=>0}})}),e=>e.code==='INSUFFICIENT_SPACE');assert.equal(existsSync(out),false);clean(w);});
test('mid-write ENOSPC removes only owned partial and plaintext; retry succeeds',async()=>{const w=work('disk-full'),out=join(output,'disk-full.tar.age');let chunks=0;await assert.rejects(createEncryptedBackup({database:source,output:out,...options(w,{runtime:{checkpoint:phase=>{if(phase==='cipher-chunk'&&++chunks===2)throw Object.assign(Error('synthetic fault'),{code:'ENOSPC'});}}})}));assert.equal(existsSync(out),false);assert.equal(readdirSync(output).some(n=>n.startsWith('disk-full.tar.age.partial')),false);clean(w);await createEncryptedBackup({database:source,output:out,...options(w)});clean(w);artifacts.push('ENOSPC cleanup and same-name retry');});
test('abort after SQLite snapshot cleans plaintext and leaves original source unchanged',async()=>{const w=work('abort'),out=join(output,'aborted.tar.age'),controller=new AbortController();await assert.rejects(createEncryptedBackup({database:source,output:out,...options(w,{signal:controller.signal,runtime:{checkpoint:phase=>{if(phase==='snapshot-created')controller.abort();}}})}));assert.equal(existsSync(out),false);assert.equal(databaseFingerprint(db),fingerprint);clean(w);});
test('restore copy failure removes only this new target and scratch',async()=>{const w=work('copy-fail'),target=join(root,'copy-failure');await assert.rejects(restoreEncryptedBackup({input:archive,target,...options(w,{runtime:{checkpoint:phase=>{if(phase==='restore-file')throw Object.assign(Error('synthetic full'),{code:'ENOSPC'});}}})}));assert.equal(existsSync(target),false);clean(w);});
test('target appearing concurrently is preserved without changes',async()=>{const w=work('target-race'),target=join(root,'race-target');await assert.rejects(restoreEncryptedBackup({input:archive,target,...options(w,{runtime:{checkpoint:phase=>{if(phase==='before-restore-publish'){mkdirSync(target);writeFileSync(join(target,'keep'),'synthetic-race');}}}})}));assert.equal(readFileSync(join(target,'keep'),'utf8'),'synthetic-race');clean(w);});
test('weak password and unquiesced media are rejected',async()=>{const w=work('policy');await assert.rejects(createEncryptedBackup({database:source,output:join(output,'weak.tar.age'),...options(w,{passphrase:'short'})}),e=>e.code==='PASSPHRASE_POLICY');await assert.rejects(createEncryptedBackup({database:source,output:join(output,'media.tar.age'),mediaDir:media,...options(w)}),e=>e.code==='MEDIA_SCOPE_NOT_QUIESCED');clean(w);});
test('hard-killed job blocks reuse; only proved-dead owned job can be cleaned',async()=>{
 const w=work('hard-kill'),ready=join(root,'child-ready');const child=spawn(process.execPath,[resolve('tools/backup/test-crash-child.mjs'),w,source,join(output,'killed.tar.age'),ready],{stdio:'ignore',windowsHide:true});
 const exited=new Promise(ok=>child.once('exit',ok));const deadline=Date.now()+15000;while(!existsSync(ready)){if(child.exitCode!==null||Date.now()>deadline)throw Error('synthetic child did not reach checkpoint');await new Promise(r=>setTimeout(r,25));}
 const status=pendingStatus(w);assert.equal(status.pid,child.pid);assert.throws(()=>cleanupAbandoned(w,status.id),e=>e.code==='PROCESS_STILL_ALIVE');child.kill('SIGKILL');await exited;
 await assert.rejects(verifyEncryptedBackup({input:archive,...options(w)}),e=>e.code==='PENDING_REVIEW_REQUIRED');assert.equal(existsSync(join(w,'job-'+status.id,'plain')),true);assert.equal(cleanupAbandoned(w,status.id).cleaned,true);clean(w);artifacts.push('hard kill fail-closed, live PID refusal, proved-dead owned-only cleanup');
});
test('interactive prompt never echoes secret and restores terminal mode',async()=>{class Input extends EventEmitter{isTTY=true;isRaw=false;setRawMode(v){this.isRaw=v;}resume(){}pause(){}}const input=new Input(),shown=[];const promise=hiddenPassphrase('Hidden: ',{input,output:{isTTY:true,write:s=>shown.push(s)}});input.emit('data',Buffer.from(secret+'\r'));assert.equal(await promise,secret);assert.equal(shown.join(''),'Hidden: \n');assert.equal(input.isRaw,false);const cancelled=hiddenPassphrase('Hidden: ',{input,output:{isTTY:true,write:s=>shown.push(s)}});input.emit('data',Buffer.from('\x03'));await assert.rejects(cancelled,/INPUT_ABORTED/);assert.equal(input.isRaw,false);await assert.rejects(hiddenPassphrase('no',{input:{isTTY:false},output:{isTTY:false}}),/INTERACTIVE_TTY_REQUIRED/);});
test('CLI rejects secret argv options without leaking their contents',()=>{const value='synthetic-invalid-input-only';const r=spawnSync(process.execPath,['tools/backup/cli.mjs','create','--password',value],{encoding:'utf8'});assert.equal(r.status,1);assert.ok(r.stderr.includes('UNKNOWN_OR_DUPLICATE_ARGUMENT'));assert.equal(r.stderr.includes(value),false);assert.equal(r.stdout,'');});

test('authenticated but unsafe tar paths/duplicates are rejected',async()=>{
 for(const kind of ['traversal','duplicate','link']){
  const pack=tar.pack();if(kind==='traversal')pack.entry({name:'../escape',size:1},'x');
  if(kind==='duplicate'){pack.entry({name:'manifest.json',size:2},'{}');pack.entry({name:'MANIFEST.json',size:2},'{}');}
  if(kind==='link')pack.entry({name:'media/link',type:'symlink',linkname:'../outside'});
  pack.finalize();const e=new Encrypter();e.setScryptWorkFactor(WORK_FACTOR);e.setPassphrase(secret);const bytes=await e.encrypt(Readable.toWeb(Readable.from(pack,{objectMode:false})));const file=join(output,'unsafe-'+kind+'.tar.age');const handle=await import('node:fs/promises').then(fs=>fs.open(file,'wx'));try{for await(const chunk of bytes)await handle.writeFile(chunk);}finally{await handle.close();}
  const w=work('unsafe-'+kind),target=join(root,'unsafe-'+kind);await assert.rejects(restoreEncryptedBackup({input:file,target,...options(w)}));assert.equal(existsSync(target),false);assert.equal(existsSync(join(root,'escape')),false);clean(w);
 }
});
test('interrupted cipher publish preserves concurrent final and unrelated workspace files',async()=>{
 const w=work('publish-race'),out=join(output,'publish-race.tar.age');const outside=join(w,'keep.txt');writeFileSync(outside,'synthetic-unrelated');
 await assert.rejects(createEncryptedBackup({database:source,output:out,...options(w,{runtime:{checkpoint:phase=>{if(phase==='before-publish')writeFileSync(out,'synthetic-concurrent-output',{flag:'wx'});}}})}));
 assert.equal(readFileSync(out,'utf8'),'synthetic-concurrent-output');assert.equal(readFileSync(outside,'utf8'),'synthetic-unrelated');assert.equal(pendingStatus(w),null);assert.deepEqual(readdirSync(w),['keep.txt']);
});
test('split UTF-8 password input is decoded without echo',async()=>{
 class Input extends EventEmitter{isTTY=true;setRawMode(){}resume(){}pause(){}}const input=new Input(),shown=[];const result=hiddenPassphrase('Hidden: ',{input,output:{isTTY:true,write:s=>shown.push(s)}});const bytes=Buffer.from('合成测试文字');input.emit('data',bytes.subarray(0,2));input.emit('data',bytes.subarray(2));input.emit('data',Buffer.from('\r'));assert.equal(await result,'合成测试文字');assert.equal(shown.join(''),'Hidden: \n');
});

test('actual CLI private-scope gate rejects piped password input before touching data',()=>{
 const r=spawnSync(process.execPath,['tools/backup/cli.mjs','create','--database',source,'--output',join(root,'cli-output','not-created.tar.age'),'--workspace',join(root,'cli-work')],{encoding:'utf8',stdio:['pipe','pipe','pipe'],input:'synthetic-unused-pipe\n'});
 assert.equal(r.status,1);assert.ok(r.stderr.includes('INTERACTIVE_TTY_REQUIRED'));assert.equal(r.stdout,'');assert.equal(existsSync(join(root,'cli-output','not-created.tar.age')),false);clean(join(root,'cli-work'));
});

test('unknown or malformed pending metadata is preserved and cannot authorize cleanup',()=>{
 const w=work('unknown-state'),pending=join(w,'operation.pending.json');const original=JSON.stringify({format:1,id:'11111111-1111-4111-8111-111111111111',pid:98765432,operation:'restore',state:'unknown',target:null});writeFileSync(pending,original);
 assert.throws(()=>pendingStatus(w),e=>e.code==='CLEANUP_REVIEW_REQUIRED');assert.throws(()=>cleanupAbandoned(w,'11111111-1111-4111-8111-111111111111'),e=>e.code==='CLEANUP_REVIEW_REQUIRED');assert.equal(readFileSync(pending,'utf8'),original);
});
