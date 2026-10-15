import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database/index.js';
import { AuthService, type AuthOptions } from '../src/modules/auth/service.js';
import { createOwnerCredential } from '../src/modules/auth/credentials.js';
import { testCredential, testPassword, temporaryDirectory } from './helpers.js';
async function serve(options:Partial<AuthOptions>={}){
 const db=openDatabase(':memory:');const auth=new AuthService(db,{loadCredential:()=>testCredential,publicOrigin:'http://127.0.0.1:5173',secureCookies:false,...options});const server=createApp(db,{auth}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 return{db,base:'http://127.0.0.1:'+address.port,async close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();}};
}
async function login(base:string,password=testPassword,origin?:string){return fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({password})});}
test('every existing business endpoint rejects anonymous and device-style bearer requests; health remains public',async()=>{
 const app=await serve();try{
  for(const resource of ['memories','diaries','dreams','activities'])for(const[method,suffix]of [['GET',''],['GET','/id'],['POST',''],['DELETE','/id']])assert.equal((await fetch(app.base+'/api/'+resource+suffix,{method})).status,401);
  assert.equal((await fetch(app.base+'/api/memories',{headers:{Authorization:'Bearer unrelated-device-credential'}})).status,401);
  assert.equal((await fetch(app.base+'/api/health')).status,200);
 }finally{await app.close();}
});
test('owner session uses a secure HttpOnly cookie, hashes its token at rest, and requires CSRF plus trusted origin',async()=>{
 const app=await serve({secureCookies:true,publicOrigin:'https://sakiehome.icu'});try{
  const result=await login(app.base);assert.equal(result.status,200);const header=result.headers.get('set-cookie')!;assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.match(header,/Secure/);
  const body=await result.json();assert.equal('token'in body,false);assert.equal('password'in body,false);const cookie=header.split(';')[0];const rawToken=cookie.slice('sakie_session='.length);const stored=app.db.prepare('SELECT token_hash FROM auth_sessions').get()?.token_hash;assert.notEqual(stored,rawToken);assert.equal(String(stored).length,64);
  const session=await fetch(app.base+'/api/auth/session',{headers:{Cookie:cookie}});assert.equal(session.status,200);assert.equal(session.headers.get('cache-control'),'no-store');
  const uri=app.base+'/api/diaries';const payload=JSON.stringify({date:'2026-10-15',content:'authenticated record'});
  assert.equal((await fetch(uri,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:payload})).status,403);
  assert.equal((await fetch(uri,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':body.csrfToken,Origin:'https://evil.invalid'},body:payload})).status,403);
  const created=await fetch(uri,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':body.csrfToken,Origin:'https://sakiehome.icu'},body:payload});assert.equal(created.status,201);const record=await created.json();
  assert.equal((await fetch(uri+'/'+record.id,{method:'DELETE',headers:{Cookie:cookie,'X-CSRF-Token':body.csrfToken}})).status,204);
  assert.equal(app.db.prepare('SELECT content FROM diaries WHERE id=?').get(record.id)?.content,'authenticated record');assert.ok(app.db.prepare('SELECT deleted_at FROM record_metadata WHERE record_id=?').get(record.id)?.deleted_at);
  assert.equal((await fetch(app.base+'/api/auth/logout',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':body.csrfToken}})).status,204);
  assert.equal((await fetch(uri,{headers:{Cookie:cookie}})).status,401);
 }finally{await app.close();}
});
test('bad login is rate limited and a foreign-origin login is rejected',async()=>{
 const app=await serve();try{
  assert.equal((await login(app.base,testPassword,'https://evil.invalid')).status,403);
  for(let i=0;i<5;i++)assert.equal((await login(app.base,'incorrect-password')).status,401);
  assert.equal((await login(app.base)).status,429);
 }finally{await app.close();}
});
test('owner rotation invalidates existing sessions, and expired or malformed cookies do not authenticate',async()=>{
 let credential=testCredential;const app=await serve({loadCredential:()=>credential});try{
  const response=await login(app.base);const cookie=response.headers.get('set-cookie')!.split(';')[0];
  credential=await createOwnerCredential('new-test-password-only');assert.equal((await fetch(app.base+'/api/memories',{headers:{Cookie:cookie}})).status,401);
  const next=await login(app.base,'new-test-password-only');const nextCookie=next.headers.get('set-cookie')!.split(';')[0];app.db.exec('UPDATE auth_sessions SET expires_at=0');
  assert.equal((await fetch(app.base+'/api/memories',{headers:{Cookie:nextCookie}})).status,401);
  assert.equal((await fetch(app.base+'/api/memories',{headers:{Cookie:'sakie_session=malformed'}})).status,401);
 }finally{await app.close();}
});
test('unconfigured identity fails closed without preventing API startup',async()=>{
 const app=await serve({loadCredential:()=>undefined});try{assert.equal((await fetch(app.base+'/api/health')).status,200);assert.equal((await login(app.base)).status,503);assert.equal((await fetch(app.base+'/api/memories')).status,401);}finally{await app.close();}
});
test('owner setup CLI writes only a salted verifier and refuses accidental replacement',()=>{
 const dir=temporaryDirectory();try{
  const credentialFile=join(dir,'owner.json');const args=['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'auth-setup'];const env={...process.env,NODE_ENV:'test',DATA_DIR:dir,BACKUP_DIR:join(dir,'backups'),OWNER_CREDENTIAL_FILE:credentialFile,DATABASE_PATH:join(dir,'sakie.db')};
  const first=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:15000});assert.equal(first.status,0);const generated=first.stdout.trim().split(/\r?\n/).at(-1)!;assert.ok(generated.length>=32);const content=readFileSync(credentialFile,'utf8');assert.equal(content.includes(generated),false);assert.equal(JSON.parse(content).format,1);
  const second=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:15000});assert.equal(second.status,1);assert.equal(readFileSync(credentialFile,'utf8'),content);
 }finally{rmSync(dir,{recursive:true});}
});
