import {createHash} from 'node:crypto';
import {existsSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
export type SyncEnvironment='test'|'production';
export interface NetworkPolicy {version:1;environment:SyncEnvironment;allowedOrigins:readonly string[];}
export interface ApprovalBinding {database:string;credentials:string;}
export interface ProductionApproval {version:1;environment:'production';origin:string;policyHash:string;binding:ApprovalBinding;confirmedAt:string;confirmation:string;}
export interface RuntimeNetworkPolicy extends NetworkPolicy {approval?:ProductionApproval;binding?:ApprovalBinding;}
export class NetworkPolicyError extends Error {constructor(readonly code:string){super(code);}}
function stop(code:string):never{throw new NetworkPolicyError(code);}
export const defaultTestPolicy:NetworkPolicy=Object.freeze({version:1,environment:'test',allowedOrigins:Object.freeze(['http://127.0.0.1:3000','http://127.0.0.1:3100'])});
export function cloudUrl(value:string):string {
 if(typeof value!=='string'||value.trim()!==value)stop('SYNC_ORIGIN_INVALID');
 let url:URL;try{url=new URL(value);}catch{stop('SYNC_ORIGIN_INVALID');}
 if(url!.username||url!.password||url!.search||url!.hash||url!.pathname!=='/'||!['http:','https:'].includes(url!.protocol))stop('SYNC_ORIGIN_INVALID');
 // Reject alternate spellings, integer/short IPs, default-port aliases and backslash parsing.
 if(url!.hostname.includes('*')||url!.hostname.endsWith('.')||(url!.protocol==='http:'&&!['127.0.0.1','[::1]'].includes(url!.hostname)))stop('SYNC_ORIGIN_INVALID');
 if(value!==url!.origin&&value!==url!.origin+'/')stop('SYNC_ORIGIN_NOT_CANONICAL');
 return url!.origin;
}
function loopback(origin:string){const url=new URL(origin);return ['127.0.0.1','[::1]'].includes(url.hostname);}
export function parseNetworkPolicy(value:unknown):NetworkPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))stop('SYNC_POLICY_INVALID');
 const p=value as Partial<NetworkPolicy>;
 if(p.version!==1||!['test','production'].includes(p.environment??'')||!Array.isArray(p.allowedOrigins)||p.allowedOrigins.length<1||p.allowedOrigins.length>8)stop('SYNC_POLICY_INVALID');
 const origins=p.allowedOrigins!.map(cloudUrl);
 if(new Set(origins).size!==origins.length)stop('SYNC_POLICY_DUPLICATE_ORIGIN');
 if(p.environment==='test'&&origins.some(o=>!loopback(o)))stop('SYNC_TEST_REQUIRES_LITERAL_LOOPBACK');
 if(p.environment==='production'&&origins.some(o=>new URL(o).protocol!=='https:'||loopback(o)))stop('SYNC_PRODUCTION_REQUIRES_REMOTE_HTTPS');
 return{version:1,environment:p.environment!,allowedOrigins:origins};
}
export function policyHash(policy:NetworkPolicy){const p=parseNetworkPolicy(policy);return createHash('sha256').update(JSON.stringify({version:1,environment:p.environment,allowedOrigins:[...p.allowedOrigins].sort()})).digest('hex');}
export function canonicalLocalPath(value:string):string {
 if(typeof value!=='string'||!value)stop('SYNC_BINDING_INVALID');
 let current=resolve(value);const tail:string[]=[];
 while(!existsSync(current)){const parent=dirname(current);if(parent===current)stop('SYNC_BINDING_INVALID');tail.unshift(current.slice(parent.length).replace(/^[\\/]+/,''));current=parent;}
 const result=join(realpathSync(current),...tail);return process.platform==='win32'?result.toLowerCase():result;
}
function binding(value:ApprovalBinding):ApprovalBinding{return{database:canonicalLocalPath(value.database),credentials:canonicalLocalPath(value.credentials)};}
export function productionPhrase(origin:string){return 'ALLOW PRODUCTION SYNC '+cloudUrl(origin);}
export function createProductionApproval(policy:NetworkPolicy,origin:string,scope:ApprovalBinding,confirmation:string):ProductionApproval {
 const p=parseNetworkPolicy(policy),target=cloudUrl(origin);
 if(p.environment!=='production'||!p.allowedOrigins.includes(target))stop('SYNC_TARGET_NOT_ALLOWLISTED');
 if(confirmation!==productionPhrase(target))stop('SYNC_PRODUCTION_CONFIRMATION_MISMATCH');
 return{version:1,environment:'production',origin:target,policyHash:policyHash(p),binding:binding(scope),confirmedAt:new Date().toISOString(),confirmation};
}
export function authorizeOrigin(origin:string,policy:RuntimeNetworkPolicy=defaultTestPolicy):string {
 const p=parseNetworkPolicy(policy),target=cloudUrl(origin);
 if(!p.allowedOrigins.includes(target))stop('SYNC_TARGET_NOT_ALLOWLISTED');
 if(p.environment==='production'){
  const a=policy.approval;if(!a||!policy.binding)stop('SYNC_PRODUCTION_APPROVAL_REQUIRED');
  if(a.version!==1||a.environment!=='production'||a.origin!==target||a.policyHash!==policyHash(p)||a.confirmation!==productionPhrase(target)||!Number.isFinite(Date.parse(a.confirmedAt)))stop('SYNC_PRODUCTION_APPROVAL_MISMATCH');
  const expected=binding(policy.binding);if(!a.binding||a.binding.database!==expected.database||a.binding.credentials!==expected.credentials)stop('SYNC_PRODUCTION_BINDING_MISMATCH');
 }
 return target;
}
