import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
export interface OwnerCredential { format: 1; id: string; salt: string; passwordHash: string; }
const derive=promisify(scrypt);
export async function createOwnerCredential(password: string): Promise<OwnerCredential> {
  if(password.length<14||password.length>256)throw new Error('Password length must be 14–256');
  const salt=randomBytes(16).toString('hex');const hash=await derive(password,salt,64) as Buffer;
  return {format:1,id:randomUUID(),salt,passwordHash:hash.toString('hex')};
}
export async function passwordDigest(password: string, credential: OwnerCredential): Promise<Buffer> {return await derive(password,credential.salt,64) as Buffer;}
export function loadOwnerCredential(filename: string): OwnerCredential | undefined {
  if(!existsSync(filename))return undefined;
  if(statSync(filename).size>4096)throw new Error('Invalid owner credential file');
  const c: unknown=JSON.parse(readFileSync(filename,'utf8'));
  if(!c||typeof c!=='object')throw new Error('Invalid owner credential');
  const value=c as OwnerCredential;
  if(value.format!==1||typeof value.id!=='string'||!/^[a-f0-9]{32}$/.test(value.salt)||!/^[a-f0-9]{128}$/.test(value.passwordHash))throw new Error('Invalid owner credential');
  return value;
}
