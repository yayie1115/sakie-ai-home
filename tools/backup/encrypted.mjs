// Standard age v1 + tar. No custom cryptography; never returns/logs passphrases or data.
import {Encrypter,Decrypter} from 'age-encryption';
import tar from 'tar-stream';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createReadStream,createWriteStream,existsSync,lstatSync,realpathSync,readdirSync,statSync,statfsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,unlinkSync,linkSync,rmSync,copyFileSync,constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,isAbsolute,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createBackup,verifyBackup,restoreBackup} from '../../backend/dist/database/backup.js';
export const WORK_FACTOR=18; // scrypt N=2^18, r=8,p=1 (256 MiB), age library implementation.
const MiB=1024**2;
export class BackupError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new BackupError(code);};
function present(p){try{lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function canonical(p){p=resolve(p);let at=p;while(true){if(present(at)&&lstatSync(at).isSymbolicLink())fail('LINKED_PATH');const up=dirname(at);if(up===at)break;at=up;}if(present(p)){const actual=realpathSync(p);if((process.platform==='win32'?actual.toLowerCase():actual)!==(process.platform==='win32'?p.toLowerCase():p))fail('LINKED_PATH');}return p;}
function directory(p){p=canonical(p);if(!lstatSync(p).isDirectory())fail('DIRECTORY_REQUIRED');return p;}
function inside(parent,child){const rel=relative(parent,child);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));}
function password(value){if(typeof value!=='string'||Array.from(value).length<20||value.length>1024||/[\x00\r\n]/.test(value))fail('PASSPHRASE_POLICY');}
function durable(file,value,flags='w'){const fd=openSync(file,flags,0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}}
function safeName(name){if(typeof name!=='string'||name.includes('\\')||name.startsWith('/')||name.split('/').some(s=>!s||s==='.'||s==='..'||/[<>:"|?*\x00-\x1f]/.test(s)||/[ .]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))fail('UNSAFE_ARCHIVE');if(name!=='manifest.json'&&name!=='database.sqlite'&&!name.startsWith('media/'))fail('UNEXPECTED_ARCHIVE_ENTRY');return name;}
function files(root,prefix=''){let out=[];for(const e of readdirSync(join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+e.name:e.name;const p=canonical(join(root,name));if(e.isDirectory())out.push(...files(root,name));else if(e.isFile())out.push({name,path:p,size:statSync(p).size});else fail('LINKED_PATH');}return out;}
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
function capacity(path,needed,options){const available=options.runtime?.availableBytes?.(path)??(()=>{const s=statfsSync(path);return Number(s.bavail)*Number(s.bsize);})();if(!Number.isFinite(needed)||available<needed+(options.minFreeBytes??1024**3))fail('INSUFFICIENT_SPACE');}
async function checkpoint(options,phase){options.signal?.throwIfAborted();await options.runtime?.checkpoint?.(phase);options.signal?.throwIfAborted();}
function lease(workspace,operation,target){
 const root=directory(workspace),pending=join(root,'operation.pending.json');if(present(pending))fail('PENDING_REVIEW_REQUIRED');
 const id=randomUUID(),job=join(root,'job-'+id),record={format:1,id,pid:process.pid,operation,state:'active',target:target??null};
 durable(pending,JSON.stringify(record),'wx');mkdirSync(job,{mode:0o700});durable(join(job,'.owned.json'),JSON.stringify({id}),'wx');
 return{root,pending,job,record,update(state){record.state=state;durable(pending,JSON.stringify(record));}};
}
function readRecord(file){
 let r;try{r=JSON.parse(readFileSync(canonical(file),'utf8'));}catch{fail('CLEANUP_REVIEW_REQUIRED');}
 if(r.format!==1||!/^[-a-f0-9]{36}$/.test(r.id)||!Number.isSafeInteger(r.pid)||r.pid<1||!['create','verify','restore'].includes(r.operation)||!['active','restore-complete'].includes(r.state)||(r.state==='restore-complete'&&r.operation!=='restore')||(r.target!==null&&(typeof r.target!=='string'||!isAbsolute(r.target)||r.operation!=='restore')))fail('CLEANUP_REVIEW_REQUIRED');return r;
}
function ownedDelete(root,id,marker='.owned.json'){
 root=canonical(root);if(!lstatSync(root).isDirectory()||!present(join(root,marker))||JSON.parse(readFileSync(canonical(join(root,marker)),'utf8')).id!==id)fail('CLEANUP_REVIEW_REQUIRED');
 // Verify the exact newly-owned absolute subtree before recursive deletion; never follow links.
 files(root);rmSync(root,{recursive:true});
}
function finish(l,success=false){
 const saved=readRecord(l.pending);if(JSON.stringify(saved)!==JSON.stringify(l.record))fail('CLEANUP_REVIEW_REQUIRED');
 if(saved.target&&present(saved.target)&&!success&&saved.state!=='restore-complete')ownedDelete(saved.target,saved.id,'.encrypted-restore-owner.json');
 if(!inside(l.root,l.job)||dirname(l.job)!==l.root||basename(l.job)!=='job-'+saved.id)fail('CLEANUP_REVIEW_REQUIRED');
 ownedDelete(l.job,saved.id);unlinkSync(l.pending);
}
export function pendingStatus(workspace){const root=directory(workspace),file=join(root,'operation.pending.json');if(!present(file))return null;const r=readRecord(file);return{id:r.id,pid:r.pid,operation:r.operation,state:r.state};}
export function cleanupAbandoned(workspace,id){
 const root=directory(workspace),pending=join(root,'operation.pending.json');const record=readRecord(pending);
 if(record.format!==1||record.id!==id||!/^[-a-f0-9]{36}$/.test(id)||!Number.isSafeInteger(record.pid)||record.pid<1)fail('CLEANUP_REVIEW_REQUIRED');
 try{process.kill(record.pid,0);fail('PROCESS_STILL_ALIVE');}catch(e){if(e.code!=='ESRCH')throw e;}
 if(record.state==='restore-complete'&&record.target){const done=JSON.parse(readFileSync(join(canonical(record.target),'recovery-complete.json'),'utf8'));if(done.id!==id)fail('CLEANUP_REVIEW_REQUIRED');}
 const job=join(root,'job-'+id);finish({root,pending,job,record},record.state==='restore-complete');return{cleaned:true};
}
function packSnapshot(snapshot,manifest){
 const pack=tar.pack();const stream=Readable.toWeb(Readable.from(pack,{objectMode:false}));const names=['manifest.json',...manifest.files.map(f=>safeName(f.path))];
 const done=(async()=>{for(const name of names){const file=join(snapshot,name);const entry=pack.entry({name,size:statSync(file).size,type:'file',mode:0o600,mtime:new Date(0)});await pipeline(createReadStream(file),entry);}pack.finalize();})();
 // Attach immediately so an asynchronous producer failure cannot become an unhandled rejection.
 done.catch(e=>pack.destroy(e));return{stream,done};
}
async function extractVerified(input,passphrase,job,options){
 const file=canonical(input);if(!lstatSync(file).isFile())fail('ARCHIVE_REQUIRED');const max=options.maxBytes??30*1024**3;
 if(statSync(file).size>max+MiB)fail('ARCHIVE_LIMIT');
 const out=join(job,'decrypted');mkdirSync(out,{mode:0o700});
 const d=new Decrypter();d.addPassphrase(passphrase);
 // This tool accepts its single-scrypt-18 age profile only, before the library runs a KDF.
 // Other standard age profiles remain recoverable with upstream age; no crypto is implemented here.
 let prefix=Buffer.alloc(0),checked=false;
 const checkPrefix=()=>{if(!/^age-encryption\.org\/v1\n-> scrypt [A-Za-z0-9+/]{22} 18\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n/.test(prefix.subarray(0,256).toString('ascii')))fail('AUTH_OR_FORMAT_FAILED');checked=true;};
 const gate=new Transform({transform(chunk,_encoding,cb){try{if(checked)return cb(null,chunk);prefix=Buffer.concat([prefix,chunk]);if(prefix.length>=256){checkPrefix();cb(null,prefix);prefix=Buffer.alloc(0);}else cb();}catch(e){cb(e);}},flush(cb){try{if(!checked){checkPrefix();this.push(prefix);}cb();}catch(e){cb(e);}}});
 const inputStream=createReadStream(file);inputStream.on('error',e=>gate.destroy(e));inputStream.pipe(gate);
 const source=Readable.toWeb(gate);let decrypted;
 try{decrypted=await d.decrypt(source);}catch{inputStream.destroy();gate.destroy();await source.cancel().catch(()=>{});fail('AUTH_OR_FORMAT_FAILED');}
 const extract=tar.extract(),seen=new Map();let total=0,count=0;
 extract.on('entry',(h,entry,next)=>{entry.on('error',()=>{});try{
  const name=safeName(h.name),key=name.toLowerCase();if(h.type!=='file'||h.linkname||seen.has(key)||++count>100001||!Number.isSafeInteger(h.size)||h.size<0||h.size>max)fail('UNSAFE_ARCHIVE');
  seen.set(key,name);const target=join(out,name);mkdirSync(dirname(target),{recursive:true,mode:0o700});
  pipeline(entry,createWriteStream(target,{flags:'wx',mode:0o600})).then(()=>next(),e=>extract.destroy(e));
 }catch(e){extract.destroy(e);}});
 const limit=new Transform({transform(chunk,_encoding,cb){total+=chunk.length;try{options.signal?.throwIfAborted();if(total>max)fail('ARCHIVE_LIMIT');cb(null,chunk);}catch(e){cb(e);}}});
 try{await pipeline(Readable.fromWeb(decrypted),limit,extract);const manifest=await verifyBackup(out);const allowed=['manifest.json',...manifest.files.map(f=>safeName(f.path))];if(allowed.length!==seen.size||allowed.some(n=>seen.get(n.toLowerCase())!==n))fail('UNEXPECTED_ARCHIVE_ENTRY');return{snapshot:out,manifest};}
 catch(e){if(e instanceof BackupError)throw e;fail('AUTH_OR_FORMAT_FAILED');}finally{inputStream.destroy();gate.destroy();}
}
async function writeCipher(stream,file,options,onOpen){
 const handle=await open(file,'wx',0o600);onOpen();let written=0;
 try{for await(const chunk of stream){await checkpoint(options,'cipher-chunk');written+=chunk.length;let offset=0;while(offset<chunk.length){const r=await handle.write(chunk,offset,chunk.length-offset);if(!r.bytesWritten)fail('SPACE_OR_IO_FAILED');offset+=r.bytesWritten;}}await handle.sync();return written;}finally{await handle.close();}
}
export async function createEncryptedBackup({database,output,workspace,passphrase,mediaDir,mediaQuiesced,...options}){
 password(passphrase);database=canonical(database);output=resolve(output);const parent=directory(dirname(output));if(!output.endsWith('.tar.age'))fail('AGE_EXTENSION_REQUIRED');if(present(output))fail('OUTPUT_EXISTS');
 if(!lstatSync(database).isFile())fail('DATABASE_REQUIRED');
 let size=statSync(database).size;const wal=database+'-wal';if(present(wal)){canonical(wal);size+=statSync(wal).size;}
 if(mediaDir){mediaDir=directory(mediaDir);if(!mediaQuiesced||inside(mediaDir,resolve(workspace))||inside(mediaDir,output))fail('MEDIA_SCOPE_NOT_QUIESCED');size+=files(mediaDir).reduce((n,f)=>n+f.size+1024,0);}
 if(size>(options.maxBytes??30*1024**3))fail('ARCHIVE_LIMIT');capacity(directory(workspace),3*size+32*MiB,options);capacity(parent,2*size+32*MiB,options);
 const l=lease(workspace,'create');const partial=output+'.partial-'+l.record.id;let ownsPartial=false;
 try{
  await checkpoint(options,'before-snapshot');const snapshot=await createBackup(database,join(l.job,'plain'),{mediaDir,mediaQuiesced});const manifest=await verifyBackup(snapshot);await checkpoint(options,'snapshot-created');
  const e=new Encrypter();e.setScryptWorkFactor(WORK_FACTOR);e.setPassphrase(passphrase);const packed=packSnapshot(snapshot,manifest);
  const encrypted=await e.encrypt(packed.stream); // KDF completes before writer starts consuming tar payload.
  try{await writeCipher(encrypted,partial,options,()=>{ownsPartial=true});await packed.done;}catch(e){await encrypted.cancel().catch(()=>{});throw e;}
  await checkpoint(options,'cipher-written');await extractVerified(partial,passphrase,l.job,options);await checkpoint(options,'before-publish');
  // Same-volume hard link atomically refuses existing final names; rename() could overwrite a file.
  linkSync(partial,output);unlinkSync(partial);ownsPartial=false;const sha256=await hash(output);return{encrypted:true,format:'tar+age-v1',sha256,bytes:statSync(output).size};
 }finally{
  if(ownsPartial&&present(partial))unlinkSync(partial);
  finish(l);
 }
}
export async function verifyEncryptedBackup({input,workspace,passphrase,...options}){
 password(passphrase);input=canonical(input);capacity(directory(workspace),3*statSync(input).size+32*MiB,options);const l=lease(workspace,'verify');
 try{await checkpoint(options,'before-decrypt');const {manifest}=await extractVerified(input,passphrase,l.job,options);return{verified:true,schemaVersion:manifest.schemaVersion,files:manifest.files.length};}finally{finish(l);}
}
export async function restoreEncryptedBackup({input,target,workspace,passphrase,...options}){
 password(passphrase);input=canonical(input);target=resolve(target);const parent=directory(dirname(target));if(present(target))fail('RESTORE_TARGET_EXISTS');
 if(inside(resolve(workspace),target)||inside(target,resolve(workspace)))fail('RESTORE_SCOPE');capacity(directory(workspace),3*statSync(input).size+32*MiB,options);capacity(parent,2*statSync(input).size+32*MiB,options);
 const l=lease(workspace,'restore',target);let success=false,created=false;
 try{
  const {snapshot}=await extractVerified(input,passphrase,l.job,options);await checkpoint(options,'authenticated');await restoreBackup(snapshot,join(l.job,'restored'));await checkpoint(options,'before-restore-publish');
  mkdirSync(target,{mode:0o700});created=true;durable(join(target,'.encrypted-restore-owner.json'),JSON.stringify({id:l.record.id}),'wx');
  const restored=join(l.job,'restored');const info=readFileSync(join(restored,'restore-info.json'));durable(join(target,'restore-info.json'),info,'wx');
  for(const item of files(restored)){if(item.name==='restore-info.json')continue;await checkpoint(options,'restore-file');const to=join(target,item.name);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(item.path,to,constants.COPYFILE_EXCL);const durableFile=openSync(to,'r+');try{fsyncSync(durableFile);}finally{closeSync(durableFile);}if(await hash(item.path)!==await hash(to))fail('RESTORED_HASH_MISMATCH');}
  durable(join(target,'recovery-complete.json'),JSON.stringify({format:1,id:l.record.id,sourceSha256:await hash(input),quarantined:true}),'wx');l.update('restore-complete');unlinkSync(join(target,'.encrypted-restore-owner.json'));success=true;return{restored:true,quarantined:true};
 }finally{
  // If another process won mkdir, preserve its target; never delete a directory we did not create.
  if(!created)l.record.target=null;
  if(!created)durable(l.pending,JSON.stringify(l.record));
  finish(l,success);
 }
}
