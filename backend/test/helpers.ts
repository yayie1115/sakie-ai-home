import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { repositoryRoot } from '../src/config/env.js';
import { createOwnerCredential } from '../src/modules/auth/credentials.js';
import { AuthService } from '../src/modules/auth/service.js';
export const testPassword='phase1-test-password-only';
export const testCredential=await createOwnerCredential(testPassword);
export const testRoot=process.env.TEST_DATA_ROOT??join(dirname(repositoryRoot),'sakie-ai-home-data','tests');
export function temporaryDirectory(){mkdirSync(testRoot,{recursive:true});return mkdtempSync(join(testRoot,'case-'));}
export function createTestApp(db:DatabaseSync){return createApp(db,{auth:new AuthService(db,{loadCredential:()=>testCredential,publicOrigin:'http://127.0.0.1:5173',secureCookies:false})});}
export async function authenticatedFetch(base:()=>string):Promise<typeof fetch>{
  const response=await fetch(base()+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:testPassword})});
  assert.equal(response.status,200);const body=await response.json();const cookie=response.headers.get('set-cookie')!.split(';')[0];
  return (input,init={})=>{const headers=new Headers(init.headers);headers.set('Cookie',cookie);headers.set('X-CSRF-Token',body.csrfToken);return fetch(input,{...init,headers});};
}
